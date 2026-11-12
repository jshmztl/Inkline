# Inkline 团队服务（M1）

Rust + axum + PostgreSQL 实现的团队同步服务，对应设计文档 `output/inkline-team-api.md` 的 M1 范围。

## M1 能力

- 账号登录、刷新令牌、登出、当前用户信息
- 团队创建、列表、详情、设置（名称 / 数据分级上限 / 保留天数）
- 成员管理：新建账号 / 添加已有账号、调整角色、移除成员、重置口令
- 资源级权限：集合与单接口的「团队可见 / 仅指定成员」，按成员或角色授权查看 / 编辑
- 快照最新版本、历史列表、指定版本、推送（乐观锁 + 幂等键 + gzip + 按权限裁剪与合并）
- 审计日志查询（owner / admin）
- 内置管理台（团队 / 成员 / 权限 / 快照历史 / 审计 / 设置）
- 健康检查与元信息

## 环境要求

- Rust stable
- PostgreSQL 16
- 或 Docker / Docker Compose

## 本地启动

1. 准备数据库：

```sql
CREATE DATABASE inkline_team;
```

2. 配置环境变量：

```bash
cp env.example .env
# 修改 DATABASE_URL、JWT_SECRET、BOOTSTRAP_*
```

`JWT_SECRET` 至少 32 个字符。启动时会自动执行数据库迁移；如果配置了 `BOOTSTRAP_ACCOUNT` / `BOOTSTRAP_PASSWORD` 且账号不存在，会创建首个账号。

3. 启动：

```bash
cargo run
```

默认监听 `0.0.0.0:8080`。

## Docker Compose

```bash
docker compose up -d --build
```

默认创建 `admin` / `change-me-please` 账号，请在生产环境通过环境变量覆盖。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 进程存活 |
| GET | `/readyz` | 数据库就绪 |
| GET | `/v1/meta` | 版本、大小限制、保留默认值 |
| POST | `/v1/auth/login` | 账号口令登录 |
| POST | `/v1/auth/refresh` | 旋转刷新令牌 |
| POST | `/v1/auth/logout` | 撤销刷新令牌 |
| GET | `/v1/me` | 当前用户与团队 |
| GET | `/v1/teams` | 我的团队 |
| POST | `/v1/teams` | 创建团队（创建者为 owner） |
| GET | `/v1/teams/{id}` | 团队详情 |
| PATCH | `/v1/teams/{id}` | 修改名称 / 数据分级上限 / 保留天数（owner） |
| GET | `/v1/teams/{id}/members` | 成员列表 |
| POST | `/v1/teams/{id}/members` | 新建账号或添加已有账号（owner / admin） |
| PATCH | `/v1/teams/{id}/members/{userId}` | 调整成员角色 |
| DELETE | `/v1/teams/{id}/members/{userId}` | 移除成员（同时撤销其资源授权） |
| POST | `/v1/teams/{id}/members/{userId}/reset-password` | 重置口令并撤销刷新令牌 |
| GET | `/v1/teams/{id}/access` | 当前成员的可见 / 编辑能力（客户端只读展示） |
| GET | `/v1/teams/{id}/permissions` | 资源树与当前权限配置（owner / admin） |
| PUT | `/v1/teams/{id}/permissions/{type}/{resourceId}` | 设置集合 / 接口可见性 |
| DELETE | `/v1/teams/{id}/permissions/{type}/{resourceId}` | 恢复默认（接口回到继承集合） |
| POST | `/v1/teams/{id}/permissions/batch` | 批量设置（集合整体授权） |
| GET | `/v1/teams/{id}/snapshots` | 快照历史列表（`limit` / `before` 分页） |
| POST | `/v1/teams/{id}/snapshots` | 推送快照 |
| GET | `/v1/teams/{id}/snapshots/latest` | 最新快照元信息 |
| GET | `/v1/teams/{id}/snapshots/{revision}` | 指定版本快照 |
| GET | `/v1/teams/{id}/audit` | 审计日志（owner / admin） |

## 管理台

服务内置一个零依赖的单页管理台，浏览器打开即可使用：

```
http://<服务器地址>:8080/admin/
```

访问根路径 `/` 会自动跳转到 `/admin/`。页面以 `include_str!` 编进二进制，无需单独部署静态资源。

