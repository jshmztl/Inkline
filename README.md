# 墨线 Inkline · 内网 API 工作台

面向内网与离线场景的 API 调试与文档工作台。基于 Tauri 2 与 React 19 构建，请求、历史、文档草稿与审计记录均保存在本地；AI 文档流支持本地模型、内网网关与外网模型三档路由，并对出网数据做分级、脱敏与人工审批。

## 功能特性

- **请求调试**：GET / POST / PUT / PATCH / DELETE，自定义请求头与 Body，响应状态、耗时、大小与 JSON 高亮。
- **环境变量**：本地 / 开发 / 预发 / 生产四套环境，URL、Headers、Body 支持 `{{var}}` 模板，缺失变量明确报错。
- **本地持久化**：请求与历史写入 SQLite，文档草稿保存在本地；浏览器预览使用 localStorage。
- **AI 文档流**：基于 Ant Design X 的对话面板，从请求与响应示例生成结构化字段、术语命中、置信度与 OpenAPI 草稿 diff，可一键应用到草稿。
- **文档生成接口**：把 Word 等文档里复制的接口说明粘贴到 AI 对话框，自动解析请求方法、地址、请求头与请求体，确认后一键创建并打开请求。
- **三档模型路由与出网预检**：A 本地 / B 内网网关 / C 外网；L2、L3 数据禁止出网，出网前自动脱敏并需人工审批。
- **协作与同步**：登录与工作区解锁、团队仓 push / pull、三方合并与字段级冲突解决。
- **审计与离线队列**：请求、AI 任务、出网审批、团队同步全部留痕；请求失败自动入队，支持单条或批量重试。
- **请求体字段注释**：JSON / XML 请求体右侧自动列出字段与说明的映射，说明取自 AI 文档草稿与字段术语表，可随时收起。
- **效率与可访问性**：⌘K / Ctrl+K 命令面板、全键盘操作、焦点管理、大响应体虚拟滚动、按需分包。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面容器 | Tauri 2 + Rust |
| 前端 | React 19 + TypeScript + Vite 8 |
| 组件与设计 | Ant Design 5 + Ant Design X |
| 本地存储 | SQLite（rusqlite） |
| 工程 | pnpm workspace（`apps/*`、`packages/*`） |

## 目录结构

```text
.
├─ apps/
│  └─ desktop/                 # Tauri 桌面端
│     ├─ src/
│     │  ├─ components/        # 侧栏、请求区、AI 面板、命令面板等
│     │  ├─ data/              # 集合、环境、网络模式示例数据
│     │  └─ lib/               # 请求、文档任务、路由、脱敏、合并、审计、队列
│     └─ src-tauri/            # Rust 端：HTTP 引擎、SQLite、命令注册
├─ packages/
│  └─ ui/                      # 设计 token 与 Ant Design Provider
├─ output/                     # 设计研究、PRD、TDD 等文档
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

# 生成 Windows 安装包（NSIS，不签名）
pnpm tauri build

# 生成带更新签名的发布产物
pnpm release
```

普通构建输出到 `apps/desktop/src-tauri/target/release/bundle/nsis/`。

## 自动更新

桌面端使用 Tauri Updater 检查发行版上的静态清单，更新包经 minisign 签名校验后以 NSIS passive 模式安装。

- 启动后约 2.5 秒自动检查一次，发现新版本时在右下角提示；失败静默，不打扰使用
- 也可随时在「账户菜单 → 检查更新」手动检查
- 清单地址：`https://github.com/jshmztl/Inkline/releases/latest/download/latest.json`
- 更新源使用 GitHub Releases（仓库需公开，客户端才能匿名拉取清单与安装包）
- 公钥：写在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥：默认 `%USERPROFILE%\.tauri\inkline.key`，旧版 `api-workbench.key` 仍兼容，不进入仓库

### 标签触发的流水线（GitHub Actions）

推送 `v*` 标签会自动在 `windows-latest` 上构建签名 MSI 并创建 GitHub Release，清单里的下载地址指向该 Release 的稳定文件名 `inkline_x64.msi`。

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

## 演示账号

| 账号 | 口令 | 角色 |
| --- | --- | --- |
| `admin@internal` | `demo1234` | 平台管理员 |
| `dev@internal` | `demo1234` | 接口开发 |

> 演示账号仅用于本地示例，不会发送到任何服务。

## 数据与存储

- SQLite 数据库：系统应用数据目录下的 `inkline.db`，包含 `requests`、`history`、`settings`、`audit_logs` 等表。
- 卸载时会弹窗询问是否删除应用数据：选择“是”会清理 `%APPDATA%` 与 `%LOCALAPPDATA%` 下的 `com.inkline.desktop`，以及旧版 `com.apiworkbench.desktop`（不清理会被重装后的旧库迁移逻辑恢复）；选择“否”会保留数据，重新安装后可继续使用。
- 浏览器预览的本地键：`aw-session`、`aw-doc-draft:{requestId}`、`aw-team-remote`、`aw-team-base`、`aw-audit`、`aw-offline-queue`。
- 出网预检默认识别 `token`、`secret`、`password`、`authorization`、`api-key`、`tenant` 等敏感字段并脱敏。

## 项目状态

M0–M4 里程碑均已完成，详见 [ROADMAP.md](ROADMAP.md)。当前 AI 路由、团队同步与更新检查在浏览器预览下使用本地模拟实现，桌面端可按需接入真实网关。

## 许可

[MIT](LICENSE)
