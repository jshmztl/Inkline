# 墨线 Inkline · 内网 API 工作台

墨线是一款面向内网与离线场景的 API 调试与文档工作台。请求、历史、文档草稿与审计记录保存在本机；需要多人协作时，可以接入自建的团队同步服务。

## 下载与安装

- 系统要求：Windows 10 / 11（64 位）
- 从 [Releases](https://github.com/jshmztl/Inkline/releases/latest) 下载 `inkline_x64-setup.exe`，按提示完成安装。
- 首次启动选择「直接进入本机工作区」即可使用，不需要账号。

## 功能

| 模块 | 能力 |
| --- | --- |
| 请求调试 | GET / POST / PUT / PATCH / DELETE，Params、Headers、Auth、Body、超时与请求取消 |
| 响应工具 | 状态码 / 耗时 / 大小、DNS / TCP / TLS / 首字节 / 下载耗时、JSON 高亮、搜索、保存基线与逐行对比 |
| 环境与集合 | 多环境变量与 `{{var}}` 模板；集合支持文件夹嵌套、排序；最近请求可回填 |
| 文档与 AI | 字段文档、OpenAPI 草稿、AI 生成与审阅；支持本地模型、内网网关、外网模型三档路由 |
| 导入导出 | Postman、OpenAPI、curl 导入；集合与文档导出 Markdown / HTML / JSON / curl / fetch |
| 多协议 | WebSocket、SSE、GraphQL（introspection 与类型浏览）、multipart 文件上传 |
| 自动化 | 前置 / 后置脚本沙箱、断言、集合测试、Mock Server |
| 网络与安全 | A / B / C 网络模式与内网白名单、HTTP 代理、客户端证书、忽略证书校验、Cookie 会话、审计与离线队列 |
| 团队协作 | 账号登录、团队成员与角色、资源级权限、快照推送 / 拉取、增量同步、三方合并、回滚、在线状态与端到端加密 |
| 桌面体验 | 命令面板、全键盘操作、焦点管理、大响应虚拟滚动、按需分包 |

## 快速上手

1. **发送请求**：填写请求方法与 URL，按需添加 Params、Headers、Auth 和 Body，按 `Ctrl+Enter` 发送。
2. **查看响应**：响应区支持搜索、耗时细分、保存基线与逐行对比。
3. **保存到集合**：选择或新建集合后保存请求；集合可建子文件夹并调整顺序。
4. **生成文档**：在 AI 面板中基于响应生成字段说明，确认后应用到文档草稿。
5. **团队协作（可选）**：在登录页填写团队服务地址、账号和口令，选择团队后执行推送 / 拉取。

## 团队服务（可选）

团队工作区需要自建同步服务，推荐使用 Docker 部署（内置 PostgreSQL）。部署完成后，管理台地址为：

```text
http://<服务器地址>:8080/admin/
```

部署、配置、备份与更新步骤见 [团队服务文档](apps/team-server/README.md)。

## 数据与隐私

- 本机数据保存在应用数据目录的 SQLite 数据库 `inkline.db` 中，包含请求、集合、历史、设置、审计与加密后的凭据。
- 主密钥保存在操作系统凭据库（Windows 为凭据管理器）。团队令牌、端到端密钥、AI Key、请求鉴权与环境变量均加密后写入本地仓库，不以明文出现在 settings 中。
- 开启端到端加密后，请求头、请求体与字段文档会在客户端加密后再上传，服务端只保存密文；集合与接口名称、方法保持明文以支持权限裁剪。
- 卸载时可选择保留或删除本机数据，重新安装后可继续使用保留的数据。

## 常见问题

**内网 HTTPS 证书报错？**  
在请求设置中开启「忽略 HTTPS 证书校验」。该选项只建议在可信内网使用。

**请求被拦截或无法访问？**  
检查当前 A / B / C 网络模式与内网白名单；团队同步请求同样受本地网络策略限制。

**响应体显示「已截断」？**  
单次响应正文默认最多读取 10 MiB，超出部分会截断以避免内存耗尽。历史记录仍只保存元数据，不保存响应正文。

**AI 无法出网？**  
L2、L3 数据禁止出网；使用外网模型需要人工审批，也可以切换到本地模型或内网网关。

**忘记团队账号或口令？**  
联系团队管理员；管理员可以在管理台重置成员口令。

## 开发

### 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面容器 | Tauri 2 + Rust |
| 前端 | React 19 + TypeScript + Vite |
| 组件与设计 | Ant Design 5 + Ant Design X |
| 本地存储 | SQLite（rusqlite） |
| 团队服务 | Rust axum + PostgreSQL 16 |
| 工程 | pnpm workspace（`apps/*`、`packages/*`） |

### 项目结构

```text
.
├─ apps/
│  ├─ desktop/                 # Tauri 桌面端
│  │  ├─ src/
│  │  │  ├─ components/        # 侧栏、请求区、AI 面板、命令面板等
│  │  │  ├─ data/              # 示例数据
│  │  │  └─ lib/               # 请求、文档、路由、脱敏、合并、审计、队列
│  │  └─ src-tauri/            # Rust 命令层：HTTP / WS / SSE / Mock / AI / SQLite
│  └─ team-server/             # 团队同步服务
│     ├─ src/api/              # 登录、团队、成员、权限、快照、审计
│     ├─ admin/                # 内置管理台（index.html + assets ES 模块）
│     ├─ migrations/           # PostgreSQL 迁移
│     └─ deploy/               # Docker 部署包与部署脚本
├─ packages/
│  └─ ui/                      # 设计 token 与 Ant Design Provider
├─ output/                     # 团队服务 API 设计文档
├─ BACKLOG.md                  # 问题与改进清单
├─ package.json
└─ pnpm-workspace.yaml
```

### 本地开发

环境要求：

- Node.js ≥ 20，pnpm ≥ 9
- Rust stable（含 `cargo`）
- Windows 需安装 WebView2 与 Visual Studio C++ 生成工具

```bash
pnpm install

# 浏览器预览（localhost:1420，使用模拟传输）
pnpm dev

# 桌面端开发（真实 HTTP 与 SQLite）
pnpm tauri dev
```

浏览器预览适合调整界面与交互；真实网络、SQLite、系统凭据库等能力以桌面端为准。

### 构建

```bash
# 前端类型检查与构建
pnpm build

# Windows 安装包（NSIS）
pnpm tauri build
```

安装包默认输出到 `apps/desktop/src-tauri/target/release/bundle/nsis/`。

### 测试

```bash
# 桌面端前端
pnpm --filter @inkline/desktop test

# 桌面端 Rust
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml

# 团队服务（API 集成测试需要 TEST_DATABASE_URL）
cargo test --manifest-path apps/team-server/Cargo.toml

# 版本一致性
pnpm version:check
```

### 团队服务开发

团队服务需要 PostgreSQL 16。可以本机启动数据库后直接运行：

```sql
CREATE DATABASE inkline_team;
```

```bash
cd apps/team-server
cp env.example .env
# 修改 DATABASE_URL、JWT_SECRET、BOOTSTRAP_*
cargo run
```

管理台资源位于 `apps/team-server/admin`，通过 `include_str!` 编入二进制，没有独立构建步骤。Docker 部署与生产配置见 [团队服务文档](apps/team-server/README.md)。

## 许可

- 桌面端与 `packages/ui`：[MIT](LICENSE)
- 团队服务（`apps/team-server`）：[AGPL-3.0-or-later](apps/team-server/LICENSE)。闭源集成或商业再分发需另行获取商业许可；客户端通过 HTTP 使用团队服务不受 AGPL 约束。