- 登录账号：使用 `BOOTSTRAP_ACCOUNT` 创建的账号（部署时口令写在 `/opt/inkline-team/admin-password.txt`）。
- 功能：团队列表与新建、概览统计、最新快照查看 / 下载、快照历史分页、成员增删与角色调整、口令重置、资源权限树、审计日志、团队设置（名称 / 数据分级上限 / 保留天数）。
- 令牌保存在 `sessionStorage`，关闭标签页即失效；访问令牌过期时用刷新令牌自动续期。
- 页面返回 CSP、`X-Frame-Options: DENY`、`nosniff` 等安全响应头，不加载外部资源。
- 管理台只调用已有的 `/v1` 接口，没有额外的管理特权接口；权限仍由团队成员角色决定。

## 成员与资源权限

### 成员规则

- 角色：`owner`（所有者）、`admin`（管理员）、`member`（成员）、`viewer`（只读）。
- 所有者可以管理管理员及以下角色；管理员只能管理成员与只读账号。
- 不能修改或移除团队所有者；不能将自己移出团队。
- 新建账号需要设置 10–128 位初始口令；添加已有账号沿用原口令。
- 重置口令会撤销该账号的全部刷新令牌，需要重新登录。
- 移除成员会删除其团队成员关系，并清理其在本团队的资源授权。

### 权限规则

- 权限对象是快照中的集合（`collection`）与接口（`request`）；接口文档跟随所属接口，不单独配置。
- 每个资源有两种可见性：`team`（团队可见）或 `restricted`（仅指定成员）。
- 接口未单独设置时继承所属集合；接口策略优先于集合策略。
- `restricted` 支持按成员（`user`）或按角色（`role`）授权，权限为 `view` / `edit`。
- 角色授权只支持 `member` / `viewer`；只读角色永远不能获得编辑权限。
- 所有者与管理员始终可见全部资源，便于管理与排障；限制只作用于成员与只读账号。

### 同步语义

- 拉取最新或指定版本快照时，服务端按查看者权限裁剪集合、接口与文档；成员看不到被隐藏的资源。
- 推送时服务端把客户端提交的可见子集合并进完整快照：只应用查看者有编辑权的资源，保留其看不到或只读的资源，避免整包覆盖误删。
- 成员对只读资源提交的修改会被忽略；只读角色不能推送快照。
- 服务端保存的 `payload_hash` 是合并后完整快照的 hash；`source_hash` 记录客户端原始提交内容，用于幂等重试判断。
- 删除集合时会保留其中不可见的接口：只要集合内存在查看者无权编辑的接口，集合删除会被忽略，避免误删隐藏资源。

### 桌面客户端接入

- 登录：在登录页填写服务地址、账号与口令；登录后若属于多个团队会列出团队供选择，没有团队可直接创建。
- 令牌：访问令牌与刷新令牌保存在本机设置库（SQLite），访问令牌过期自动刷新；退出团队工作区会撤销刷新令牌。后续可替换为操作系统凭据库。
- 拉取：`GET /v1/teams/{id}/snapshots/latest` + 快照内容，按服务端裁剪结果增量写入本机集合、接口与文档草稿；不会删除本机额外请求。
- 推送：携带 `X-Inkline-Base-Revision` 与 `Idempotency-Key`；首次推送前建议先拉取，否则会收到 `409 revision_conflict`，客户端会拉取远端并打开三方合并。
- 权限：客户端通过 `GET /v1/teams/{id}/access` 获取当前账号对集合 / 接口的 `edit` / `view` 能力；只读资源显示锁标记并禁用重命名、移动、删除等操作，只读角色禁止推送。
- 隐藏资源不会出现在客户端快照中；成员对只读资源的本地修改不会同步到服务端。

## 快速验证

```bash
# 登录
curl -s http://127.0.0.1:8080/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"admin","password":"change-me-please"}'

# 使用返回的 accessToken
TOKEN=...

# 创建团队
curl -s http://127.0.0.1:8080/v1/teams \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"支付中台"}'

# 推送快照（首次 baseRevision=0）
curl -s http://127.0.0.1:8080/v1/teams/<teamId>/snapshots \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Inkline-Base-Revision: 0' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"schemaVersion":2,"baseRevision":0,"collections":[],"requests":[],"documents":{}}'

# 拉取最新
curl -s http://127.0.0.1:8080/v1/teams/<teamId>/snapshots/latest \
  -H "Authorization: Bearer $TOKEN"

# 新建成员并加入团队
curl -s http://127.0.0.1:8080/v1/teams/<teamId>/members \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"create","account":"zhangsan","displayName":"张三","password":"Passw0rd!2026","role":"member"}'

# 把集合设为仅指定成员可见
curl -s -X PUT http://127.0.0.1:8080/v1/teams/<teamId>/permissions/collection/<collectionId> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"visibility":"restricted","grants":[{"subjectType":"user","subjectId":"<userId>","permission":"view"}]}'
```

