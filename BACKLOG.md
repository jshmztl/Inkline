# 问题清单与改进计划

> 基线版本：0.1.22 · 更新日期：2026-11-12
> 说明：本清单只记录经代码核查确认的问题，每项附证据与验收标准。完成一项勾选一项并提交 Git。

## 优先级定义

- **P0 阻断级**：影响数据安全、内网可用性或对外可信度，必须在下一版解决。
- **P1 高**：核心使用体验明显缺失，或存在安全/稳定性风险。
- **P2 中**：能力增强与工程优化，可在 P0/P1 完成后排期。

---

## P0 阻断级

### P0-1 关键配置仍存 localStorage，SQLite 备份不完整

- [x] 迁移到 SQLite

**问题**：SQLite 只保存集合、请求、历史三张表；环境变量、请求元数据（Params/Auth/Body 模式/断言/脚本/文件行/超时/协议/GraphQL）、断言、审计、离线队列、网络设置、AI 网关配置、术语表、文档草稿、Mock 配置、登录态全部存在 WebView2 localStorage。清理缓存、换 Windows 账号或迁移机器后，SQLite 备份恢复也是"半个项目"。

**证据**：
- `apps/desktop/src/lib/envStore.ts:7`
- `apps/desktop/src/components/RequestPanel.tsx:140-164`
- `apps/desktop/src/lib/assertions.ts:131-139`
- `apps/desktop/src/lib/queue.ts:20`、`audit.ts:13`、`network.ts:5`、`team.ts:6`、`MockServerModal.tsx:27`

**方案**：新增 `settings(key, value)` 表与 `load_settings` / `save_settings` / `delete_setting` 命令；前端增加同步内存缓存 + 异步持久化的 kv 适配层，启动时从 SQLite 预热并一次性迁移旧 localStorage 数据；各模块仅替换存取调用，不改变同步函数签名。

**验收**：清空 WebView 缓存或删除 localStorage 后重启，环境变量、请求参数、断言、脚本、网络设置、AI 配置、文档草稿全部保留；SQLite 中可直接查到对应键值。

### P0-2 登录与团队同步为本地模拟

- [x] 在界面明确标注"本机模式"，消除误导
- [x] 接入真实团队服务（0.1.20 起）

**进展**：`apps/team-server` 提供登录、刷新令牌、团队与成员管理、资源级权限与快照同步；客户端经 `teamClient` 真实接入，本机工作区保留离线模式。当前剩余 SSO、CORS 白名单与令牌凭据库加固，见 P1-9。

**问题**：任意账号 + 任意非空口令即可登录，无校验、无 RBAC；团队 push 只写 localStorage，pull 只是延迟 320ms 读取同一份数据，没有任何网络请求。ROADMAP 将 M3 标为已完成，但实际不具备多人协作能力。

**证据**：`apps/desktop/src/lib/session.ts:28-52`、`apps/desktop/src/lib/team.ts:70-100`

**方案**：短期在登录页与同步面板显式标注"本机模式 · 数据仅保存在本机"，并移除或降级"团队仓"表述；真实 SSO/RBAC 与服务端列为独立里程碑。

**验收**：界面无"团队同步已连接"等误导文案；用户可明确知道当前为本机模式。

### P0-3 内网 HTTPS 自签证书无法访问

- [x] 增加"忽略证书校验"开关（默认关闭，按请求生效）

**问题**：Rust HTTP 客户端未提供跳过证书校验的能力，政府/企业内网大量自签或私有 CA 证书的 HTTPS 接口会直接失败。

**证据**：`apps/desktop/src-tauri/src/http.rs:72-102`

**方案**：网络设置增加"忽略 HTTPS 证书校验"选项，随请求传入 `acceptInvalidCerts`，后端仅在开启时调用 `danger_accept_invalid_certs(true)`；界面给出风险提示。

**验收**：对内网自签 HTTPS 地址，开启开关后可成功请求；关闭时仍报证书错误。

### P0-4 无 Cookie 会话，跨请求登录态丢失

- [x] 启用 cookie_store，并支持手动清除

**问题**：reqwest 未启用 Cookie 存储，登录接口返回的 Set-Cookie 不会带入后续请求，需要登录态的接口链无法调试。

**证据**：`apps/desktop/src-tauri/src/http.rs:72`

**方案**：客户端启用 `cookie_store(true)`；网络设置或状态栏提供"清除 Cookie"入口。

**验收**：先调用登录接口，再请求需要会话的接口，可携带 Cookie 成功访问。

### P0-5 脚本沙箱可绕过网络模式

- [x] 限制 Worker 内网络与加载能力

**问题**：脚本沙箱在 Worker 中通过 `new Function` 执行，脚本可直接调用 Worker 全局 `fetch`/`importScripts`，绕过 A/B/C 网络策略出网。

