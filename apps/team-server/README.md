# Inkline 团队服务（M1）

Rust + axum + PostgreSQL 实现的团队同步服务，对应设计文档 `output/inkline-team-api.md` 的 M1 范围。

## M1 能力

- 账号登录、刷新令牌、登出、当前用户信息
- 团队创建、列表、详情、设置（名称 / 数据分级上限 / 保留天数）
- 成员列表（邀请与角色管理在 M2）
- 快照最新版本、指定版本、推送（乐观锁 + 幂等键 + gzip）
- 审计日志查询（owner / admin）
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
| POST | `/v1/teams/{id}/snapshots` | 推送快照 |
| GET | `/v1/teams/{id}/snapshots/latest` | 最新快照元信息 |
| GET | `/v1/teams/{id}/snapshots/{revision}` | 指定版本快照 |
| GET | `/v1/teams/{id}/audit` | 审计日志（owner / admin） |

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
```

版本冲突时接口返回 `409 revision_conflict`，客户端应拉取最新版本、完成三方合并后携带新的 `baseRevision` 重试。

## 数据分级

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

## 尚未实现（M2+）

- 邀请码、成员增删与角色变更
- 快照历史列表、回滚、定时清理
- 增量同步、单请求级协作、评论
- 企业 SSO、端到端加密
- 桌面端 `teamService` 真实接入（下一步）
