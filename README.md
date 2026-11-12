# 墨线 Inkline · 内网 API 工作台

面向内网与离线场景的 API 调试与文档工作台。基于 Tauri 2 与 React 19 构建，请求、历史、文档草稿与审计记录均保存在本地；AI 文档流支持本地模型、内网网关与外网模型三档路由，并对出网数据做分级、脱敏与人工审批。可选接入自建团队服务，在多台机器之间按成员角色与资源权限同步集合、接口与文档。

## 功能特性

- **请求调试**：GET / POST / PUT / PATCH / DELETE，自定义请求头与 Body，响应状态、耗时、大小与 JSON 高亮。
- **环境变量**：本地 / 开发 / 预发 / 生产四套环境，URL、Headers、Body 支持 `{{var}}` 模板，缺失变量明确报错。
- **本地持久化**：请求与历史写入 SQLite，文档草稿保存在本地；浏览器预览使用 localStorage。
- **AI 文档流**：基于 Ant Design X 的对话面板，从请求与响应示例生成结构化字段、术语命中、置信度与 OpenAPI 草稿 diff，可一键应用到草稿。
- **文档生成接口**：把 Word 等文档里复制的接口说明粘贴到 AI 对话框，自动解析请求方法、地址、请求头与请求体，确认后一键创建并打开请求。
- **三档模型路由与出网预检**：A 本地 / B 内网网关 / C 外网；L2、L3 数据禁止出网，出网前自动脱敏并需人工审批。
- **协作与同步**：本机 / 团队工作区，团队服务端登录、快照 push / pull、单接口增量推送、三方合并与字段级冲突解决，按成员角色与资源权限裁剪内容；顶栏展示团队在线成员。
- **审计与离线队列**：请求、AI 任务、出网审批、团队同步全部留痕；请求失败自动入队，支持单条或批量重试。
- **请求体行内字段注释**：JSON / XML 请求体右侧按行对齐展示 `//` 字段说明，可直接编辑并与 AI 文档草稿双向同步；分隔线可左右拖动调整宽度，支持收起。
- **多协议与自动化**：WebSocket、SSE、GraphQL（含 introspection 与类型浏览）、multipart 文件上传；前置 / 后置脚本沙箱、断言与集合测试、请求取消。
- **Mock 与网络选项**：本地或局域网 Mock Server（支持路径参数与通配符）、A/B/C 网络模式与内网白名单、HTTP 代理、客户端证书（mTLS）、忽略证书校验、Cookie 会话。
- **导入导出**：支持 Postman 集合与环境、OpenAPI、curl 导入；集合可导出 Markdown / HTML / JSON / curl / fetch，审计日志可导出 JSON。
- **响应工具**：保存响应基线并逐行对比；展示总耗时、DNS、TCP、TLS、首字节与下载耗时。
- **团队服务**：自建 Rust axum + PostgreSQL 服务端，成员角色与资源级权限、单接口增量推送、快照回滚、在线状态、端到端加密、快照版本对比、内置管理台。
- **文件夹嵌套**：集合支持父子层级，侧栏缩进展示，支持新建子集合与同级排序。
- **效率与可访问性**：⌘K / Ctrl+K 命令面板、全键盘操作、焦点管理、大响应体虚拟滚动、按需分包。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面容器 | Tauri 2 + Rust |
| 前端 | React 19 + TypeScript + Vite 8 |
| 组件与设计 | Ant Design 5 + Ant Design X |
| 本地存储 | SQLite（rusqlite） |
| 团队服务 | Rust axum + PostgreSQL 16（可选 Docker Compose） |
| 工程 | pnpm workspace（`apps/*`、`packages/*`） |

## 目录结构