**证据**：`apps/desktop/src/lib/scriptSandbox.ts:85`

**方案**：Worker 启动时先禁用 `fetch`、`XMLHttpRequest`、`importScripts`、`WebSocket` 等能力，再执行用户脚本；被禁用时抛出明确错误。

**验收**：前置/后置脚本中调用 `fetch` 会失败并提示"脚本沙箱禁止网络访问"；正常脚本与变量读写不受影响。

### P0-6 版本号不一致

- [x] 统一版本来源

**问题**：状态栏显示 v0.1.0，登录页显示 v0.1，实际版本 0.1.11。

**证据**：`apps/desktop/src/components/StatusBar.tsx`、`apps/desktop/src/components/LoginScreen.tsx`

**方案**：构建时注入 `package.json` 版本（Vite `define`），界面统一读取。

**验收**：关于/状态栏/登录页版本与安装包版本一致。

---

## P1 高

### P1-1 无重定向控制

- [x] 支持关闭自动跟随并展示重定向链

**问题**：reqwest 默认自动跟随最多 10 次，无法调试 301/302 行为。证据：`http.rs:72`。

**验收**：可切换"跟随/不跟随"，不跟随时能看到 Location 与状态码。

### P1-2 WebSocket / SSE 不经过统一请求引擎

- [x] 代理、客户端证书与忽略证书校验对 WS/SSE 生效

**进展**：SSE 与 WebSocket 均已接入 Rust 网络栈，共用代理、客户端证书（mTLS）与忽略证书校验设置；WS 支持自定义请求头与主动关闭，界面已移除旧的能力限制提示。

**问题**：WS 使用 WebView 原生 `new WebSocket`，SSE 使用 WebView `fetch`，代理与客户端证书只对普通 HTTP 生效；WS 无重连/心跳/二进制帧查看，SSE 只解析 `data:`。证据：`protocol.ts:26-120`。

**验收**：开启代理后 WS/SSE 流量走代理；界面明确标注能力边界。

### P1-3 审计日志不可导出、容量有限

- [x] 迁移到独立 SQLite 表，支持导出 JSON

**进展**：审计写入 `audit_logs` 表，不再受 200 条上限限制；旧 localStorage 审计会在启动时自动导入；界面支持 JSON 导出。

**问题**：审计仅存 localStorage，上限 200 条，无导出。证据：`audit.ts:13-32`。

**验收**：审计可从界面导出为文件，重启后保留。

### P1-4 历史记录只加载最近 6 条

- [x] 支持全量历史与分页

**进展**：按 50 条一页加载，侧栏底部提供"加载更多历史"，搜索覆盖全部已加载记录。

**问题**：`listHistory(6)` 限制导致历史搜索实际只覆盖 6 条。

**验收**：历史面板可分页查看全部记录，搜索覆盖全量。

### P1-5 脚本与断言仅在单请求生效

- [x] 支持集合级测试的脚本与变量串联

**问题**：断言与脚本在前端单请求流程执行，集合测试只会发送请求，不执行前后置脚本，也不共享提取变量。证据：`testRunner.ts`。

**验收**：集合测试按顺序执行脚本，后一个请求能使用前一个请求设置的变量。

### P1-6 工程基线缺失

- [x] 增加 CSP
- [x] 增加 lint 与前端测试

**进展**：新增 `pnpm lint`（tsc）与 `pnpm test`（vitest）；已启用 CSP，允许 IPC、HTTP(S)/WS(S)、内联样式与脚本沙箱所需的 Blob Worker。CSP 需在真机安装后确认界面与脚本功能正常。

**问题**：无 lint 脚本、无前端测试；`tauri.conf.json` 中 `csp: null`；RequestPanel 70KB / Sidebar 38KB / AiPanel 37KB 单文件过大。

**验收**：`pnpm lint` 与 `pnpm test` 可运行；CSP 非空且不影响现有功能。

### P1-7 localStorage 写入失败被静默吞掉

- [x] 持久化失败时给出可见提示

**问题**：多处 `try/catch` 仅注释"存储不可用时保留在内存中"，用户无法得知保存失败。

**验收**：模拟存储失败时界面出现明确警告。

---

## P2 中

### P2-0 协议与断言能力增强

- [x] SSE 解析 event / id 字段并在事件流中展示
- [x] WebSocket 自动回复 Ping，支持带认证的 HTTP 代理
- [x] 断言新增正则匹配与类型校验

### P2-1 集合与请求无嵌套、无排序

- [x] 支持集合与请求上移 / 下移排序
- [ ] 支持文件夹嵌套

**进展**：集合与请求右键菜单新增"上移 / 下移"，顺序持久化到 SQLite 的 `sort` 字段。

