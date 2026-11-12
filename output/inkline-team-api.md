# Inkline 团队服务端接口方案

> 状态：设计稿　|　适用版本：桌面端 0.1.20+　|　接口前缀：`/v1`
> 实现进度：M1 服务端骨架已落地，见 `apps/team-server/`（Rust + axum + PostgreSQL）；客户端接入与 M2 尚未开始。

## 1. 目标与边界

### 目标

- 让多个成员在不同机器上共享同一份集合、请求与文档草稿。
- 复用客户端现有的「本地快照 + 三方合并」模型，客户端改动最小。
- 适配内网私有部署：可离线、可自托管、TLS、审计留痕。
- 为后续细粒度协作（单请求协作、评论、在线状态）预留扩展点。

### 非目标（本期不做）

- 实时协同编辑（OT / CRDT）。
- 公网多租户 SaaS、计费。
- 把 AI 网关、Mock 服务托管到团队服务。
- 环境变量中的密钥跨机同步（默认不同步）。
- 企业 SSO / OIDC（本期不接入，仅预留扩展点）。

## 2. 现状与约束

客户端当前同步模型（`apps/desktop/src/lib/team.ts`）：

- `push`：把全部请求与文档草稿打包成 `TeamSnapshot`，覆盖写入本机快照，`revision + 1`。
- `pull`：读取本机快照并作为 base，供三方合并使用。
- 合并：客户端已有 base / local / remote 三方合并与字段级冲突解决。
- 没有服务端，没有身份校验，快照只在一台机器上。

因此服务端第一阶段采用**整包快照同步 + 乐观锁**，而不是细粒度 CRUD：

- 优点：与现有客户端一致，冲突完全复用现有三方合并；离线可用。
- 代价：每次上传整包。通过 gzip、大小限制与后续增量优化控制成本。

## 3. 总体架构

```
┌────────────┐    HTTPS/JSON    ┌──────────────┐      ┌────────────┐
│ Inkline 桌面 │ ───────────────▶ │ 团队 API 服务  │ ───▶ │ PostgreSQL │
│  (Tauri)    │ ◀─────────────── │  (v1)        │      └────────────┘
└────────────┘                  │              │      ┌────────────┐
      │                         │              │ ───▶ │ 对象存储(可选) │
      │ 本机 SQLite / 快照        └──────────────┘      └────────────┘
      ▼
  本地工作区
```

- 桌面端仍以本地 SQLite 为主，团队服务只负责同步与身份。
- 服务端建议：Node 22 + Fastify + PostgreSQL 16；若希望与桌面端同栈，可用 Rust + axum + sqlx，接口不变。
- 快照较小时直接存 `bytea/jsonb`；超过阈值（如 2 MB）转存对象存储，接口返回下载地址。

### 3.1 服务端技术栈：Node 还是 Rust

| 维度 | Node 22 + Fastify | Rust + axum |
| --- | --- | --- |
| 开发效率 | 高，HTTP / JSON / 鉴权 / 测试生态成熟 | 中，强类型与编译期保障好，但样板代码更多 |
| 性能与内存 | 本场景足够（I/O 密集）；内存约 100–300 MB | 更高吞吐、更低内存；瓶颈通常在数据库而非语言 |
| 与桌面端关系 | 无法复用 Rust 代码，但可与前端共享 TypeScript 类型 | 与 Tauri 后端同语言，便于统一模型与错误处理 |
| 部署 | 需要 Node 运行时或打包产物，镜像较大 | 单个静态二进制，镜像小，内网离线部署更省事 |
| 数据库生态 | Prisma / node-pg-migrate，迁移方便 | sqlx / sea-orm，编译期 SQL 校验 |
| 维护门槛 | 前端或全栈同学可直接接手 | 需要 Rust 经验，人员要求更高 |
| 安全 | 内存安全依赖运行时与依赖审计 | 内存安全、依赖相对少 |

结论：

- 团队服务是典型的 JSON CRUD + 大对象传输，**性能不是选型瓶颈**。
- 如果 M1 要尽快上线、维护人手以 TS/Node 为主，选 **Node 22 + Fastify**。
- 如果希望桌面端与服务端同栈、单二进制部署、长期由 Rust 同学维护，选 **Rust + axum**。
- 两种方案共用同一套 HTTP 接口与数据库表结构，后续互换成本主要在实现，不在协议。