```text
.
├─ apps/
│  ├─ desktop/                 # Tauri 桌面端
│  │  ├─ src/
│  │  │  ├─ components/        # 侧栏、请求区、AI 面板、命令面板等
│  │  │  ├─ data/              # 集合、环境、网络模式示例数据
│  │  │  └─ lib/               # 请求、文档任务、路由、脱敏、合并、审计、队列
│  │  └─ src-tauri/            # Rust 端：HTTP / WS / SSE / Mock / AI / SQLite
│  └─ team-server/             # 团队同步服务（axum + PostgreSQL + 管理台）
│     ├─ src/api/              # 登录、团队、成员、权限、快照、审计
│     ├─ migrations/           # PostgreSQL 迁移
│     └─ admin/                # 内置管理台（单页，编入二进制）
├─ packages/
│  └─ ui/                      # 设计 token 与 Ant Design Provider
├─ output/                     # 团队服务 API 设计文档
├─ ROADMAP.md                  # 里程碑与验收记录
└─ pnpm-workspace.yaml
```

## 快速开始

### 环境要求

- Node.js ≥ 20，pnpm ≥ 9
- Rust stable（含 `cargo`）
- Windows 需安装 WebView2 与 Visual Studio C++ 生成工具

### 安装与开发

```bash
pnpm install

# 浏览器预览（localhost:1420，使用本地模拟传输）
pnpm dev

# 桌面端开发（真实 HTTP 与 SQLite）
pnpm tauri dev
```

### 构建

```bash
# 仅前端构建与类型检查
pnpm build

# 生成 Windows 安装包（NSIS，默认不签名）
pnpm tauri build

# 生成带更新签名的发布产物
pnpm release
```

普通构建输出到 `apps/desktop/src-tauri/target/release/bundle/nsis/`。

### 团队服务（可选）

团队工作区需要自建同步服务，依赖 PostgreSQL 16 或 Docker：

```bash
cd apps/team-server
docker compose up -d --build
```

默认账号 `admin` / `change-me-please`，部署后请通过环境变量覆盖；管理台位于 `http://<服务器地址>:8080/admin/`。完整接口、权限规则与跨网段部署说明见 [apps/team-server/README.md](apps/team-server/README.md)。

### Windows 代码签名（可选）

安装包默认不签名，SmartScreen 会提示“未知发布者”。自签名证书只能让已部署该证书的机器识别发布者，**不能保证所有机器跳过 SmartScreen**；若要在公网彻底消除提示，需要 OV / EV 代码签名证书或 Azure Trusted Signing。

1. 生成一次自签名证书（私钥保存在 `%USERPROFILE%\.tauri`，不会进入仓库）：

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/new-signing-cert.ps1 -Password "自定义口令"
```

2. 本地签名构建（需要 Windows SDK 的 signtool）：

```powershell
$env:INKLINE_SIGN_PFX = "$env:USERPROFILE\.tauri\inkline-codesign.pfx"
$env:INKLINE_SIGN_PFX_PASSWORD = "自定义口令"
$env:INKLINE_SIGN_DESCRIPTION = "Inkline"
pnpm release
```

3. CI 签名：在仓库 Secrets 中添加 `WINDOWS_CERTIFICATE_BASE64`（PFX 的 Base64，生成脚本会输出）与 `WINDOWS_CERTIFICATE_PASSWORD`。未配置时流水线自动跳过签名，构建不受影响。

4. 让内网机器信任证书：将 `inkline-codesign.cer` 通过 GPO / Intune 部署到“受信任的根证书颁发机构”和“受信任的发布者”。未部署证书的机器仍会看到 SmartScreen 提示。

> 私钥与 PFX 请离线备份，不要提交到仓库；更换证书后，已信任旧证书的机器需要重新部署新证书。

## 自动更新

桌面端使用 Tauri Updater 检查发行版上的静态清单，更新包经 minisign 签名校验后以 NSIS passive 模式安装。

- 启动后约 2.5 秒自动检查一次，发现新版本时在右下角提示；失败静默，不打扰使用
- 也可随时在「账户菜单 → 检查更新」手动检查
- 清单地址：`https://github.com/jshmztl/Inkline/releases/latest/download/latest.json`
- 更新源使用 GitHub Releases（仓库需公开，客户端才能匿名拉取清单与安装包）
- 公钥：写在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥：默认 `%USERPROFILE%\.tauri\inkline.key`，旧版 `api-workbench.key` 仍兼容，不进入仓库

### 标签触发的流水线（GitHub Actions）

