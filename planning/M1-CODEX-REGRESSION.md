# Navloom · Codex 统一验收与回归执行单（M1 + M2）

> **M2 架构重置（2026-10-11）**：T-036～T-059 全部重新实现和独立验收。下方旧 C/D 组 WSS/15 秒 heartbeat/Agent 主动重连步骤仅作历史记录，**不得据此给新架构判 PASS**。以本文末尾的 E 组反向按需 WSS 验收为准。T-034/T-035 的历史成果和独立复核记录保留。


> **用途**：**继续使用之前交给 Codex 的这一个文件**集中安排 M1 浏览器回归和 M2 Agent 接入验收；Codex 在此追加结果、复现步骤与修复证据，不另开一份验收清单。任务状态的权威来源仍是 [认证任务](./tasks/02-access-auth.md)、[导航任务](./tasks/03-navigation.md)、[Agent 任务](./tasks/04-agent.md) 和 [容器池任务](./tasks/05-inventory.md)。
>
> **基线（2026-10-11，提交 `63e7edc`）**：M1 共 25 项，11 项已勾选验收，**14 项未完成**（9 项 UI/交互待回归，5 项依赖 M2）；M2 共 26 项，**T-035 已通过自动化验收（1/26）**，T-034/T-036/T-041～T-043 已有部分实现且接入 WSS，T-037～T-040 代码已提交并通过自动化 CI，**以上均待 Codex 独立验收**；T-044～T-047 已提交受限任务/能力探测代码，等待 Codex 验收；T-048～T-059 的 12 项尚未实现。代码存在 ≠ 测试通过；CI 通过 ≠ 浏览器/真实 Agent 联调通过。

## 给 Codex 的执行指令

1. 先阅读本文件、[M1 实施记录](./M1-IMPLEMENTATION.md)、[M2 实施记录](./M2-IMPLEMENTATION.md)、[PRD](./PRD.md)、[决策记录](./DECISIONS.md) 和对应任务原文；检查当前代码而不是仅相信旧实施记录。
2. **优先执行 A 组 M1 的 9 项和 C 组 M2 当前已实现部分的验收**：M1 使用真实浏览器交互（建议 Playwright；仓库当前未预装浏览器 E2E 测试框架），M2 使用本地隔离 Server/SQLite + Go 测试与管理员浏览器。能自动化的编写可重复运行的测试；无法运行时标记 `NOT_RUN`，不得伪称通过。
3. 对复现的 **M1 或 M2 当前已实现功能**缺陷做最小必要修复并重新回归；不要为了验收而提前实现 D 组尚未交付的容器操作/M3 功能、生产部署、健康检查、额外业务模块或未确认的产品决策。
4. **B 组 5 项标记 `BLOCKED_M2`**；**C 组 WSS 子任务及 D 组 T-037～T-040 改为 `NOT_RUN`，等待 Codex 独立联调**；**容器池依赖继续 `BLOCKED_M2`/`BLOCKED_INVENTORY`**；**T-044～T-047 已提交部分实现，按 D5～D8 测试；T-048～T-059 继续 `NOT_IMPLEMENTED`**。可检查模型/接口并编写独立子测试，但不能用假 Agent、mock 容器或已通过 CI 冒充真实联调验收。
5. 每项给出 `PASS / FAIL / BLOCKED_M2 / BLOCKED_INVENTORY / BLOCKED_WSS / NOT_IMPLEMENTED / NOT_RUN`、执行命令/浏览器、测试结果、失败复现步骤、截图或日志路径、相关提交。**只有实际通过全部原任务验收标准才把对应任务文件中的 `- [ ]` 改为 `- [x]`**；不能只凭页面存在或 CI 绿色勾选。T-035 已在任务文件勾选，Codex 的独立复核状态仍应从 `NOT_RUN` 开始。
6. 回归完成后在本文件底部的「统一验收结果」区域追加记录，按实际结论分别更新 [M1 实施记录](./M1-IMPLEMENTATION.md) 和 [M2 实施记录](./M2-IMPLEMENTATION.md)；不要修改已确认的产品规则或把 Q-xx 默认建议当成用户最终决定。

## 回归环境与前置数据

- **仅在本地开发/隔离环境**进行；不要连接真实 NAS Docker 或将开发 Server 暴露公网。
- 环境：Node.js 22、npm 10+、浏览器（Chromium 优先，条件允许补 Firefox/WebKit）；浏览器上下文至少准备「无凭据访客」「只有首页 Cookie」「管理员会话」三组。
- 使用**独立临时 SQLite 数据库**，不要复用个人真实数据；例如在仓库根目录的 Bash 终端执行：

```bash
npm ci
npm run build:contracts
export DATABASE_URL="$(mktemp -d)/navloom-regression.db"
npm run db:migrate
# 按仓库 README「首次管理员初始化」交互设置三项凭据，
# 然后执行一次（不要将真实密码写入命令行、日志或仓库）：
npm run admin:init -w @navloom/server
npm run dev
```

- Web：`http://localhost:5173`；Vite 代理 Server `/api/v1`。先确认 `/api/v1/system/status` 可访问。不要误把 Server 状态接口当成容器/应用健康检查。
- 准备测试数据：两个分组「常用」「开发」、一个空分组；至少四张卡片（两张同组、一张另一组、一张未分组），分别含 Emoji、HTTPS 图片图标、描述、`_blank`/`_self` 打开方式。外链可用 `https://example.com` 和 `https://github.com`，**不要假设外部站点始终可访问**，验证导航的 URL、target、rel 与交互即可。
- 先执行已有基线：`npm run build`、`npm run typecheck`、`npm run lint:ts`、`npm run test:server`。它们不能替代浏览器回归。
- 如需 Playwright，可在 Codex 环境按需添加测试依赖和脚本；提交可复跑的测试代码。无法安装/启动浏览器时明确记录阻碍，不猜测测试结果。

## A. 本轮必须回归的 9 项（现有代码已提交，尚未验收）

### A1 · 访问与认证 UI（3 项）

- [ ] **T-014｜弱口令入口页面与自动跳转** · `AUTH-01/02`
  - 新浏览器直接访问 `/`，应看到弱口令入口；输入错误口令显示可理解错误，输入正确口令进入导航首页。
  - 刷新、关闭后重新打开浏览器，凭据有效时不应再次询问；清除 Cookie、凭据撤销/过期后应回到验证页，不应空白、死循环或显示未经授权的卡片。
  - Server 不可用时有可读错误；观察网络请求，未授权的 `GET /api/v1/home/navigation` 必须被 Server 拒绝。
  - **通过**：首次验证、记住浏览器、失效重验、错误反馈均可在真实浏览器复现。

- [ ] **T-016｜后台修改弱口令与撤销首页凭据** · `AUTH-01/05`
  - 管理员进入 `/admin/settings` 修改首页口令；已验证的浏览器 A、B 在刷新后均须重新验证，旧口令失效，新口令可用。
  - 再次获取首页凭据后执行「撤销所有已记住浏览器」并确认；两个浏览器都应失效；取消确认不应产生变更。
  - 只有首页 Cookie 或无 Cookie 时调用设置 API 应拒绝；前端不能显示/持久化明文口令，日志与回归证据不得泄漏密码。
  - **通过**：UI、API、多个浏览器上下文中的撤销结果一致。