## 4. 身份与权限

### 身份

- 账号：`account`（工号 / 内网邮箱），密码使用 Argon2id 哈希。
- 访问令牌：JWT，15 分钟有效；刷新令牌 30 天，旋转式刷新。
- 企业 SSO 本期不接入；后续可按 `POST /v1/auth/oidc/exchange` 扩展，复用同一套令牌模型，不影响现有接口。
- 桌面端令牌必须存操作系统凭据库（Tauri keyring），**不得写入 localStorage**。

### 角色

| 角色 | 查看 | push / pull | 邀请成员 | 管理成员 | 团队设置 | 审计 |
| --- | --- | --- | --- | --- | --- | --- |
| `owner` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `admin` | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `member` | 受资源权限约束 | ✓ |  |  |  |  |
| `viewer`（预留） | 受资源权限约束 | pull |  |  |  |  |

一个团队至少保留一名 `owner`。

资源级权限叠加在角色之上：

- 所有者与管理员始终可见全部资源，并可配置权限。
- 成员与只读角色只看到「团队可见」或被明确授权的集合 / 接口。
- 集合级授权默认作用于其下接口；接口策略优先于集合策略。
- 只读角色永远不能获得编辑权限。

## 5. 数据模型

```sql
users (
  id uuid primary key,
  account citext unique not null,
  display_name text not null,
  password_hash text not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

teams (
  id uuid primary key,
  name text not null,
  current_revision bigint not null default 0,
  max_data_level text not null default 'L1' check (max_data_level in ('L0','L1','L2','L3')),
  snapshot_retention_days int not null default 90,
  audit_retention_days int not null default 90,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

memberships (
  team_id uuid references teams(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

invites (
  code text primary key,
  team_id uuid references teams(id) on delete cascade,
  role text not null,
  created_by uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid
);

snapshots (
  team_id uuid references teams(id) on delete cascade,
  revision bigint not null,
  payload jsonb,               -- 小快照；大快照存对象存储时为 null
  object_key text,             -- 对象存储 key
  payload_hash text not null,  -- SHA-256(服务端合并后的完整 payload)
  source_hash text,            -- SHA-256(客户端原始提交 payload)，用于幂等判断
  size_bytes bigint not null,
  schema_version int not null,
  base_revision bigint,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  idempotency_key text,
  primary key (team_id, revision),
  unique (team_id, idempotency_key)
);

resource_policies (
  team_id uuid references teams(id) on delete cascade,
  resource_type text not null check (resource_type in ('collection','request')),
  resource_id text not null,
  visibility text not null check (visibility in ('team','restricted')),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (team_id, resource_type, resource_id)
);

resource_grants (
  team_id uuid not null,
  resource_type text not null,
  resource_id text not null,
  subject_type text not null check (subject_type in ('user','role')),
  subject_id text not null,    -- user_id 或 member / viewer
  permission text not null check (permission in ('view','edit')),
  primary key (team_id, resource_type, resource_id, subject_type, subject_id),
  foreign key (team_id, resource_type, resource_id)
    references resource_policies(team_id, resource_type, resource_id) on delete cascade
);

audit_logs (
  id bigserial primary key,
  team_id uuid,
  actor_id uuid,
  type text not null,          -- sync / member / auth / team
  action text not null,
  detail jsonb not null default '{}',
  request_id text,
  at timestamptz not null default now()
);

refresh_tokens (
  id uuid primary key,
  user_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

### 快照 Payload（schemaVersion 2）

```json
{
  "schemaVersion": 2,
  "collections": [{ "id": "col-1", "name": "订单服务", "sort": 0, "updatedAt": "..." }],
  "requests": [
    {
      "id": "req-1",
      "name": "创建订单",
      "method": "POST",
      "url": "{{host}}/api/orders",
      "headers": [{ "name": "Content-Type", "value": "application/json" }],
      "body": "{\"sku\":\"A100\"}",
      "dataLevel": "L1",
      "collectionId": "col-1",
      "sort": 0,
      "updatedAt": "..."
    }
  ],
  "documents": { "req-1": [{ "key": "请求:amount", "path": "amount", "type": "integer", "source": "请求", "description": "订单金额，单位分", "updatedAt": "..." }] }
}
```

说明：

- 服务端忽略客户端传来的 `revision`、`workspace`，以服务端团队与版本号为准。
- 现有客户端快照未包含 collections，schemaVersion 2 必须补上，否则跨机拉取后请求会失去所属集合。
- 环境变量默认不同步；若后续需要，只同步变量名与非敏感值，token 等一律不同步。
- 删除通过整包差异自然表达，服务端不做合并。

## 6. 接口规范

### 6.1 通用约定

- Base URL：`https://<team-host>/v1`
- 内容类型：`application/json; charset=utf-8`；快照支持 `Content-Encoding: gzip`
- 认证：`Authorization: Bearer <accessToken>`
- 客户端标识：`X-Inkline-Client: desktop/0.1.20`
- 请求追踪：`X-Request-Id`（服务端回填，便于排障）
- 时间：ISO 8601 UTC
- 错误统一格式：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "远端已有更新版本",
    "details": { "latestRevision": 12, "latestHash": "sha256:..." }
  },
  "requestId": "req_01H..."
}
```

通用错误码：

| code | HTTP | 说明 |
| --- | --- | --- |
| `unauthorized` | 401 | 缺少或过期令牌 |
| `forbidden` | 403 | 无团队权限 |
| `not_found` | 404 | 资源不存在 |
| `validation_failed` | 422 | 字段校验失败 |
| `data_level_forbidden` | 422 | 快照包含团队策略禁止的数据分级 |
| `payload_too_large` | 413 | 超过大小限制 |
| `rate_limited` | 429 | 频率限制 |
| `revision_conflict` | 409 | 版本冲突，需要先拉取合并 |
| `internal_error` | 500 | 服务端错误 |

### 6.2 认证

#### POST /v1/auth/login

```json
{ "account": "zhangsan", "password": "••••••" }
```

`200`：

```json
{
  "accessToken": "eyJ...",
  "expiresIn": 900,
  "refreshToken": "rt_...",
  "user": { "id": "u1", "account": "zhangsan", "displayName": "张三" }
}
```

#### POST /v1/auth/refresh

```json
{ "refreshToken": "rt_..." }
```

`200` 返回新的 accessToken + 旋转后的 refreshToken。

#### POST /v1/auth/logout

携带 refreshToken，服务端撤销该刷新令牌，`204`。

#### GET /v1/me

返回当前用户与所属团队列表（含角色）。

### 6.3 团队与成员

#### GET /v1/teams

`200`：

```json
{
  "teams": [
    { "id": "t1", "name": "支付中台", "role": "owner", "revision": 12, "memberCount": 5 }
  ]
}
```

#### POST /v1/teams

```json
{ "name": "支付中台" }
```

创建者自动成为 `owner`；`201` 返回团队与 `inviteCode`（可单独再生成）。

#### GET /v1/teams/{teamId}

返回团队基本信息、当前 revision、角色、成员数、数据分级上限与快照 / 审计保留策略。

#### PATCH /v1/teams/{teamId}

```json
{
  "name": "订单中台",
  "maxDataLevel": "L1",
  "snapshotRetentionDays": 90,
  "auditRetentionDays": 90
}
```

仅 `owner`。`maxDataLevel` 默认 `L1`，`L3` 不允许设置；保留天数建议限制在 7–3650 天。

#### GET /v1/teams/{teamId}/members

```json
{
  "members": [
    { "userId": "u1", "account": "zhangsan", "displayName": "张三", "role": "owner", "joinedAt": "..." }
  ]
}
```

#### POST /v1/teams/{teamId}/members

```json
{
  "mode": "create",
  "account": "lisi",
  "displayName": "李四",
  "password": "Passw0rd!2026",
  "role": "member"
}
```

- `mode = create`：账号不存在时创建服务账号并加入团队；需要 10–128 位初始口令。
- `mode = existing`：按账号添加已有用户，沿用原口令。
- 仅 `owner` / `admin`；`admin` 不能授予 `admin`，`owner` 角色不能通过成员接口授予。

#### PATCH /v1/teams/{teamId}/members/{userId}

```json
{ "role": "admin" }
```

- `owner` 可调整管理员及以下角色；`admin` 只能调整成员 / 只读。
- 不能修改所有者角色。

#### DELETE /v1/teams/{teamId}/members/{userId}

删除成员；不能移除最后一名 `owner`，不能移除自己。移除成员会同时清理其在本团队的资源授权。

#### POST /v1/teams/{teamId}/members/{userId}/reset-password

```json
{ "newPassword": "NewPassw0rd!2026" }
```

重置口令并撤销该账号全部刷新令牌；`admin` 只能重置成员 / 只读账号。

#### GET /v1/teams/{teamId}/access

返回当前成员对可见资源的操作能力，供桌面客户端展示只读状态与同步按钮：

```json
{
  "role": "member",
  "canPush": true,
  "canManageMembers": false,
  "canManagePermissions": false,
  "collections": { "col-1": "edit", "col-2": "view" },
  "requests": { "req-1": "edit", "req-2": "view" }
}
```

- 只包含当前成员可见的资源；`view` 表示可查看但修改不会同步，`edit` 表示可编辑。
- 所有者与管理员对所有资源返回 `edit`。
- `viewer` 角色 `canPush = false`。

#### GET /v1/teams/{teamId}/permissions

返回资源树与权限配置（仅 `owner` / `admin`）：

```json
{
  "revision": 3,
  "collections": [
    { "id": "col-1", "name": "订单服务", "requestCount": 2, "visibility": "team", "grants": [] }
  ],
  "requests": [
    {
      "id": "req-1",
      "name": "创建订单",
      "method": "POST",
      "collectionId": "col-1",
      "dataLevel": "L1",
      "hasDocument": true,
      "visibility": "inherit",
      "grants": []
    }
  ]
}
```

- `visibility`：集合为 `team` / `restricted`；接口额外支持 `inherit`（跟随集合）。
- `grants`：`[{ "subjectType": "user|role", "subjectId": "...", "permission": "view|edit" }]`。

#### PUT /v1/teams/{teamId}/permissions/{type}/{resourceId}

`type` 为 `collection` / `request`：

```json
{
  "visibility": "restricted",
  "grants": [
    { "subjectType": "user", "subjectId": "u2", "permission": "view" },
    { "subjectType": "role", "subjectId": "member", "permission": "edit" }
  ]
}
```

- 资源必须存在于最新快照；否则返回 `404`。
- 角色授权只支持 `member` / `viewer`，只读角色不能获得 `edit`。
- `visibility = team` 时会清空 grants。

#### DELETE /v1/teams/{teamId}/permissions/{type}/{resourceId}

删除策略：集合恢复团队可见，接口恢复继承集合。`204`。

#### POST /v1/teams/{teamId}/permissions/batch

```json
{
  "items": [
    { "resourceType": "collection", "resourceId": "col-1", "visibility": "restricted", "grants": [] },
    { "resourceType": "request", "resourceId": "req-1", "visibility": "restricted", "grants": [] }
  ]
}
```

单次最多 200 项；用于「把集合权限应用到其下全部接口」。

#### POST /v1/teams/{teamId}/invites

```json
{ "role": "member", "expiresInHours": 72 }
```

`201`：

```json
{ "code": "INK-7F3K-92QD", "expiresAt": "2026-11-14T08:00:00Z" }
```

#### POST /v1/team-invites/{code}/accept

当前用户加入团队，`200` 返回团队与角色。

### 6.4 快照同步（核心）

#### GET /v1/teams/{teamId}/snapshots/latest

`200`（有快照）：

```json
{
  "revision": 12,
  "hash": "sha256:9f2c...",
  "sizeBytes": 184320,
  "schemaVersion": 2,
  "createdBy": { "userId": "u1", "displayName": "张三" },
  "createdAt": "2026-11-11T08:00:00Z",
  "downloadUrl": "/v1/teams/t1/snapshots/12"
}
```

`204`：团队尚无快照。

参数：

- `inline=1`：小快照（≤ 512 KB）直接内联返回 `payload`，省一次请求。
- 客户端拉取后应把 `revision` 作为本地 `baseRevision` 保存。

#### GET /v1/teams/{teamId}/snapshots/{revision}

返回快照 Payload（`application/json`，可 gzip）。

按查看者权限裁剪：

- `owner` / `admin`：返回完整快照。
- `member` / `viewer`：只返回可见集合、可见接口及其文档；被隐藏的资源不会出现在任何字段中。
- 历史版本同样按当前权限策略裁剪，避免通过旧版本绕过限制。

#### POST /v1/teams/{teamId}/snapshots

提交新快照。请求头：

| Header | 必填 | 说明 |
| --- | --- | --- |
| `Idempotency-Key` | 是 | 客户端生成的 UUID；同一 key + 相同 hash 重试直接返回上次结果 |
| `Content-Encoding` | 否 | `gzip` |
| `X-Inkline-Base-Revision` | 是 | 本地最后一次同步的 revision；首次为 `0` |

请求体：

```json
{
  "schemaVersion": 2,
  "baseRevision": 12,
  "collections": [],
  "requests": [],
  "documents": {}
}
```

`201`：

```json
{ "revision": 13, "hash": "sha256:...", "createdAt": "..." }
```

`409`（版本冲突）：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "远端已有更新版本",
    "details": { "latestRevision": 14, "latestHash": "sha256:..." }
  }
}
```

