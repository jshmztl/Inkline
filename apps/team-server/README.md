# Inkline 团队服务

Inkline 的团队同步服务端，负责账号、团队、成员、资源权限、快照同步与审计。技术栈为 Rust axum + PostgreSQL 16，支持 Docker 一键部署。

## 部署

推荐使用 Docker（内置 PostgreSQL）：

1. 生成部署包（包含静态二进制、`deploy.sh` 与 compose 文件）：
   - Windows：`powershell -ExecutionPolicy Bypass -File apps/team-server/deploy/build-image.ps1 -Version 0.1.24`
   - Linux / macOS：`sh apps/team-server/deploy/build-image.sh 0.1.24`
   - 产物位于 `output/inkline-team-deploy`。
2. 将产物上传到服务器，例如 `/opt/inkline-team`，然后执行：

```bash
cd /opt/inkline-team
sh deploy.sh install --with-db
```

3. 打开管理台 `http://<服务器地址>:8080/admin/`，使用初始账号登录，首次登录会强制修改口令。
   - 初始口令保存在安装目录的 `admin-password.txt`。
   - 如果服务器无法访问 Docker Hub，请先离线导入 PostgreSQL 镜像后重试：`docker load -i postgres-16-alpine.tar.gz`。

连接已有 PostgreSQL：

```bash
sh deploy.sh install --external-db
```

在 `.env` 中填写 `DATABASE_URL`；容器内可以使用 `host.docker.internal` 访问宿主机数据库。

更新版本：将新的 `inkline-team-server` 静态二进制或镜像 tar 放到部署目录，然后执行：

```bash
sh deploy.sh update
```

脚本会先备份数据库，再替换镜像并等待健康检查；失败时自动回滚到更新前镜像。其他命令：`status`、`logs`、`backup`。

不使用 Docker 时，也可以直接运行静态二进制，并通过 systemd 等进程管理器托管；环境变量参考 `env.example`。

## 配置

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 | 必填 |
| `JWT_SECRET` | 令牌签名密钥，至少 32 个字符 | 必填 |
| `BIND_ADDR` | 服务监听地址 | `0.0.0.0:8080` |
| `BOOTSTRAP_ACCOUNT` / `BOOTSTRAP_PASSWORD` | 首次启动时创建的账号；首次登录强制改密 | `admin` / 无 |
| `CORS_ALLOWED_ORIGINS` | 允许的浏览器来源，逗号分隔；`*` 表示全部 | Tauri 与本地开发地址 |
| `MAX_COMPRESSED_MB` / `MAX_UNCOMPRESSED_MB` | 快照压缩后 / 解压后大小限制 | `10` / `50` |
| `DEFAULT_SNAPSHOT_RETENTION_DAYS` | 默认快照保留天数 | `90` |
| `DEFAULT_AUDIT_RETENTION_DAYS` | 默认审计保留天数 | `90` |
| `MIN_CLIENT_VERSION` | 允许接入的最低客户端版本 | `0.1.20` |

完整变量说明见 `deploy/env.example`。

## 管理台

`http://<服务器地址>:8080/admin/`

- 团队列表与新建、成员增删与角色调整、口令重置。
- 集合与接口的资源权限配置。
- 快照查看、下载、版本对比与回滚。
- 审计日志查询与团队设置（名称、数据分级上限、保留天数）。

角色分为 `owner`（所有者）、`admin`（管理员）、`member`（成员）、`viewer`（只读）。

## 账号与口令

- 口令至少 8 位，且同时包含字母与数字。
- 新建成员、重置口令、引导账号首次登录都会强制修改口令。
- 登录连续失败 5 次后按指数退避锁定，默认最多锁定 15 分钟。
- 重置口令会立即撤销该成员的全部刷新令牌。

## 权限规则

- 权限对象是快照中的集合与接口；接口文档跟随所属接口。
- 每个资源有两种可见性：`team`（团队可见）或 `restricted`（仅指定成员）。
- 接口未单独设置时继承所属集合；接口策略优先于集合策略。
- `restricted` 支持按成员或按角色授权 `view` / `edit`；只读角色永远不能编辑。
- 所有者与管理员始终可见全部资源，限制只作用于成员与只读账号。
- 推送快照时服务端会按查看者权限合并内容，隐藏资源不会被成员覆盖或删除。

## 数据分级与保留

| 分级 | 含义 | 策略 |
| --- | --- | --- |
| `L0` | 公开 | 允许同步 |
| `L1` | 内部 | 允许同步（团队默认上限） |
| `L2` | 敏感 | 需所有者显式开启 |
| `L3` | 机密 | 禁止进入团队服务 |

- 快照默认限制：压缩后 10 MB、解压后 50 MB。
- 每个团队可配置快照与审计保留天数，默认 90 天，服务端定时清理；每个团队至少保留最新一个快照。

## 运维建议

- 生产环境置于 TLS 反向代理之后，只暴露服务端口，不要暴露 PostgreSQL 5432。
- 定期执行 `sh deploy.sh backup`；更新前脚本会自动备份。
- 健康检查：`/healthz`（进程存活）、`/readyz`（数据库就绪）。
- 跨网段访问时，仅放行客户端网段到服务端口；快照较大时调整反向代理的 body 限制与超时。
- 按实际客户端来源配置 `CORS_ALLOWED_ORIGINS`，不要长期使用 `*`。
- 团队服务使用 AGPL-3.0 许可；闭源集成或商业再分发需另行获取商业许可。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/auth/login` | 账号口令登录 |
| POST | `/v1/auth/change-password` | 修改当前账号口令 |
| POST | `/v1/auth/refresh` | 刷新访问令牌 |
| GET / POST | `/v1/teams` | 我的团队 / 创建团队 |
| GET / POST | `/v1/teams/{id}/members` | 成员列表 / 添加成员 |
| GET / POST | `/v1/teams/{id}/snapshots` | 快照历史 / 推送快照 |
| GET | `/v1/teams/{id}/snapshots/latest` | 最新快照元信息 |
| GET | `/v1/teams/{id}/workspace` | 完整接口内容（owner / admin） |
| GET | `/v1/teams/{id}/permissions` | 资源权限配置（owner / admin） |
| GET | `/v1/teams/{id}/audit` | 审计日志（owner / admin） |
| GET | `/v1/teams/{id}/presence` | 团队在线状态 WebSocket |
| GET | `/v1/meta` | 版本、限制与默认保留天数 |

完整接口与数据结构见 [团队服务 API 设计](../../output/inkline-team-api.md)。

## 许可

本目录代码以 [AGPL-3.0-or-later](LICENSE) 发布。桌面端与 `packages/ui` 仍为 MIT，不因通过 HTTP 调用团队服务而受 AGPL 约束。