- [ ] **T-017｜管理员登录页、路由守卫与修改密码** · `AUTH-03`
  - 未登录直接打开 `/admin/navigation`、`/admin/instances`、`/admin/settings`，应重定向到 `/admin/login`；管理员登录后返回原目标页面。
  - 首页弱口令不能当管理员密码使用；管理员登录后可看到**两个**业务主入口「导航页管理」「应用实例管理」，设置只能是辅助入口。实例页此时允许显示 M2 占位内容。
  - 点击「退出登录」后，浏览器后退、刷新或直接请求管理 API 均不能恢复管理权限。
  - 修改管理员密码：旧密码无法再次登录、已有管理员会话失效、新密码可登录；错误密码与失败请求应有提示。
  - **通过**：路由守卫与 Server 权限同时生效，登录/退出/修改密码无 UI 卡死或凭据泄漏。

### A2 · 导航首页与编辑 UI（6 项）

- [ ] **T-020｜导航首页布局与卡片组件** · `NAV-01/04`
  - 默认路由 `/` 是导航首页，不是 Docker 管理页；无卡片时显示清晰空状态。
  - 有数据时展示分组、未分组、图标、标题、描述；`_blank` 应在新标签打开并具备 `noopener noreferrer`，`_self` 在当前标签打开。
  - 点击卡片只进行链接导航，不触发任何管理或 Docker 操作；页面不自动显示未被手动编排的容器。
  - **通过**：空状态、有分组/无分组、两种打开方式和点击行为均正确。

- [ ] **T-023｜手动新建/编辑导航卡片弹窗** · `NAV-02/06`
  - 在 `/admin/navigation` 添加无关联外部卡片，填写名称、HTTP/HTTPS URL、Emoji/HTTPS 图标、描述、分组、打开方式；保存后首页可见。
  - 编辑名称、URL、图标、描述、分组和打开方式；刷新后持久化。无效 URL（空、`javascript:`、`file:`、带账号密码的 URL）应被阻止并有可理解提示。
  - 取消编辑不应写入；删除取消不应删除；确认删除后卡片消失，且不产生 Docker 操作。
  - **通过**：所有字段可修改、错误可见、取消/确认行为正确、焦点与键盘操作可用。

- [ ] **T-025｜导航分组编辑界面** · `NAV-03/06`
  - 新建、重命名两个分组；保留并展示空分组；通过 UI 调整分组顺序，刷新后不丢失。
  - 删除有卡片的分组时提示「卡片移到未分组」；取消无副作用，确认后卡片仍存在且 URL 不变。
  - **通过**：后台操作后首页刷新与 Server 持久化状态一致，不静默丢失卡片。

- [ ] **T-026｜卡片拖拽排序与跨组移动** · `NAV-03/06`
  - 拖动同组卡片改变顺序；拖动到另一个分组、空分组及「未分组」；重新加载后台与首页，排序/归属保持。
  - 验证分组拖拽顺序和按钮式上移/下移（若当前 UI 提供），尤其第一张/最后一张边界。
  - 模拟排序 API 返回 409/网络失败，UI 应显示错误并恢复原排序；不能留下与 Server 不一致的乐观状态。
  - **通过**：排序、跨组、失败回滚均真实可复现；不能仅凭单元测试推断拖拽有效。

- [ ] **T-027｜首页搜索、响应式与基础主题** · `NAV-04/NFR-03`
  - 搜索标题、描述，验证大小写、前后空格、无匹配提示、清空搜索恢复；不能误显示无权限数据。
  - 至少验证 320px、375px、768px、1280px 视口：无横向溢出、文字/按钮不被遮挡、表单可操作。
  - 切换深浅主题后文本与按钮对比度可读，刷新后主题偏好保持；主题存储不能包含口令或管理员凭据。
  - 键盘 Tab 可到达搜索框和卡片，Enter 可打开链接；检查焦点可见、表单标签、弹窗焦点/关闭等基本可访问性。
  - **通过**：搜索、移动端布局、主题、键盘访问均有浏览器证据。

- [ ] **T-032｜导航页管理完整布局与首页刷新** · `NAV-06/PROD-02`
  - 管理员只在「导航页管理」一个业务模块内完成分组、卡片创建/编辑/删除、排序与跨组移动。
  - 保存后切回首页或刷新首页，显示的只有已保存卡片；删除卡片后不残留；退出管理员会话不影响仍有效的首页只读凭据。
  - **通过**：完成「登录后台 → 创建分组/卡片 → 编辑 → 排序 → 首页查看 → 删除 → 首页刷新」完整真实浏览器闭环。

## B. 依赖 M2 的 5 项（本轮不得误判为通过）

- [ ] **T-028｜创建卡片时选择关联来源** · `NAV-05` · **BLOCKED_M2**
  - 前置：T-052 容器池、T-056 实例查询。届时检查「无关联/应用实例/容器池」选项、Agent 筛选/搜索、取消关联仍可保存、外部容器可选。
  - 本轮只验证手动无关联卡片正常创建；不能把现有「M2 接入」提示当成选择器已实现。

- [ ] **T-029｜卡片关联 API 与稳定标识** · `NAV-05/INV-05` · **BLOCKED_M2**
  - 前置：T-049、T-056。届时检查关联对象类型/ID、Agent/Compose/service 身份隔离、容器重建不会串设备、关联失效后卡片仍存在。
  - 本轮可静态检查现有卡片可空关联数据模型，不等于关联 API 已验收；Q-05 多卡片关联仍待确认。

- [ ] **T-030｜容器/实例元数据预填导航表单** · `NAV-05/CAT-04` · **BLOCKED_M2**
  - 前置：T-028、T-029。届时检查名称、图标、候选端口/URL 预填且全部可覆盖；无候选 URL 仍可手输；不得强制 EasyTier IP。
  - 本轮仅回归手动编辑所有字段，不得将其算作容器元数据预填通过。

- [ ] **T-031｜关联失效与离线状态提示** · `NAV-05/INV-05` · **BLOCKED_M2**
  - 前置：T-029、T-054。届时检查 Agent 离线、容器消失后的后台提示，原导航链接不删除/不禁用，状态文案不冒充健康检查。
  - 本轮没有真实 Agent/容器事件，不能进行完整验收。

- [ ] **T-033｜导航独立性与端到端回归测试** · `NAV-01～06/NFR-05` · **BLOCKED_M2（可先做部分）**
  - 本轮先自动化并验收独立 URL、卡片 CRUD、分组、排序、权限隔离、刷新持久化、删除卡片无 Docker 副作用等可用场景。
  - 待 M2 接入后补齐「容器池选卡 → 预填可编辑 URL → 关联/失联 → 卡片保留」端到端测试，**全部通过后才能勾选 T-033**。