按权限合并：

- 服务端保存完整权威快照；客户端提交的是其可见子集。
- 推送时只应用查看者有编辑权的集合、接口与文档；不可见或只读的资源保留服务端版本，不会被整包覆盖删除。
- 删除集合时，只要集合内存在查看者无权编辑的接口，删除会被忽略，避免误删隐藏资源。
- `payload_hash` 为合并后完整快照的 hash；`source_hash` 记录客户端原始内容，用于幂等重试判断。

#### GET /v1/teams/{teamId}/snapshots?limit=20&before=13

历史版本列表，用于回滚与排障（`member` 以上可读，`viewer` 仅最新）。

#### 同步流程

```mermaid
sequenceDiagram
  participant C as 客户端
  participant S as 团队服务
  C->>S: GET /snapshots/latest
  S-->>C: revision=12, hash
  Note over C: 本地作为 base
  C->>C: 本地修改 / 本地快照
  C->>S: POST /snapshots (baseRevision=12, gzip)
  alt 服务端仍为 12
    S-->>C: 201 revision=13
  else 服务端已到 14
    S-->>C: 409 latestRevision=14
    C->>S: GET /snapshots/14
    S-->>C: remote payload
    C->>C: 三方合并 base/local/remote
    C->>S: POST /snapshots (baseRevision=14)
    S-->>C: 201 revision=15
  end
```

