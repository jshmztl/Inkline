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
- [x] 支持文件夹嵌套

**进展**：集合新增 `parentId`，SQLite 自动补列；侧栏按父子关系缩进展示，支持新建子集合、同级排序与递归删除；团队快照与增量同步均携带 `parentId`，服务端按父集合可见性裁剪子集合。

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

- [x] 按功能拆分 RequestPanel / Sidebar / AiPanel

**进展**：已完成三个大组件的主体拆分。RequestPanel 由约 2390 行降至约 1312 行，请求编辑区拆出 `RequestKvPanel`、`RequestBodyPanel`（含字段注释侧栏）、`RequestAuthPanel`、`RequestAssertionsPanel`、`RequestScriptsPanel`；Sidebar 由 1327 行降至 317 行，拆出 `CollectionTree`、`HistoryPanel`、`EnvironmentSection`、`TeamSyncPanel` 与各编辑 / 导入导出弹窗；AiPanel 由 1318 行降至 585 行，拆出 `AiPanelHead`、`AiTaskPanel`、`AiPromptList`、`AiReviewCard`、`AiComposer`、`AiChatMessages` 与各弹窗，并把提示词与对话逻辑下沉到 `lib/aiPrompt.ts`、`lib/useAiChat.ts`。行为与对外 props 未变，类型检查与构建通过。

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

- [x] 覆盖 Tauri 命令层、真实网络栈与团队同步链路

**进展**：新增真实网络栈集成测试：桌面端 Rust 侧启动本地 TCP 服务，验证“发送请求 → 拿到状态 / 响应体 / 五阶段耗时”与非法协议拒绝；SQLite 侧验证“历史入库 → 关闭并重新打开数据库 → 历史仍在”。团队链路新增桌面客户端测试（登录 → 推送 → 401 刷新重试 → 409 冲突错误 → 加密快照缺钥提示）、三方合并冲突测试，以及团队服务 API 集成测试（登录 → 建团队 → 推送 → 回滚，需 `TEST_DATABASE_URL`，CI 已接入 PostgreSQL）。当前缺口仅剩通过 Tauri IPC 而非底层函数调用的命令层冒烟测试。

**问题**：现有测试以单元测试为主：9 个 vitest 文件覆盖前端纯函数，Rust 侧测试集中在 SQLite、WS / SSE 解析、Mock 路由与团队服务策略 / 认证；请求发送、真实网络栈与团队 push / pull / 冲突合并没有跨层桌面端验证。

**证据**：`apps/desktop/src/lib/*.test.ts`；`apps/desktop/src-tauri/src/{db,mock,netprobe,sse,ws}.rs`；`apps/team-server/src/{auth,policy}.rs`。

**验收**：至少覆盖一次“发送请求 → 历史入库 → 重启恢复”和“登录 → 推送 → 冲突 → 合并”的自动化链路。

### P1-9 团队服务上线加固

- [x] 生产 CORS 白名单
- [x] 快照与审计定时清理
- [x] 令牌迁移到操作系统凭据库

**进展**：CORS 改为 `CORS_ALLOWED_ORIGINS` 白名单（默认 Tauri 与本地开发来源）；新增每日保留期清理任务（`CLEANUP_INTERVAL_HOURS`），至少保留每个团队最新快照；桌面端令牌改存 Windows 凭据管理器，旧版明文连接信息启动时自动迁移。

**问题**：服务端当前使用 `CorsLayer::permissive()`；保留期字段已就绪但没有定时清理任务，快照与审计会持续增长；客户端访问 / 刷新令牌保存在本机 SQLite 的 `settings` 表，未使用系统凭据库。

**证据**：`apps/team-server/README.md`「运维建议」；`apps/team-server/src/main.rs`。

**验收**：CORS 限制为客户端与开发环境来源；每日清理任务按团队保留期删除过期快照与审计；令牌存入 Windows 凭据管理器。

### P2-12 团队服务能力缺口