## 跨任务回归矩阵（A 组至少执行一次）

| 场景 | 无 Cookie | 仅首页 Cookie | 管理员 Cookie |
| --- | --- | --- | --- |
| 首页导航只读 API | 拒绝 | 允许 | 允许 |
| 管理导航查询/修改 API | 拒绝 | 拒绝 | 允许 |
| 安全设置 API | 拒绝 | 拒绝 | 允许 |
| 管理页面直接访问 | 跳转登录 | 跳转登录 | 允许 |

另需检查：所有管理修改请求的 CSRF/Origin 保护；退出后旧 Cookie 不可复用；口令撤销/修改后旧浏览器失效；网络请求和控制台没有未处理异常；不输出明文密码、Cookie 或 SQLite 数据文件。使用 `http://localhost:5173` 与 `http://127.0.0.1:5173` 时注意 Host/Origin 一致，避免把环境差异误判为业务缺陷。

## C. M2 当前代码验收（6 项：1 项已由 CI 验收，5 项待完整验收）

> **当前实现基线**：Agent 配对数据库迁移 `0002_m2_agent_pairing.sql`、Server `agent-pairing.ts`、Go `internal/pairing` 与 `-pair` CLI、`/admin/instances` 的设备管理 UI。CI [38142316871](https://github.com/CiBeDerORG/Navloom/actions/runs/38142316871) 的 **Web + Server + SQLite / Go Agent / Local Docker Compose startup 三项成功**，只作为自动化证据；Codex 独立复核尚未执行。相关提交：`75e98ef`、`6df5d2a`、`6bf0f83`、`a8aeedc`、`63e7edc`。

### M2 WSS 自动化证据与 Codex 复核范围

- [CI 38144150805](https://github.com/CiBeDerORG/Navloom/actions/runs/38144150805) **4/4 作业成功**：Web + Server + SQLite、Go Agent、Local Docker Compose startup、**M2 Go-to-Node WSS integration**。
- `server/src/m2-transport.test.ts` 覆盖握手拒绝、双设备身份隔离、心跳、版本校验、超大帧、替换连接、超时与撤销；`agent/internal/transport/client_test.go` 覆盖 TLS、退避重连、心跳与关闭。
- `scripts/smoke-m2.mjs` 在临时 SQLite + 回环 Server 上启动**两台真实 Go Agent 进程**，验证在线、停止/重启、同一 ID 恢复、撤销一台不影响另一台。该脚本使用临时测试凭据，运行后删除本地数据，不接触 NAS/Docker。
- Codex 可在具备 Node.js 22、Go 1.24+ 的隔离环境复跑：先 `npm ci && npm run build:contracts && npm run build:server`，再 `node scripts/smoke-m2.mjs`。记录退出码、提交 SHA 和日志路径；**CI 成功不能自动填 Codex `PASS`**。
- 仍需人工/浏览器检查：管理员界面实时状态、错误文案、不同视口、实际 TLS 代理与断网环境；T-039 的只读能力探测任务关联已提交，Docker 操作的完整任务关联仍依赖 T-055；T-042 的容器筛选依赖 T-053。
### C 组执行环境与纪律

- **只使用本地隔离 Server、独立 SQLite、回环测试 HTTP 及测试用 Agent 身份**。除非用户另行授权，不连接真实 NAS、Docker Socket 或公网 Server；不得把设备凭据、一次性令牌、Cookie、数据库原文件或日志中的秘密提交 Git。
- 先运行以下命令，记录退出码、执行环境与 CI 链接。M1 与 M2 可共享本地测试环境，但测试数据必须隔离：

```bash
npm ci
npm run build
npm run typecheck
npm run lint:ts
npm run test:server
npm run test:go
# 在临时 DATABASE_URL 指向的独立 SQLite 上重复运行迁移
npm run db:migrate
npm run db:migrate
```

- 在本地开发 Server 创建测试管理员（使用 README 的 `admin:init` 安全交互流程），准备「未登录」「只有首页 Cookie」「管理员 Cookie」三组请求上下文；如需测试 Go CLI 配对，使用回环测试 Server/本地 TLS 测试服务及临时 `token_file`，不得用生产设备凭据。
- **WSS 已提交并通过自动化 CI、Codex 独立验收尚未执行**：配对后还需正常启动 Agent 才能在线；在线不代表 Docker 可用。测试只用隔离 Server/临时身份。

### C1 · T-034｜Agent 身份与设备持久化模型 · WSS 已提交，完整验收 NOT_RUN

- 检查 SQLite `agents` 的唯一 ID、名称、凭据摘要、注册/撤销时间、版本/平台/架构与最近心跳字段；增量迁移在旧数据上可重复运行，不丢失 M1 记录。
- 验证重复 ID 和重复非空凭据摘要受约束；撤销后状态重启仍保留，设备列表不得泄露凭据摘要。
- **本批新增回归**：使用同一私有身份断线重连，不产生第二条设备记录，`lastSeenAt` 随心跳更新；需真实 Go↔Node 联调证据，未通过前不得勾选。

### C2 · T-035｜Server 一次性接入令牌 · 已自动化验收，Codex 独立复核 NOT_RUN

- 管理员可签发 10 分钟有效、一次性随机令牌；未登录/仅首页 Cookie、缺少 CSRF 或跨站 Origin 的请求不得签发；同时待用令牌上限与错误提示符合当前实现。
- 使用有效令牌配对第一台 Agent 成功，再次使用同一令牌、过期令牌、格式错误令牌均拒绝；错误响应不暴露令牌是否存在；重复失败触发限流。
- 数据库只保存令牌 SHA-256 摘要，设备长期凭据也只存摘要；日志/列表/错误消息不含令牌明文。审计包含签发、成功、拒绝，不包含秘密。
- **已勾选依据**：`server/src/m2-pairing.test.ts`、CI [38142225822](https://github.com/CiBeDerORG/Navloom/actions/runs/38142225822) 和 [Agent 任务](./tasks/04-agent.md)。Codex 复核若发现缺陷，应标记 `FAIL`、附证据并修复；不要仅因已有勾选就预填 `PASS`。

### C3 · T-036｜Go Agent 首次配对与私有凭据 · WSS 已提交，完整验收 NOT_RUN

- 运行 `cd agent && go test ./...`；用本地 Server/httptest 验证 `-pair` 从标准输入读取令牌，成功返回 Agent UUID + 独立凭据并保存 `0600` 私有文件；重复配对拒绝覆盖，格式错误和过期令牌有安全提示。
- 验证生产 URL 必须 `wss://` 并校验 TLS，只有显式开发开关 + loopback 可使用 `ws://`；拒绝 HTTP 重定向，不在命令行参数、普通日志或异常消息中输出令牌/凭据。
- **本批新增回归**：正常启动从私有文件加载同一身份自动重连；未配对 Agent 不可建立受信会话或接收命令。必须完成 Go↔Node 联调才能勾选。

### C4 · T-041｜Agent 列表、详情与重命名 API · 在线状态已提交，完整验收 NOT_RUN

- 只有管理员 Cookie 能访问 `GET /api/v1/admin/agents`、`PATCH /api/v1/admin/agents/:id`；未登录/首页 Cookie 拒绝；重命名刷新/Server 重启后仍在，非法 ID、空名称与撤销设备修改得到可理解错误。
- 列表返回 ID、名称、版本、平台、架构、登记/最近通信/撤销时间及状态，**不得包含凭据摘要**；离线设备仍保留历史记录。
- **本批新增回归**：列表及 `GET /api/v1/admin/agents/:id` 详情反映真实在线状态、最近心跳、连接断开后的离线；验证未登录/首页 Cookie 不能读取详情。

### C5 · T-042｜应用实例管理内设备 UI · 在线视图已提交，容器池仍 BLOCKED_INVENTORY

- 浏览器登录管理员后打开 `/admin/instances`：只有「导航页管理」「应用实例管理」两个业务主模块；可生成一次性令牌，看到到期时间、复制与关闭显示，刷新后不再次展示旧令牌。
- 配对后刷新列表，选择设备查看 ID/版本/登记时间，重命名后保留；撤销按钮有确认，取消不应生效，确认后状态变为「已撤销」；错误/空状态/窄屏可读，不能泄露秘密。
- **本批新增回归**：连接后约 10 秒内显示「在线」，断线/超时后「离线」，撤销后「已撤销」。Agent 筛选与按 Agent 切换容器管理视图仍依赖 T-053，不能提前勾选。

### C6 · T-043｜Agent 撤销凭据与断开连接 · 主动断线已提交，完整验收 NOT_RUN

- 管理员撤销后 `revoked_at` 持久化；`verifyAgentCredential` 对旧凭据返回拒绝，重复撤销和无权限撤销不会成功；设备历史记录仍可查，审计事件不含凭据。
- **本批新增回归**：撤销正在连接的设备，Server 主动关闭连接（关闭码 4003），不能继续接收任务，旧凭据重连被拒绝；记录真实 WSS 证据。

### C 组跨边界安全回归

- 「无 Cookie / 仅首页 Cookie / 管理员 Cookie」分别请求签发令牌、查询设备、重命名、撤销：仅管理员允许，修改操作还要验证 CSRF/Origin。
- 使用已撤销 Agent 凭据调用身份验证应失败；绝不将首页口令或管理员 Cookie 当成 Agent 凭据；设备配对接口只能用于交换一次性令牌，不是 Docker 操作入口。
- 检查错误路径（过期、重复使用、格式错误、无权限、网络断开）不会输出秘密；CI 绿灯不等于真实设备验收。

## D. M2 后续验收登记（20 项：8 项已提交代码待独立回归，12 项尚未实现）

> 这些任务**继续统一登记在本文件**。**T-037～T-040 按 D1～D4 回归；T-044～T-047 按 D5～D8 回归已实现的安全子集**；T-048～T-059 仍为 `NOT_IMPLEMENTED`。T-045/T-047 的 Docker 执行子项仍被 T-048/T-055 阻塞。不要用 mock 通过代替真实 Agent/Docker 联调。

| 任务 | 待实现能力 | 完整验收关键条件 |
| --- | --- | --- |
| T-037 | Server WSS 连接与认证 | 无效/撤销凭据拒绝、重复连接策略、消息大小限制、断线状态更新、生产 TLS |
| T-038 | Go WSS 客户端与自动重连 | 断网退避重连、Server 重启后同一身份恢复、优雅退出、TLS 校验 |
| T-039 | Agent JSON 信封/协议校验 | 未知版本/类型/非法 payload 安全拒绝、请求与响应可关联 |
| T-040 | 心跳与在线状态 | 在线、超时离线、重连恢复在线且 ID 不变，最近通信时间准确 |
| T-044 | 已提交只读探测任务路由与超时，待验收 | 仅向目标 Agent 发送；超时不等于失败；重复结果可识别 |
| T-045 | 已提交命令白名单与安全拒绝，Docker 执行尚未开放 | 仅允许已定义 Docker/Compose 命令；未知命令、伪造参数、任意 shell 被拒绝 |
| T-046 | 已提交只读 Docker/Compose 探测，待真实隔离环境验收 | 不可用时明确报错，不误开放部署入口 |
| T-047 | 已提交双 Agent WSS/任务隔离测试，容器操作测试仍阻塞 | 两台 Agent 独立；凭据不可互冒；撤销后不可操作；恶意消息无效 |
| T-048 | 发现所有 Docker 容器 | 已有、运行中、停止及外部容器均被发现；Docker 不可用可见 |
| T-049 | Server 容器快照持久化 | Agent ID 隔离；重复快照不重复；只接收所属 Agent 的上报 |
| T-050 | Docker 事件 + 全量对账 | create/start/stop/remove 后同步；断线重启后全量校准 |
| T-051 | 端口/Compose labels 标准化 | 多端口保留、无 Compose labels 可用、不虚构 URL |
| T-052 | 容器池查询 API | 管理员可筛选外部容器；无权限拒绝；含最后同步时间 |
| T-053 | 容器池 UI | Agent 筛选、搜索、来源/端口/镜像/状态与空状态；不自动加首页卡片 |
| T-054 | 离线与快照过期提示 | 离线可查历史但标记非实时；重连后刷新 |
| T-055 | 启停重启容器 | 仅管理员/指定 Agent/目标容器；失败可见；无任意命令或删除 |
| T-056 | 应用实例模型与 API | 外部容器不自动成为实例；多容器关联；重启后数据持久 |
| T-057 | 实例与 Compose 稳定关联 | 重建后不失联、同名不同 Agent 不串绑、外部来源不变 |
| T-058 | 容器日志查询 | 管理员权限、限制行数/大小、断线处理、敏感信息保护 |
| T-059 | 容器池综合回归 | 已有/外部/停止/Compose 容器、断线、重建、权限、操作、导航独立性 |

### D1 · T-037｜Server WSS 身份、生命周期与 TLS 边界 · NOT_RUN

- 本地临时 SQLite 配对 Agent A/B，使用 `ws://127.0.0.1:3000/agent`（仅显式开发）连接；无凭据、错误 Bearer、A ID + B 凭据、已撤销凭据、错误协议版本都必须在握手前被拒绝。首页 Cookie/管理员 Cookie 不得作为 Agent 凭据。
- 同一 Agent 新连接应替换旧连接（4001），新连接保持在线；超过 64 KiB 的帧关闭码 1009；Server 停止后连接释放；生产仅允许通过可信 TLS 代理的 `wss://`，不允许公网明文 HTTP 直连。
- 验证握手错误/日志不泄漏 Bearer 凭据，未认证连接不能触发 Docker 或任意 shell。

### D2 · T-038｜Go Agent TLS、退避重连与优雅退出 · NOT_RUN

- 运行 `cd agent && go test ./...`；在隔离 Node Server 上通过 `-pair` 生成私有身份，普通启动发送 `hello`/心跳；断开网络/重启 Server 后自动退避重连且 Agent ID 不变，不能毫秒级无限重试。
- `wss://` 自签名/不受信任证书必须拒绝；远程 `ws://` 必须拒绝，只有显式开发开关加 loopback 可用；SIGINT/SIGTERM 关闭连接；日志不含令牌或长期凭据。
- 不得为测试而关闭 TLS 证书校验；不可在公开 CI 中打印测试凭据。

### D3 · T-039｜JSON 信封、版本与白名单 · NOT_RUN（只读任务关联已提交）

- 检查 TypeScript `AgentMessageSchema` 和 Go `protocol` 的 `protocol_version`、`message_id`、`agent_id`、`sent_at`、`type`、`payload`、任务 `task_id`；共享 fixtures 对正常/错误版本心跳的解析一致。
- 通过真实 WSS 发送错误版本、未知类型、二进制帧、非法 JSON、负 uptime、错误 Agent ID、重复 `message_id`、心跳先于 `hello`、伪造的 Agent→Server `task_dispatch`/`inventory_snapshot`，必须安全拒绝且不执行命令；合法 Server→Agent 的 `capability_probe` 应被接收并关联 `task_result`。
- **只读任务请求与响应的关联性**已提交并有自动化测试；仍需 Codex 验证错误任务 ID、重复结果、断线后迟到结果和设备隔离。完整 T-039 仍待独立验收。

### D4 · T-040｜心跳、在线/离线与历史时间 · NOT_RUN

- 两台不同测试 Agent 连接，管理员列表和详情应显示独立 `online`；`hello` 更新版本，心跳更新 `lastSeenAt`；暂停心跳超过超时后离线，历史最后通信时间保留。
- 断线重连后状态恢复在线且 ID 不变，SQLite 不重复；替换连接/撤销设备后旧会话不能覆盖新状态；浏览器 `/admin/instances` 在约 10 秒轮询内反映状态变化。
- 可用缩短超时的自动化测试覆盖边界，但仍需 Codex 记录真实 Go↔Node 双端联调证据，不能用纯 mock 代替。
### D5 · T-044｜定向任务、持久化、超时与迟到结果 · NOT_RUN

- 阅读 `server/drizzle/0003_m2_agent_tasks.sql`、`server/src/realtime/agent-tasks.ts` 与 `server/src/realtime/agent-hub.ts`。在独立 SQLite 中运行两台真实 Go Agent A/B，连接后 `hello` 应自动下发**仅只读** `capability_probe`，每个任务具有唯一 `task_id`，`agent_id` 严格指向对应设备；`GET /api/v1/admin/agent-tasks/:id` 仅管理员可读。
- 用管理员 Cookie 调用 `POST /api/v1/admin/agents/:id/capability-probe`（空 JSON `{}`），检查 CSRF、Origin、未登录、首页 Cookie、非法 Agent ID、离线/撤销设备、非法参数；不能指定任意 operation、容器 ID、Shell 或文件路径。
- 中断设备连接或让任务超过 deadline，任务应为 `unknown` 而不是 `failed`；Server 重启后原 `sent` 应转 `unknown`，**不能自动重放未来的有副作用命令**。同一 Agent 重连后可补报原 `task_id` 的结果，完成后重复/冲突结果不能覆写；B 的凭据不能为 A 的任务回报。
- 记录任务 ID（非凭据）、状态变化、SQLite 行数、日志和复现命令。若未覆盖重启与迟到结果，保留 `NOT_RUN` 或按实际结果 `FAIL`，不得勾选 T-044。

### D6 · T-045｜严格命令白名单与拒绝审计 · BLOCKED_INVENTORY（安全子集可测）

- 检查 `packages/contracts/src/index.ts` 中 `AgentCommandSchema`：`capability_probe`、`inventory_refresh`、`container_start/stop/restart`、`compose_deploy` 有各自严格参数 schema；但**本批只允许 `capability_probe` 执行**，其余仅为未来协议占位，不能视为容器操作已交付。
- 通过真实 WSS 向 Agent 发送 `shell`、`../` 路径、额外参数、伪造 task ID、错 Agent ID、容器启停/Compose 操作；必须拒绝，且不能执行任意命令。Server 对非法 Agent 消息应在 `agent_audit_events` 留下无秘密的 `protocol_rejected`，Go Agent 对非法命令应留下不含原始 payload/令牌的安全警告。
- 检查当前代码没有通用 `exec`/shell 任务执行器；Compose 检测只可使用固定 `docker compose version --short` 参数。真正启停/部署命令仍需 T-055/M3 的授权与幂等性验收；**不得提前勾选 T-045**。

### D7 · T-046｜Docker API / Compose v2 能力与不可部署原因 · NOT_RUN

- 先运行 `cd agent && go test ./internal/probe ./internal/protocol`；测试用临时 Unix Socket 模拟 `GET /_ping`、`GET /version`，分别覆盖 API 正常、Socket 不存在、无权限、daemon 不可达、`DOCKER_HOST=tcp://...` 被拒绝；使用 PATH 内隔离的 `docker` CLI stub 测试固定 `compose version --short`。
- 用隔离的双 Go Agent 与 Node Server 跑 `node scripts/smoke-m2.mjs`；验证 `agent_capabilities` 与设备列表/详情的 `capabilities`、`checkedAt`，Docker 不可用时有 `socket_missing` 等安全枚举原因，不能凭在线状态宣称可部署。
- Codex 在真实浏览器 `/admin/instances` 检查 Docker API、Compose v2、探测时间、不可部署原因及「刷新 Docker 能力」按钮；未连接设备按钮不可用；设备离线时保留历史探测但必须明确不是实时健康检查。
- **真实 Docker 环境的验收须先获得明确授权**；未授权时只记录模拟 Socket/CLI 与真实 Go↔Node 子测试，不得伪称 T-046 全部通过。

### D8 · T-047｜双 Agent 认证、任务隔离与恶意消息 · BLOCKED_INVENTORY（安全子集可测）

- 在隔离环境执行 `npm run test:server`、`npm run test:go`、`node scripts/smoke-m2.mjs`；测试两个真实 Go 进程各自配对/连接、只读任务定向、独立能力结果、离线/重连、凭据撤销，数据库不得重复 Agent ID 或串写任务。
- 用 A 的凭据冒充 B、用 B 的 WSS 回报 A 的 task ID、发送未知协议版本/消息类型、重复 message ID、畸形 JSON/超大帧、伪造 `task_result`，必须拒绝且不能影响另一设备；审计不得泄漏凭据。
- 检查撤销 A 后正在连接的 A 被主动断开，A 不能继续执行探测，B 仍可正常完成；生产 TLS 反代与实际网络中断场景按 D1/D2 单独记录。
- T-047 的 Docker 容器操作隔离部分必须等 T-055 在授权的测试 Docker 环境实现后再测；**当前不勾选整项**。

**本批自动化证据**：[CI 38144954055](https://github.com/CiBeDerORG/Navloom/actions/runs/38144954055) 四项通过（含真实双 Go Agent 的定向能力探测、结果持久化、撤销/重连）；Server 新增 `m2-transport.test.ts` 任务相关性与安全用例，Go 新增 `protocol/task_test.go`、`probe/docker_test.go`。此处只记 CI 证据，**Codex 的 PASS 必须来自独立复核**。
**联调门槛**：T-037～T-040 可在本地隔离环境先做 WSS 双端联调；T-048～T-059 需要明确授权的测试 Docker 环境与至少两台隔离 Agent。M2 未达到这些条件前，M1 的 T-028～T-031/T-033 继续 `BLOCKED_M2`。任何新测试都不得默认为允许访问真实 NAS 或公网。

## 统一验收结果与交付格式（Codex 填写）

每个任务一行结果，**不得预填 Codex 的 PASS**。下表是本轮初始状态；其中 T-035 虽已在任务文件通过 CI 自动化验收，Codex 独立复核仍为 `NOT_RUN`：

| 任务 | 状态 | 证据（测试文件/命令/截图或日志） | 问题 / 修复提交 |
| --- | --- | --- | --- |
| T-014 | NOT_RUN | — | — |
| T-016 | NOT_RUN | — | — |
| T-017 | NOT_RUN | — | — |
| T-020 | NOT_RUN | — | — |
| T-023 | NOT_RUN | — | — |
| T-025 | NOT_RUN | — | — |
| T-026 | NOT_RUN | — | — |
| T-027 | NOT_RUN | — | — |
| T-032 | NOT_RUN | — | — |
| T-028 | BLOCKED_M2 | 依赖容器池 | — |
| T-029 | BLOCKED_M2 | 依赖关联 API / 实例 | — |
| T-030 | BLOCKED_M2 | 依赖关联来源 | — |
| T-031 | BLOCKED_M2 | 依赖 Agent 离线事件 | — |
| T-033 | BLOCKED_M2 | 可先记录独立导航子测试 | — |
| T-034 | NOT_RUN | 身份模型可先做 SQLite 子测试 | — |
| T-035 | NOT_RUN | 已自动化验收；待 Codex 独立复核 | — |
| T-036 | NOT_RUN | Go 配对与私有文件可先做子测试 | — |
| T-037 | NOT_RUN | WSS 代码已提交，待 Codex 双端回归 | — |
| T-038 | NOT_RUN | WSS 代码已提交，待 Codex 双端回归 | — |
| T-039 | NOT_RUN | WSS 代码已提交，待 Codex 双端回归 | — |
| T-040 | NOT_RUN | WSS 代码已提交，待 Codex 双端回归 | — |
| T-041 | NOT_RUN | 管理员 API 可先做子测试 | — |
| T-042 | BLOCKED_INVENTORY | 设备 UI 可先做浏览器子测试 | — |
| T-043 | NOT_RUN | 撤销持久化可先做子测试 | — |
| T-044 | NOT_RUN | 已提交安全子集，按 D5 独立回归；Docker 操作待后续 | — |
| T-045 | BLOCKED_INVENTORY | 已提交安全子集，按 D6 独立回归；Docker 操作待后续 | — |
| T-046 | NOT_RUN | 已提交安全子集，按 D7 独立回归；Docker 操作待后续 | — |
| T-047 | BLOCKED_INVENTORY | 已提交安全子集，按 D8 独立回归；Docker 操作待后续 | — |
| T-048 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-049 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-050 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-051 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-052 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-053 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-054 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-055 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-056 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-057 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-058 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |
| T-059 | NOT_IMPLEMENTED | 等待 Docker 容器池/实例实现 | — |

**最终回归报告必须包含**：测试日期与 commit SHA、运行环境、自动化命令及退出码、浏览器/视口覆盖、M1 A 组 9 项逐项结论、M1 B 组 5 项阻塞说明、M2 C 组 6 项逐项子测试与完整验收差距、D 组 8 项已提交代码待回归与 12 项未实现状态、失败复现步骤和修复、未测风险、CI 结果，以及 M1/M2 各自是否达到阶段性门槛。Codex 每轮只更新实际执行过的行，并保留未执行任务的真实状态。

> **阶段性通过条件**：A 组 9 项全部真实验收通过，已验收的 11 项无回归，且无阻断性缺陷，即可声明 **M1 独立导航能力已完成回归**；但 **M1 任务总数仍为 20/25**，B 组 5 项必须待 M2 联调后才能完成。不能把 20/25 写成 25/25。

> **M2 阶段性通过条件**：T-034～T-059 原任务验收标准全部通过，至少两台 Agent 在授权的测试环境稳定连接、隔离，真实容器池和操作符合安全边界；当前仅 T-035 已按自动化验收勾选，**M2 仍为 1/26**。M1 与 M2 的通过率不得合并或相互代替。

## E. M2 T-036～T-059 反向按需连接架构重新验收（全部 NOT_RUN）

> **本节替代旧 C/D 组中与连接方向、主动重连、JSON heartbeat、超时离线相关的步骤；不得新增其他 Codex 验收文件。** 先检查提交 SHA、迁移、代码与隔离测试，再执行真实双 Go Agent ↔ Node Server 联调。CI 绿灯不等于 Codex PASS；真实 NAS/Docker 操作必须单独授权。

| 任务 | 新架构必须验证的核心条件 | Codex 状态 |
| --- | --- | --- |
| T-036 | 单次配对、Agent 私网端点与双向 TLS 信任、0600 私钥、错误证书/地址拒绝、旧身份迁移策略 | NOT_RUN |
| T-037 | Server 主动 WSS；0 页面不连接；N 页面同 Agent 只有一条；端点/证书校验；撤销拒绝 | NOT_RUN |
| T-038 | Go Agent 仅被动监听；无主动拨号/轮询/重连；私网绑定；异常 TLS 拒绝 | NOT_RUN |
| T-039 | 消息版本/ID/任务关联；恶意输入拒绝；旧 JSON heartbeat 删除；只有 Ping/Pong 心跳 | NOT_RUN |
| T-040 | 0→1 建连、N→0 全断、自动/手动/间隔切换、页面异常退出、状态冻结、全局唯一 | NOT_RUN |
| T-041 | 管理员设备/探测配置 API，历史结果与实时状态区分，非管理员拒绝 | NOT_RUN |
| T-042 | 任意已登录管理员页面均能配置、跨页面同步；普通首页口令登录的导航页可激活连接但无配置权限；未登录访客不激活；容器入口不越权 | NOT_RUN |
| T-043 | 撤销证书/设备阻断后续连接、关闭当前连接，不影响其他 Agent | NOT_RUN |
| T-044 | 定向任务、超时 unknown、页面归零中断 unknown、结果幂等、无自动副作用重放 | NOT_RUN |
| T-045 | 严格命令白名单、参数校验、未认证不执行、无任意 shell | NOT_RUN |
| T-046 | 按需只读 Docker/Compose 探测，无页面不执行，结果保留且标注时间 | NOT_RUN |
| T-047 | 双 Agent 全链路隔离、0 页面网络零通信、1/N 页面不重复、手动自动切换、断线恢复 | NOT_RUN |
| T-048 | 新连接后发现运行/停止/外部容器，无页面不上报 | NOT_RUN |
| T-049 | 按 Agent 隔离、快照幂等、历史快照冻结、只接收认证设备 | NOT_RUN |
| T-050 | 连接活跃时事件增量；0 页面不上传；重新进入全量对账补齐变化 | NOT_RUN |
| T-051 | 端口/Compose labels/状态标准化，不虚构 URL | NOT_RUN |
| T-052 | 容器池查询筛选分页、权限与最后同步时间 | NOT_RUN |
| T-053 | 容器池 UI、外部容器不自动建导航卡片 | NOT_RUN |
| T-054 | 无页面保持最后 Agent 状态与快照；历史时间清楚可见；重新连接刷新 | NOT_RUN |
| T-055 | 授权隔离 Docker 中按 Agent/容器定向启停重启，拒绝越权和重复执行 | NOT_RUN |
| T-056 | 实例独立模型持久化，外部容器不自动成为实例 | NOT_RUN |
| T-057 | Compose 重建稳定关联、跨 Agent 不串绑 | NOT_RUN |
| T-058 | 有界日志、权限与断线处理；无页面无流式上传 | NOT_RUN |
| T-059 | 完整容器池/实例/安全回归与 0 页面零通信综合测试 | NOT_RUN |

### E1 · 页面在线与唯一全局调度器（T-037/T-040/T-041/T-042）

- 未登录访问导航口令页/管理员登录页不计入在线数；**仅持有效首页 Cookie 的普通导航页也必须计入并触发 WSS**；持管理员 Cookie 的首页、导航管理、应用实例、设置均计入。浏览器只保存 Cookie、但没有打开页面时不计入。打开同一账号或不同身份的 N 个标签页，只启动**一套 Server 全局调度器**，每台 Agent 最多一条 WSS。
- 0 个已登录页面时抓包或使用隔离 TCP 计数器确认 Agent↔Server 无握手、Ping、轮询、重连和 Docker 上报；历史 Agent 状态/快照保持原值。**只有一个首页口令授权的导航页时也必须连接**；管理员页面进入同样连接；关闭/注销/会话失效最后一个已登录页面后 WSS 关闭；页面非正常消失可最终回收；后台标签页未关闭仍计入。
- 自动模式按共享间隔 Ping/Pong；手动模式只在管理员按钮触发时探测一次；不同管理员页面改配置同步并持久化；**仅首页凭据不可修改设置或手动下发探测/任务**；Ping/Pong 不按周期写 SQLite；不存在第二套 JSON heartbeat。

### E2 · 私网双向 TLS 与配对（T-036/T-037/T-038/T-043）

- Agent 仅绑定经明确配置的私网/EasyTier 地址；配对时登记端点和证书绑定，测试证书不匹配、伪造 Server、错误 Agent ID、撤销设备、公网/回环/重定向地址限制；不能通过 DNS 重绑定、SSRF 或跳过 TLS 校验连接任意内网服务。
- 确认 Agent 不会在无人在线时主动连接 Server，也不会因 Server 不可达而周期轮询；配对期间的一次性 HTTPS 请求需管理员明确触发。旧主动连接进程/路径必须被移除或明确禁用。

### E3 · 安全任务与容器池（T-039/T-044～T-059）

- 真实两台隔离 Go Agent 与 Node Server 的消息信封、task_id、能力探测、非法命令/参数、撤销、连接关闭后 unknown、迟到/重复结果幂等；无 Shell。测试真实 Docker 前必须先获授权，允许 fake Unix Socket/CLI 做自动化子测试。
- 管理页面重新进入后先全量容器扫描，再启用事件增量；无页面期间不得推送 Docker Events/快照；历史数据和 AppInstance/NavigationCard 严格分离；容器操作与日志均需管理员权限。
- Codex 逐项写实际 PASS/FAIL/NOT_RUN 和证据；不得把旧 D1～D8 的通过结果迁移到本节。M2 通过门槛仍为 T-034～T-059 全部按当前需求通过。

**T-036 增量代码自动化记录（非 Codex PASS）**：[CI 38150454809](https://github.com/CiBeDerORG/Navloom/actions/runs/38150454809) 4/4 通过；包含私网端点输入拒绝、证书格式校验、Go 配对配置错误路径、数据库迁移；尚无反向 WSS/双向 TLS 联调。E 组状态全部保持 `NOT_RUN`。

**E1 追加权限矩阵**：① 无 Cookie 或无效/过期 Cookie 的导航页、登录页：不计数、不建连；② 只有有效首页 Cookie 的导航页：计数、建连，不得访问 `/api/v1/admin/*`；③ 有效管理员会话的任意页面：计数、建连，按管理员权限修改配置；④ 多页面混合打开：只建一套 WSS/心跳；⑤ 最后一个有效页面关闭或凭据失效：断开连接并保持最后状态。上述用例均为 **NOT_RUN**，不能引用旧 CI 充当 Codex PASS。

**T-036～T-038 自动化增量（非 Codex PASS，2026-10-11）**：[CI 38154719616](https://github.com/CiBeDerORG/Navloom/actions/runs/38154719616) 4/4 通过，覆盖 Go 私网 TLS 证书生成/权限、被动 WSS 客户端证书校验、重复连接拒绝、Ping/Pong 与只读任务，以及 Node 主动拨号器静态安全条件。**尚未覆盖 Server 主动连接真实 Go 被动 Agent、首页口令导航页在线驱动或零页面抓包**，因此 E 组 T-036～T-059 仍全部 `NOT_RUN`，不得沿用旧 CI 或此增量 CI 判定独立验收通过。

**自动化证据追加（非独立验收，2026-10-11）**：[CI 38155682480](https://github.com/CiBeDerORG/Navloom/actions/runs/38155682480) 4/4 通过，新增真实 Go 被动 Agent ↔ Node 主动 Server 的私网 mTLS 配对、页面在线按需连接、Ping/Pong、只读任务和多页面断连/重连隔离脚本。**E 组 T-036～T-059 仍为 `NOT_RUN`**；旧主动 WSS 路径未移除，不能以此宣称完整新架构、真实 NAS 或独立 Codex 验收 PASS。

**反向 WSS v2 清理与双 Agent CI（2026-10-12，非 Codex PASS）**：[CI 38159332832](https://github.com/CiBeDerORG/Navloom/actions/runs/38159332832) 四项均通过；旧 Agent 主动 WSS、Server `/agent` 入站及 JSON heartbeat 均已删除。隔离环境中的两台真实 Go 被动 Agent 与 Node Server 验证了首页单页连接、多页面共享、手动 Ping、A/B 任务隔离、单 Agent 重启、撤销后禁连与零页面状态冻结。**E1～E3 仍须 Codex 独立执行异常浏览器关闭、包级零通信、证书拒绝、真实 NAS 安全验证；T-036～T-059 均维持 `NOT_RUN`，不得凭 CI 直接勾选。**

**T-036/T-041/T-042 代码及独立回归前置（2026-10-12，NOT_RUN）**：Server 新配对必填私网端点和有效 TLS 服务端证书，Go 配对也在缺少端点时拒绝。管理员 Agent 列表/详情新增证书配置状态、WSS IP/端口、v2 hello、连接起始时间、最近 WSS Pong；没有 hello 在 8 秒后断开。须独立检查未登录或只有首页 Cookie 无权读取设备详情；证书私钥/设备凭据不可出现在列表；Pong 不写 SQLite；浏览器最后离开后页面不再引起 Agent 连接。CI 单测不能替代真实环境 PASS，E 组保持 `NOT_RUN`。

**E1 追加自动化证据（2026-10-12；非 Codex PASS）**：[CI 38186457634](https://github.com/CiBeDerORG/Navloom/actions/runs/38186457634) 4/4 作业通过。`server/src/m2-presence.test.ts` 增补了：首页口令撤销只回收对应普通导航页面、独立管理员页面继续在线、管理员会话注销最终归零、浏览器无 WS Close 握手断开回收、零页面手动 Ping 被拒绝；`AdminShell` 全局共享 Agent 探测控件使导航管理/实例管理/设置页面均可修改同一持久化配置，不创建第二条 Agent WSS。生产浏览器保活时限未缩短。**这些并非真实浏览器跨终端演练、Pong 半开连接计时、零 Agent 网络抓包或 Codex 独立验收，E1 T-040～T-042 保持 NOT_RUN。**

**T-043～T-047 安全子集自动化证据（2026-10-12；非 Codex PASS）**：[CI 38187095261](https://github.com/CiBeDerORG/Navloom/actions/runs/38187095261) **4/4 通过**。新增 `m2-task-recovery.test.ts` 验证 A/B 任务隔离、同设备 pending 去重、断线及 deadline/restart 未决任务 `unknown`、合法迟到结果关联、重复结果相同内容幂等、冲突结果拒绝及撤销设备不能写入迟到结果。新增 `m2-pong-timeout.test.ts` 验证 Ping 防叠加、Agent A 无 Pong 超时只关闭 A、A 未决任务转 `unknown`，Agent B 仍在线、迟到 Pong 无法复活 A，以及历史业务通信时间不被 Ping/Pong 更新。**隔离 mock 和真实双 Go Agent 旧有 smoke 不能代替真实 NAS 的网络级零流量抓包、认证失效/半开链接浏览器集成和真实 Docker 授权环境。E 组 T-043～T-047 仍为 NOT_RUN，T-045/T-047 的 Docker 子项仍受阻。**

**T-040/T-047 浏览器无 Pong + 内核 TCP 自动化证据（2026-10-12；非 Codex PASS）**：[CI 38188149086](https://github.com/CiBeDerORG/Navloom/actions/runs/38188149086) 和 [CI 38188177991](https://github.com/CiBeDerORG/Navloom/actions/runs/38188177991) 均 **4/4 通过**。Node/Fastify 真 WSS 测试模拟**仍连着但拒发 Pong**的浏览器，验证 sweep 最终回收、另一条首页导航页保持在线、0 页面管理员 Ping 被拒绝。双真实被动 Go Agent 的 Linux 私网 mTLS 集成脚本以 `/proc/net/tcp` / `tcp6` **内核 ESTABLISHED 记录**验证：初始 0 页面 0 TCP；首页 1 页面建立两设备连接；管理员第 2 页面不重复连接；撤销 A 不影响 B；关闭最后一个登录页面后 B 连接为 0 且空闲不自动重连；首页新页面重新连 B、关闭再次为 0。**TCP 连接计数不是包级流量抓取，不代表真实 NAS 抓包完成；半开客户端由 Node ws 模拟而非多端真实浏览器。T-040/T-047 及 E1～E3 状态继续 NOT_RUN，须独立按真实环境及权限矩阵执行后才可判定 PASS。**

**T-040 全局自动模式真实双 Agent 回归（2026-10-12；非独立验收）**：[CI 38188385381](https://github.com/CiBeDerORG/Navloom/actions/runs/38188385381) **4/4 通过**。Linux 隔离环境两台真实被动 Go Agent 的 private mTLS WSS 联调验证：管理员设置 5 秒 `auto` 检测，两条已认证浏览器 WSS（首页导航页 + 管理员页）均收到配置广播，Agent B 自动 Pong 时间更新，两个页面未造成重复 Agent TCP 连接；后台页离开但首页还在线时仍保持连接；最后首页关闭后内核 ESTABLISHED TCP 计数归零，跨越 5 秒完整自动检测周期不自动重连，历史业务通信时间保持且配置仍为 `auto`。**仍须实网抓包确认无任何 Agent↔Server 字节/其他协议通信、真实浏览器跨设备演练和 Codex 独立执行；E 组 T-040/T-047 保持 NOT_RUN。**

**T-036/T-038/T-047 证书用途和 TLS 协议负例（2026-10-12；自动化通过，非 Codex PASS）**：[CI 38188851591](https://github.com/CiBeDerORG/Navloom/actions/runs/38188851591) **4/4 通过**，包含真实双 Go Agent ↔ Node Server 私网反向 mTLS WSS。Go Agent 被动监听的隔离测试覆盖 Server 客户端证书缺失/不受信任、旧协议版本、浏览器 Origin、TLS 1.2 降级、设备 ID 不匹配、重复 WSS 会话拒绝；新增启动时自身 TLS 服务端证书和 pinned Server 客户端证书的 EKU 用途约束（serverAuth / clientAuth 不能错用），若显式 KeyUsage 存在但禁签名则拒绝。原 Server 开发证书不带可选 KeyUsage 扩展，保持兼容且联调通过。**上述仍不取代实网 NAS TLS/证书轮换测试、网络流量抓包和 Codex 独立验收，E 组相应 T-036/T-038/T-047 维持 NOT_RUN。**

**T-044/T-045/T-047 Agent 任务重放与旧会话隔离（2026-10-12；自动化证据，不是 Codex PASS）**：[CI 38189254603](https://github.com/CiBeDerORG/Navloom/actions/runs/38189254603) **4/4 作业通过**。Go Agent 的实际双向 TLS WebSocket 新测试：同一条 WSS 内首次白名单能力探测返回结果；使用同一 `task_id` 但不同 `message_id` 重放，或用同一 `message_id` 而换新 `task_id`，均应返回 WSS 1008 策略违规关闭且不得二次执行。每会话上限 1,024 条任务以限制去重集合内存。Server Node 追加测试：旧 Agent WSS 被新连接替代后，旧未决任务转 `unknown`，其迟到任务结果、Pong 和 close callback 不能改变新会话状态。**会话去重不是跨 WSS 重连/Agent 进程重启的持久化幂等保证；T-055 的 Docker 副作用操作须待单独实现可靠执行记录后才能开放。**真实 NAS、抓包、浏览器多端与 Codex 独立 E 组验收依旧 `NOT_RUN`，不得凭此项 CI 勾选正式任务。