#### 版本分配

- 在事务内对 `teams.current_revision` 执行 `UPDATE ... RETURNING`，保证同一团队严格递增。
- `baseRevision` 必须等于当前 `current_revision`，否则返回 `409`。
- 只接受单调递增，不接受客户端指定 revision。

#### 桌面客户端行为

- 首次接入已有团队时先拉取，再以拉取到的 revision 作为 `baseRevision` 推送。
- 收到 `409 revision_conflict` 时拉取最新远端快照，并使用本地基准做三方合并，合并完成后重新推送。
- 拉取采用增量写入：更新服务端返回的集合、接口与文档，不删除本机额外请求，避免首次接入丢失本地数据。
- 客户端用 `GET /v1/teams/{teamId}/access` 标记只读集合 / 接口：隐藏重命名、移动、删除等入口；`viewer` 禁用推送按钮。
- 只读资源的本地修改仅保存在本机，推送时服务端会忽略；被隐藏的资源不会下发到客户端。

### 6.5 审计

#### GET /v1/teams/{teamId}/audit?limit=50&cursor=...&type=sync

```json
{
  "entries": [
    {
      "id": "a1",
      "type": "sync",
      "action": "snapshot.push",
      "actor": { "userId": "u1", "displayName": "张三" },
      "detail": { "revision": 13, "baseRevision": 12, "sizeBytes": 184320 },
      "at": "2026-11-11T08:00:00Z"
    }
  ],
  "nextCursor": "..."
}
```