- [x] 快照回滚
- [x] 邀请码 / 自助注册：经产品决策不做（2026-11-12）
- [x] 企业 SSO（OIDC / LDAP）：经产品决策不做（2026-11-12）

**进展**：管理台快照历史新增「回滚」，服务端新增 `POST /v1/teams/{id}/snapshots/{revision}/rollback`，仅 owner / admin 可用，生成新版本并写审计。

**验收**：owner / admin 可从历史版本生成新快照，并记入审计。

### P2-13 请求耗时细分

- [x] 展示 DNS / TCP / TLS / 首字节 / 下载耗时

**进展**：Rust 端通过独立探测连接测量 DNS、TCP、TLS，响应区在总耗时旁展示；代理或客户端证书场景跳过探测，避免绕过实际网络路径。HTTP 请求不显示 TLS。

**验收**：桌面端发送 HTTPS 请求后可分别看到 DNS、TCP、TLS、首字节与下载五个阶段；HTTP 请求 TLS 显示为不适用。

### P2-14 团队在线状态

- [x] 服务端在线成员广播
- [x] 客户端展示在线成员与连接状态

**进展**：团队服务新增 `/v1/teams/{id}/presence` WebSocket，首条消息携带访问令牌认证，按团队广播在线成员；客户端在顶栏显示在线人数、成员名单与断线重连状态。

**验收**：同一团队的两台客户端登录后，双方都能在团队面板看到对方在线；断开后状态在合理时间内消失。

### P2-15 团队快照端到端加密

- [x] 团队级密钥生成 / 导入与指纹展示
- [x] 客户端加密请求头、请求体与文档草稿后再推送
- [x] 拉取后自动解密，缺失密钥时明确提示

**进展**：团队设置新增端到端加密面板，支持生成、导入、复制与清除 32 字节 AES-GCM 密钥并展示指纹。启用后请求头、请求体与字段文档在客户端加密，服务端透明存储；首次加密会整包推送，把历史明文内容转为密文。缺失或错误密钥时拉取会明确报错。

**验收**：开启团队加密后，服务端数据库中的快照内容为密文；同密钥客户端可正常拉取解密；无密钥时只能看到密文占位且不能编辑；集合 / 接口名称、方法等元数据保持明文以支持权限裁剪。

---

## 0.1.23 复核新增（2026-11-13）

### P0-7 网络模式与重定向校验未下沉到 Rust

- [x] Rust 命令层统一执行 A/B/C 策略
- [x] 重定向逐跳校验
- [x] 补充策略单测与重定向集成测试

**进展（2026-11-13）**：新增 `apps/desktop/src-tauri/src/netpolicy.rs`，HTTP / SSE / WS / AI 命令统一按 `mode` 与 `intranetCidrs` 校验；B 模式支持 DNS 解析、私网、白名单与本地同网段匹配；reqwest 使用自定义 policy 对每次重定向重新判定；A 模式禁止 `probe_network` 解析非本机地址。新增 8 项策略单测与 1 项重定向集成测试，桌面端 Rust 测试共 24 项、前端 47 项通过。

**问题**：A/B/C 三档网络模式与内网白名单只在 React 层 `networkPolicy.ts` 发送前校验；Rust 命令不接收模式参数，`send_http_request` 仅校验 http/https，`ai_chat` 仅校验协议前缀。任何绕过 UI 的 IPC 调用都可以直接出网；reqwest 默认跟随最多 10 次重定向，首跳校验通过后 302 到公网不会被再次拦截。

**证据**：`apps/desktop/src/lib/networkPolicy.ts:47-103`、`255-299`；`apps/desktop/src-tauri/src/http.rs:105-155`；`ai.rs:30-38`；`ws.rs:218-236`；`sse.rs:117-136`。

**方案**：`NetworkOptions` 增加 `mode` 与 `intranetCidrs`；新增 Rust `netpolicy` 模块，在 HTTP / SSE / WS / AI 命令入口统一执行 A/B/C 判定；B 模式支持 DNS 解析、私网、白名单与本地同网段匹配；reqwest 重定向改为自定义 policy 逐跳校验；A 模式下禁止 `probe_network` 解析非本机地址。