版本冲突时接口返回 `409 revision_conflict`，客户端应拉取最新版本、完成三方合并后携带新的 `baseRevision` 重试。

## 跨网段部署

客户端与服务端不在同一网段、但网络可达时，服务端代码不需要调整，按下面几项检查即可：

- **监听地址**：保持 `BIND_ADDR=0.0.0.0:8080`，不要绑定 `127.0.0.1`，否则只有本机可访问。
- **防火墙**：只放行客户端网段到服务端 8080 端口；PostgreSQL 的 5432 不要对客户端网段开放。
- **入口地址**：客户端填写实际可达的域名或 IP。走 TLS 时证书 SAN 必须包含该域名 / IP；内网可以使用内部 CA。
- **NAT / 端口映射**：客户端填映射后的地址即可；审计以令牌身份为准，不依赖来源 IP。
- **反向代理**：快照上限 10 MB，nginx 需要设置 `client_max_body_size 12m`、足够的 `proxy_read_timeout`，并透传 `Authorization` 与 `X-Inkline-*` 请求头。
- **CORS**：与网段无关，取决于浏览器 / WebView 来源。M1 使用 permissive；上线前限制为 Tauri 的 `http://tauri.localhost` 与开发环境 `http://localhost:1420`。
- **客户端网络策略**：如果 Inkline 处于 B 模式，需要把团队服务的域名或 CIDR 加入白名单，否则同步请求会被本地网络策略拦截。
- **时间同步**：JWT 校验依赖时间，服务端与客户端都应接内网 NTP，避免令牌提前过期或刷新失败。
- **数据库位置**：放在服务端本机或同网段，不要跨网段暴露 5432。
- **出网**：服务端运行时不依赖公网；只有构建镜像、拉取依赖时需要网络。
- **性能**：跨网段会增加 RTT，快照已支持 gzip；接近 10 MB 的快照建议把服务端部署在离数据库更近的位置。

## 数据分级

| 分级 | 含义 | 团队服务策略 |
| --- | --- | --- |
| `L0` | 公开：可对外公开，不包含内部信息 | 允许同步 |
| `L1` | 内部：仅限团队内部使用 | 允许同步（团队默认上限） |
| `L2` | 敏感：仅限授权人员，泄露影响较大 | 需 owner 显式开启，建议同时缩短保留期 |
| `L3` | 机密：核心敏感数据 | 禁止进入团队服务，仅保留在本机 |

- 团队默认 `maxDataLevel = L1`。
- `L0` / `L1` 允许推送；`L2` 需要 owner 先把团队上限调到 `L2`；`L3` 永远拒绝。
- 推送时服务端校验 `requests[].dataLevel`，超限返回 `422 data_level_forbidden` 并记审计。
- 设置 `L3` 为团队上限会直接被拒绝。

## 限制与保留

- 快照默认限制：压缩后 10 MB、解压后 50 MB，可通过环境变量调整。
- 支持 `Content-Encoding: gzip`。
- 每个团队保留 `snapshot_retention_days` / `audit_retention_days` 配置，默认 90 天。
- **M1 暂未实现定时清理任务**，字段与接口已就绪，M2 接入每日清理；在此之前请通过数据库运维策略控制增长。

## 安全注意事项

- 生产环境必须置于 TLS 反向代理之后（nginx / Caddy）。
- `JWT_SECRET`、数据库口令通过环境变量或 Secret 管理，不要提交到仓库。
- M1 为桌面客户端使用 `CorsLayer::permissive()`，上线前应改为固定来源白名单。
- 令牌由客户端保存，桌面端应存操作系统凭据库；当前客户端适配尚未接入。
- 审计日志保留期与查询权限按团队角色控制。
- 资源权限由服务端裁剪快照，但所有者与管理员始终可见全部内容；如需对管理员也保密，需要额外拆分管理权限与内容权限。

## 尚未实现（M2+）

- 邀请码与自助注册
- 快照回滚、定时清理
- 增量同步、单请求级协作、评论
- 企业 SSO、端到端加密
- 桌面端 `teamService` 真实接入（下一步）