服务端至少记录：登录、令牌刷新、创建团队、邀请、成员变更、push、pull、删除成员、团队改名。
保留期建议 180 天，可按团队配置。

### 6.6 运维接口

- `GET /healthz`：进程存活。
- `GET /readyz`：数据库与对象存储就绪。
- `GET /v1/meta`：服务版本、最小客户端版本、快照大小限制、保留策略。

### 6.7 内置管理台

服务端内嵌单页管理台，浏览器访问 `http://<host>:8080/admin/`（根路径 `/` 自动跳转）。

- **定位**：运维与排障入口，不替代桌面客户端，也不新增管理特权接口。
- **权限**：直接使用 `/v1/auth/login` 登录，页面内所有操作都走既有 `/v1` 接口，复用团队成员角色校验。
- **能力**：团队列表与新建、概览统计、最新快照查看 / 下载、历史版本分页、成员增删与角色调整、口令重置、资源权限树与成员授权矩阵、审计日志、团队设置（名称 / 数据分级上限 / 保留天数）。
- **交付形态**：`admin/index.html` 通过 `include_str!` 编入二进制，无外部依赖，便于离线内网部署。
- **安全**：响应头带 CSP、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer`；令牌仅存 `sessionStorage`；口令错误与令牌失效统一回到登录页。

## 7. 安全与合规

- 全站 HTTPS（TLS 1.2+）；内网可选 mTLS。
- 密码 Argon2id；登录失败限速与锁定。
- Access Token 短时效，Refresh Token 旋转并支持撤销。
- 团队隔离：所有查询强制带 `team_id`，禁止跨团队 ID 访问。
- 数据分级：默认只允许 L0/L1 进入团队服务；L2 需 owner 显式开启，L3 禁止，详见 7.1。
- 服务端静态加密：数据库/对象存储启用加密；更高要求可加客户端端到端加密（团队密钥，服务端只见密文，列为后续阶段）。
- 大小限制：压缩后 10 MB / 解压后 50 MB；超限 413。
- 限流：每用户 10 req/s，每团队并发 push 1。
- 审计日志不可由普通成员删除；仅 `owner` 可导出。
- 禁止服务端拉取客户端提交的任意 URL，避免 SSRF。

### 7.1 数据分级与 L2/L3 风险

| 分级 | 中文含义 | 团队服务策略 |
| --- | --- | --- |
| `L0` | 公开：可对外公开，不含内部信息 | 允许同步 |
| `L1` | 内部：仅限团队内部使用 | 允许同步（默认上限） |
| `L2` | 敏感：仅限授权人员，泄露影响较大 | 需 owner 显式开启 |
| `L3` | 机密：核心敏感数据 | 禁止进入团队服务 |

默认策略：`maxDataLevel = L1`。L2 需要 `owner` 在团队设置中显式开启并二次确认；L3 永久禁止进入团队服务。

L2/L3 数据进入团队服务的主要风险：

| 风险 | 说明 |
| --- | --- |
| 数据集中 | 团队库成为 L2/L3 数据的集中存储点，一旦被入侵，影响面远大于单机 |
| 明文与备份 | 未启用端到端加密时，数据库、备份与对象存储对运维人员可见 |
| 权限扩散 | `owner` / `admin` 可读取整包快照；成员离职或降权后，历史快照仍然存在 |
| 合规 | 等保与数据分级制度通常要求 L2/L3 不出生产域，进入团队库可能直接违规 |
| 客户端误标 | `dataLevel` 由客户端声明，服务端无法验证真实性，存在误传或绕过 |
| 保留窗口 | 长期留存会扩大暴露时间，必须配合更短的保留期 |
| 审计泄露 | 审计详情如记录 URL 与字段名，也会暴露业务结构 |

建议：

- 默认只允许 L0/L1；确需 L2 时由 `owner` 开启，并同时启用静态加密、限制导出、缩短快照保留期（如 30 天）。
- 服务端在 push 时校验 `requests[].dataLevel`，超过团队策略返回 `422 data_level_forbidden` 并写入审计。
- 客户端 push 前按分级阻断并提示；L2 必须二次确认。
- 强合规场景选择端到端加密（M4），或只同步接口结构、不同步请求体与响应正文。

## 8. 错误与重试

- 客户端网络失败按指数退避重试（1s / 2s / 4s，最多 5 次），仅对 `5xx` 与网络错误重试。
- `409` 不重试，进入合并流程。
- `401` 先刷新令牌，再重放一次；失败则要求重新登录。
- `429` 读取 `Retry-After`。
- `Idempotency-Key` 保证重试不会产生重复 revision。

## 9. 部署与运维

- Docker Compose：`api` + `postgres` + `minio`（可选）+ `nginx`（TLS）。
- 数据库迁移使用版本化 SQL（如 `node-pg-migrate` / `sqlx migrate`）。
- 健康检查接入反向代理与监控。
- 备份：PostgreSQL 每日全量 + WAL 归档；对象存储版本化。
- 日志：结构化 JSON，含 `requestId`、`teamId`、`userId`、耗时；不记录密码、令牌与快照正文。
- 升级：接口保持 `/v1` 向后兼容；破坏性变更走 `/v2`。

### 9.1 数据保留与清理

- 默认快照与审计均保留 **90 天（3 个月）**。
- 全局默认可通过环境变量配置：`INKLINE_SNAPSHOT_RETENTION_DAYS`、`INKLINE_AUDIT_RETENTION_DAYS`。
- 团队 `owner` 可在团队设置中覆盖（建议限制 7–3650 天）；`GET /v1/teams/{id}` 返回实际生效值，客户端在团队设置中展示。
- 清理任务每天 03:00 执行，分批删除过期数据；每个团队始终保留最新一份快照，即使它已超过保留期，避免新成员无法拉取。
- 删除快照时同步删除对象存储文件；清理动作写入审计（`actor = system`）。
- 过期版本不可恢复；需要长期归档时由 `owner` 手动导出（M2）。
- `GET /v1/meta` 返回全局默认值，便于客户端展示与排障。

## 10. 客户端改造点

1. 团队设置增加「团队服务地址」与登录入口；令牌存 OS 凭据库。
2. 新增 `lib/teamService.ts`，替换 `team.ts` 的本机快照实现；本机模式继续走本地实现。
3. 快照 payload 升到 schemaVersion 2，补 `collections`。
4. push / pull 改为真实请求，保留现有三方合并弹窗与冲突展示。
5. push 前按团队 `maxDataLevel` 阻断：L2 需二次确认，L3 禁止。
6. 状态栏与侧栏展示连接状态、最后同步时间、当前 revision。
7. 离线队列：失败进入重试队列，恢复网络后自动推送。

## 11. 分阶段落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1 | 登录、团队创建、快照 push / pull / 冲突、审计、健康检查 | 两台机器同步同一团队，冲突可合并；未授权访问被拒 |
| M2 | 邀请码、成员与角色管理、团队改名、快照历史与回滚、保留策略配置与清理任务 | 成员权限矩阵通过；owner 唯一性；过期数据按时清理 |
| M3 | 增量同步（JSON Patch）、单请求级协作、评论、在线状态 | 大团队下同步体积与延迟可接受 |
| M4 | 端到端加密、审计导出（企业 SSO 暂不排期） | 安全评审通过 |

## 12. 测试与验收

- 契约测试：使用 OpenAPI 生成或校验请求/响应。
- 并发测试：两个客户端同时 push，必须一个 201、一个 409，不能丢数据。
- 幂等测试：同一 `Idempotency-Key` 重放只产生一个 revision。
- 权限测试：非成员、viewer、member、admin、owner 逐项验证。
- 令牌测试：过期、刷新旋转、撤销、重放。
- 边界测试：空团队、超大快照、非法 JSON、schemaVersion 不兼容。
- 故障测试：数据库短暂不可用、对象存储失败、网络中断重试。
- 数据分级测试：L2 超限返回 422 并记审计；L3 始终拒绝。
- 保留测试：过期快照 / 审计按配置清理，最新快照始终保留。
- 客户端 E2E：本机 → 团队 → 第二客户端拉取 → 修改 → 冲突合并 → 再推送。

## 13. 待确认

- 团队服务端技术栈：Node/Fastify 还是 Rust/axum（建议 Node 先落地 M1）。
- L2 是否允许进入团队服务（建议默认禁止，确需时由 owner 开启）；L3 一律禁止。
- 是否需要客户端端到端加密（服务端不可读）。
- 保留期默认 90 天已确定，团队可配置范围是否限制为 7–3650 天。