**验收**：A 模式仅放行本机；B 模式放行私网、白名单与同网段并拦截公网；C 模式全放行；重定向到公网被拦截；绕过前端直接 invoke 也无法出网。DNS 重绑定需自定义 resolver，另行评估。

### P1-10 团队同步绕过网络策略

- [x] 团队服务请求复用统一网络策略

**进展（2026-11-13）**：`teamClient` 的 `publicRequest` / `teamRequest` 与在线状态 WebSocket 在发起前统一读取当前网络模式并执行 `checkNetworkAccessResolved`；A 模式仅放行本机团队服务，B 模式按私网、白名单与同网段放行，拦截时返回 `network_blocked` 与具体原因。底层仍是 WebView `fetch` / `WebSocket`，devtools 直连属于残余风险。

**问题**：`teamClient.ts` 通过 WebView `fetch` 直接访问团队服务，不经过 Rust 命令层。即使用户处于 A 离线或 B 内网模式，只要配置了公网团队服务地址仍可同步，与“离线 / 内网”承诺不一致。

**证据**：`apps/desktop/src/lib/teamClient.ts:142-214`。

**验收**：A 模式仅允许本机团队服务；B 模式按私网、白名单与同网段规则放行；拦截时给出明确原因。

### P1-11 许可证与商业化策略不一致

- [x] 团队服务切换为 AGPL-3.0 + 商业双许可

**进展（2026-11-13）**：`apps/team-server/LICENSE` 使用 AGPL-3.0-or-later，`Cargo.toml` 与两份 README 已同步；根目录 `LICENSE` 继续覆盖桌面端与 `packages/ui` 的 MIT 许可。

**问题**：`LICENSE` 与 `apps/team-server/Cargo.toml` 均为 MIT，与“客户端开源、团队服务 AGPL-3.0 + 商业双许可”的产品规划不符，团队服务可被闭源商用。

**证据**：`LICENSE:1-3`；`apps/team-server/Cargo.toml:1-6`。

### P1-12 团队服务缺少登录限流

- [x] 登录失败计数、退避与审计
- [x] 默认口令启动校验或首次登录强制改密
- [x] 口令策略：至少 8 位，且同时包含字母与数字

**进展（2026-11-13）**：新增 `login_guard.rs`，按账号记录 15 分钟窗口内的失败次数，连续 5 次后按 60 秒起指数退避、最多锁定 15 分钟，登录返回 429 与 `retryAfterSeconds`；成功登录清零，锁定事件写入一次审计。新增 `must_change_password` 迁移：引导账号、新建成员与被重置口令的账号首次登录必须改密，`AuthUser` 提取器会拦截其他接口并返回 403 `password_change_required`。桌面端登录页与管理台都接入强制改密界面；新口令统一要求至少 8 位且同时包含字母与数字。默认 `ChangeMe2026` 仍会触发启动告警，`/v1/meta` 返回 `bootstrapInsecure`。

**问题**：服务端代码中未见按 IP / 账号的登录失败限流或锁定；Docker 默认 `admin / change-me-please` 仅靠文档提醒，暴露在内网也存在撞库风险。

**证据**：`apps/team-server/src/api/auth.rs`；`apps/team-server/env.example`；`apps/team-server/deploy/env.example`。

### P1-13 CI 未执行桌面端 Rust 测试

- [x] Windows job 增加 `cargo test`

**进展（2026-11-13）**：`ci.yml` 在构建安装包前执行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。

**问题**：`ci.yml` 只执行前端 lint / test 与 `tauri build`，15 项桌面端真实网络栈与 SQLite 重开测试没有进入流水线。

**证据**：`.github/workflows/ci.yml:16-54`；`apps/desktop/src-tauri/src/http.rs` 测试段。

### P1-14 CSP 与脚本沙箱可能冲突

- [ ] 在安装包内验证脚本沙箱
- [ ] 根据结果收敛 CSP 或沙箱实现