### P2-2 缺少复制能力

- [x] 支持复制请求、复制集合

**进展**：请求与集合右键菜单新增"复制"，请求的 Params、断言、脚本等元数据会一并复制。

### P2-3 GraphQL 仅当作 POST JSON

- [x] 支持 introspection、类型浏览与变量格式校验

**进展**：GraphQL 编辑区新增“获取 Schema”，可浏览类型、字段、参数类型与枚举值；Variables 必须是 JSON 对象。

### P2-4 Mock Server 只能本机访问

- [x] 支持监听局域网地址并展示可访问地址

**进展**：Mock Server 新增"允许局域网访问"开关，绑定 `0.0.0.0` 后局域网设备可用本机 IP 访问。

### P2-5 内网白名单仅支持 IPv4 CIDR

- [x] 支持 IPv6 网段

**进展**：内网网段白名单与同网段判断均支持 IPv6 CIDR，例如 `fd00::/8`、`fe80::/10`。

### P2-6 无请求耗时分解

- [x] 展示首字节（TTFB）与下载耗时

**进展**：响应区展示总耗时、首字节与下载耗时；DNS / TCP / TLS 细分需自定义 connector，暂未实现。

### P2-7 自动更新在内网不可用

- [x] 内网/离线模式隐藏不可用的更新入口

**进展**：A/B 模式下“检查更新”置灰并标注“需外网”，启动时也不再自动检查；C 外网模式保持原有更新能力。内网自建更新源需要替换 Updater 流程，暂不实现。

### P2-8 大组件拆分

- [ ] 按功能拆分 RequestPanel / Sidebar / AiPanel

**进展**：GraphQL Schema 与响应对比弹窗已改为按需加载；RequestPanel 主体仍待拆分，当前约 2390 行，Sidebar 约 1310 行，AiPanel 约 1318 行。

### P2-9 响应对比

- [x] 支持保存响应基线与逐行对比

**进展**：响应“更多”菜单新增“保存响应为基线”和“对比基线”，使用 LCS 逐行对比并标出新增/删除行。

### P2-10 Postman 环境导入

- [x] 支持导入 Postman 环境变量文件

**进展**：导入入口会优先识别 Postman 环境 JSON（`values` 数组），创建环境并自动切换。

### P2-11 Mock 动态路由

- [x] 支持路径参数与通配符匹配

**进展**：Mock 编辑区新增“路径模式”，支持 `/users/:id` 与 `/users/*`，同一 Mock 可覆盖多个实际路径。

---

## 0.1.22 复核新增

### P1-8 无端到端 / 集成测试

- [ ] 覆盖 Tauri 命令层、真实网络栈与团队同步链路

**问题**：现有测试均为 vitest 纯函数单测（断言、导入、网络策略、会话、团队 delta 等），请求发送、SQLite 持久化、WS / SSE、AI 网关与团队 push / pull / 冲突合并没有集成验证；发布前只能依赖手工回归。

**证据**：`apps/desktop/src/lib/*.test.ts`；`apps/desktop/src-tauri` 无 Rust 测试；团队服务无接口测试。

**验收**：至少覆盖一次“发送请求 → 历史入库 → 重启恢复”和“登录 → 推送 → 冲突 → 合并”的自动化链路。

### P1-9 团队服务上线加固

- [ ] 生产 CORS 白名单
- [ ] 快照与审计定时清理
- [ ] 令牌迁移到操作系统凭据库

**问题**：服务端当前使用 `CorsLayer::permissive()`；保留期字段已就绪但没有定时清理任务，快照与审计会持续增长；客户端访问 / 刷新令牌保存在本机 SQLite 的 `settings` 表，未使用系统凭据库。

**证据**：`apps/team-server/README.md`「安全注意事项」「尚未实现（M2+）」两节；`apps/team-server/src/main.rs`。

**验收**：CORS 限制为客户端与开发环境来源；每日清理任务按团队保留期删除过期快照与审计；令牌存入 Windows 凭据管理器。

### P2-12 团队服务能力缺口

- [ ] 快照回滚
- [ ] 邀请码 / 自助注册
- [ ] 企业 SSO（OIDC / LDAP）

**问题**：管理台已支持版本对比与导出，但还不能把历史版本回滚为最新；成员只能由 owner / admin 创建；账号体系为本机账号，未接入企业目录。

**证据**：`apps/team-server/README.md`「尚未实现（M2+）」。

**验收**：owner / admin 可从历史版本生成新快照；支持邀请码或 SSO 登录。

---

## 执行顺序

1. P2-8 大组件拆分
2. P1-8 端到端 / 集成测试
3. P1-9 团队服务上线加固
4. P2-1 文件夹嵌套
5. P2-12 团队服务能力缺口（含 SSO）