推送 `v*` 标签会自动在 `windows-latest` 上构建签名 NSIS 安装包并创建 GitHub Release，清单里的下载地址指向该 Release 的稳定文件名 `inkline_x64-setup.exe`。

需要先在 GitHub 仓库的 Secrets 中配置：

| Secret | 内容 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件全文，或私钥路径 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令（无口令时留空） |

发布流程：

```bash
# 1. 同步版本号后提交
# 2. 打标签并推送
git tag v0.1.1
git push origin v0.1.1
```

流水线会校验标签与 `tauri.conf.json` 版本一致，再构建、签名并发布。

### 手动发布

1. 提升版本号：同步修改 `apps/desktop/src-tauri/tauri.conf.json` 与 `apps/desktop/package.json`。
2. 构建并签名：

```powershell
pnpm release
```

脚本会输出 NSIS 安装包、`<installer>.exe.sig` 与 `latest.json`，均位于 `apps/desktop/src-tauri/target/release/bundle/`。

3. 把安装包重命名为 `inkline_x64-setup.exe`，连同 `latest.json` 一起上传到 GitHub Releases，并将该发布设为 latest。
4. 客户端在「账户菜单 → 检查更新」中检查、下载并安装。

注意事项：

- 仓库需为公开仓库，否则客户端无法匿名拉取清单与安装包。
- 私钥丢失后，已安装的客户端将无法再接收更新，请离线备份。
- 浏览器预览不支持安装更新，仅桌面端可用。

## 工作区模式

登录页提供两种进入方式：

- **本机工作区**：点「直接进入本机工作区」即可，不需要账号与口令，适合个人使用；数据只保存在本机。
- **团队工作区**：填写团队服务地址、账号与口令登录，可选择已有团队或新建团队。进入后可推送 / 拉取快照，服务端按成员角色与资源权限裁剪内容，客户端对只读资源显示锁标记并禁用编辑。

同步采用乐观锁：首次推送为整包，已有基准后只提交变化的集合、接口与文档；`baseRevision` 冲突时客户端会拉取远端并打开三方合并。访问令牌与刷新令牌保存在 Windows 凭据管理器，访问令牌过期自动续期，退出团队工作区会撤销刷新令牌。

团队设置中可生成或导入端到端加密密钥：启用后请求头、请求体与字段文档在客户端加密后再上传，服务端只保存密文；集合与接口名称、方法保持明文以支持权限裁剪。密钥需通过安全渠道在成员间分发，丢失后无法解密历史快照。顶栏会显示当前在线成员与连接状态。

## 数据与存储

- SQLite 数据库：系统应用数据目录下的 `inkline.db`，包含 `requests`、`collections`、`history`、`settings`、`audit_logs` 等表；环境变量、请求元数据、脚本、断言、AI 配置、文档草稿统一存入 `settings` 表。团队访问 / 刷新令牌保存在 Windows 凭据管理器，端到端加密密钥保存在本机设置中，不上传服务端。
- 卸载时会弹窗询问是否删除应用数据：选择“是”会清理 `%APPDATA%` 与 `%LOCALAPPDATA%` 下的 `com.inkline.desktop`，以及旧版 `com.apiworkbench.desktop`（不清理会被重装后的旧库迁移逻辑恢复）；选择“否”会保留数据，重新安装后可继续使用。
- 浏览器预览的本地键：`aw-session`、`aw-doc-draft:{requestId}`、`aw-team-remote`、`aw-team-base`、`aw-audit`、`aw-offline-queue`。
- 出网预检默认识别 `token`、`secret`、`password`、`authorization`、`api-key`、`tenant` 等敏感字段并脱敏。

## 项目状态

M0–M7 里程碑均已完成，详见 [ROADMAP.md](ROADMAP.md)。测试覆盖前端纯逻辑与团队客户端链路（47 项）、桌面端 Rust 真实网络栈与 SQLite 持久化（15 项）以及团队服务（22 项，API 集成测试需 `TEST_DATABASE_URL`，CI 已接入 PostgreSQL）。浏览器预览可使用大部分功能（AI 与团队同步受浏览器 CORS 与网络策略限制），自动更新与系统级能力仅在桌面端可用。

## 许可

[MIT](LICENSE)