**问题**：CSP 为 `script-src 'self'`，禁止 eval；脚本沙箱通过 `new Function` 执行用户脚本。两者可能互相阻断，需真机安装后验证。

**证据**：`apps/desktop/src-tauri/tauri.conf.json:26`；`apps/desktop/src/lib/scriptSandbox.ts:85`。

### P2-15 App.tsx 编排层耦合

- [ ] 按领域拆分 hooks 或 context

**问题**：`App.tsx` 约 913 行、近 30 个 `useState`，团队同步、导入导出、测试运行、热键与会话全部堆在编排层；子组件已拆分，但编排层没有拆分。

**证据**：`apps/desktop/src/App.tsx:113-147`。

### P2-16 版本号与文档漂移

- [ ] 以 `tauri.conf.json` 为唯一版本来源
- [x] CI 校验 `package.json` / `Cargo.toml` / 文档版本

**进展（2026-11-13）**：新增 `pnpm version:check`，校验 `package.json`、`tauri.conf.json` 与 `Cargo.toml` 三处版本一致，并接入 CI；自动同步脚本与文档版本校验仍待补。

**问题**：版本号在 `package.json`、`Cargo.toml`、`tauri.conf.json` 三处手工同步；文档仍停留在 0.1.22。

**证据**：`apps/desktop/package.json:3`；`apps/desktop/src-tauri/Cargo.toml:3`；`apps/desktop/src-tauri/tauri.conf.json:4`。

### P2-17 构建产物混入工作区

- [x] 忽略或迁移 `output/` 下的安装包

**进展（2026-11-13）**：`.gitignore` 已忽略 `output/*.exe`、`*.msi`、`*.sig`，安装包不再出现在 `git status` 中。

**问题**：`output/` 下有两个未跟踪的 4.6MB NSIS 安装包（0.1.21 / 0.1.22），既未进入 `.gitignore`，也不属于源码交付物，存在误提交与仓库膨胀风险。

**证据**：`output/Inkline_0.1.21_x64-setup.exe`、`output/Inkline_0.1.22_x64-setup.exe`；`.gitignore`。

### P2-18 团队管理台为单文件

- [x] 拆分或引入构建与类型检查

**问题**：内置管理台为约 3,407 行的单文件 HTML，无构建流程与类型检查，功能继续增长后维护成本会快速上升。

**证据**：`apps/team-server/admin/index.html`。

**已完成（2026-11-13）**：拆分为 `admin/index.html` + `admin/assets/styles.css` + 11 个 ES 模块（`core`、`workspace`、`export`、`diff`、`overview`、`members`、`permissions`、`content`、`snapshots`、`audit`、`app`），仍为零构建、直接由二进制内嵌托管；服务端新增 `/admin/assets/*` 路由并收紧 CSP（移除脚本 `unsafe-inline`）。同时新增 `deploy/` 离线 Docker 部署包：静态 musl 二进制 + `scratch` 镜像、内置/外部 PostgreSQL 两套 compose、`deploy.sh install|update|backup|status|logs`，更新时自动备份、健康检查与失败回滚。

---

## 执行顺序

1. 团队服务 M2：评论、单请求协作等按需推进
2. 如后续接入真实安装包，可补一次 Tauri IPC 命令层冒烟测试
3. 邀请码与企业 SSO 不做；浏览器预览不投入

已完成（2026-11-13）：P0-7 网络模式下沉 Rust、重定向逐跳校验与策略测试；P1-10 团队同步网络策略；P1-11 团队服务 AGPL-3.0；P1-12 登录限流、口令策略与首次登录强制改密；P1-13 CI 桌面端 Rust 测试；P2-16 版本一致性校验；P2-17 构建产物忽略；P2-18 管理台模块化与 Docker 一键部署/更新。

已完成（2026-11-12）：P1-9 团队服务加固、P2-12 快照回滚、P2-13 耗时细分、P2-14 在线状态、P2-15 端到端加密、P2-1 文件夹嵌套、P2-8 大组件拆分、P1-8 集成测试补齐。
