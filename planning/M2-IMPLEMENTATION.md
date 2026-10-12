# M2 · Agent 接入与容器池（T-036 起架构重做）

> **架构重做决定（2026-10-11）**：用户要求 **T-036～T-059 全部按反向按需 WSS 重新实现和验收**，T-034/T-035 既有身份/令牌成果保留。以下“第二批/第三批”均为**历史旧架构交付记录，不代表新方案已完成**。目前运行路径已移除旧 Agent 主动 WSS、Server /agent 入站及 JSON heartbeat；真实浏览器、异常断线和包级零流量的独立验收仍待执行。

> 当前状态：**反向 WSS v2、双向 TLS 与两台真实 Go Agent 的隔离 CI 已 4/4 通过；Codex 独立及真实 NAS 验收尚未执行**。M1 回归工作暂时独立保留，不在此阶段改写 M1 验收结论。

## 本轮交付（Agent 安全接入基线）

- SQLite 增量迁移 `0002_m2_agent_pairing.sql`：设备注册时间、唯一凭据摘要、一次性接入令牌及无密钥审计事件；旧数据不覆盖。
- 管理员 API：`POST /api/v1/admin/agents/pair-tokens` 签发 10 分钟有效随机令牌，最多同时 5 枚未用令牌；数据库仅存 SHA-256 摘要。
- 设备配对 API：`POST /api/v1/agent/pair` 校验并**原子消费**令牌，Server 分配 Agent UUID 和独立随机凭据；错误响应不区分不存在/过期/已使用；按请求 IP 限流，记录不含秘密的审计事件。
- 凭据验证基础：`verifyAgentCredential` 检查设备 UUID、凭据摘要和撤销状态，供后续 WSS 连接认证复用。管理员 Cookie/首页 Cookie 均不能代替设备凭据。
- 管理员设备列表、重命名、撤销 API，以及「应用实例管理」内设备登记与一次性令牌 UI。**列表中的未撤销设备当前显示离线**，不伪称在线。
- Go Agent `-pair`：从标准输入读取一次性令牌，WSS URL 自动映射 HTTPS 配对接口；仅回环开发允许非 TLS；禁止 HTTP 重定向；私有 `0600` 身份文件，拒绝覆盖。普通启动仍为未连接的骨架。
- Node 注入测试：管理员授权、CSRF、令牌有效期、一次性消费、失败限流、摘要存储、设备撤销与隔离；Go 单测：配对请求、拒绝重定向、私有身份文件及安全 URL。

## 第二批交付：WSS 安全通信与在线状态（待独立验收）

- Server `/agent`：独立 Agent UUID、`Authorization: Bearer` 长期随机凭据和协议版本三重校验，错误身份在 WebSocket 升级前拒绝；首页/管理员 Cookie 不能充当设备凭据。
- WebSocket 64 KiB 帧上限、JSON/Zod 严格协议校验；当前只接受 `hello` 和 `heartbeat`，拒绝未实现的 Docker/Compose/任意 shell 命令。
- 同一 Agent 的新连接替换旧连接；心跳超时判定离线；更新 SQLite `last_seen_at` 与版本；撤销设备主动断开 WSS。管理员设备列表/详情返回 `online/offline/revoked`，Web 设备页每 10 秒轮询。
- Go Agent 普通启动读取 `0600` 身份文件，WSS 校验 TLS，发送 `hello` 和 15 秒心跳，断线指数退避重连，收到退出信号优雅断开；不把长期凭据放 URL 或日志。
- 新增 Node WSS 集成测试及 Go `httptest`：错误凭据/版本、双 Agent 隔离、重复连接、撤销、超时、非法消息、过大帧、TLS 拒绝、自动重连与关闭。
- 使用 `@fastify/websocket`、`ws`、`gorilla/websocket`，依赖锁文件已由一次性 CI 工作流生成；临时工作流已删除。
- **安全边界**：生产 HTTP Server 仅监听回环地址，经可信 HTTPS/WSS 反向代理暴露 `/agent`；不能将明文 HTTP 端口直接开放公网。配对成功或 Agent 在线均不代表 Docker 可用。
- **验收纪律**：本批实现不等于通过验收；全部步骤只更新 [原 Codex 统一回归文件](./M1-CODEX-REGRESSION.md) 的 C/D 组，保留 Codex `NOT_RUN` 直至实际测试。
- [CI 38144150805](https://github.com/CiBeDerORG/Navloom/actions/runs/38144150805) **4/4 作业通过**，新增 `scripts/smoke-m2.mjs` 在隔离环境启动两台真实 Go Agent ↔ Node WSS，验证在线、断线重连、持久身份、撤销与隔离；这不等于 Codex 独立验收。

## 第三批交付：T-044～T-047 安全任务通道与能力探测（待 Codex）

- 新增迁移 `0003_m2_agent_tasks.sql`：`agent_tasks` 按设备记录任务 ID、发送时间、deadline、结果和状态；`agent_capabilities` 持久化最近一次 Docker/Compose 能力探测及时间，旧 M1/M2 表不被覆盖。
- Server 仅可向已认证且完成 `hello` 的指定 Agent 下发**只读** `capability_probe`。管理员可调用 `POST /api/v1/admin/agents/:id/capability-probe` 和 `GET /api/v1/admin/agent-tasks/:id`；所有接口仍受管理员会话、CSRF/Origin 保护。Agent 完成 `hello` 时自动执行一次只读探测。
- 任务 `task_id` 与 `agent_id` 严格匹配；重复结果幂等；断线/超时/Server 重启时将未决任务标为 `unknown` 而**非 `failed`**，允许同设备迟到结果关联，但不自动重放可能有副作用的命令。
- 共享协议明确 `capability_probe`、`inventory_refresh`、`container_start/stop/restart`、`compose_deploy` 的参数白名单；**当前只有 `capability_probe` 可执行**，其他操作尚无执行器/管理 API。Go 拒绝未知、伪造或带多余字段的任务，不运行任意 Shell；Server 对拒绝消息写无敏感内容的审计事件。
- Go Agent 只读探测本地 Unix Socket 的 Docker API `/_ping` 与 `/version`，以及固定参数的 `docker compose version --short`；拒绝远程 `DOCKER_HOST`，返回 `socket_missing`、`permission_denied` 等明确原因，绝不以在线代替 Docker 可用。
- 管理员「应用实例管理」显示 Docker/Compose 能力、最近探测时间、不可部署原因和手动刷新按钮。即使基础能力存在，**部署入口仍未开放**，容器不会自动创建导航卡片。
- 自动化测试：Node 双 Agent 定向任务、错误身份、重复/迟到结果、超时未知状态、拒绝审计；Go 严格任务解析、隔离 Unix Socket/Compose CLI stub；真实两台 Go 进程↔Node Server 能力探测及持久化回归。
- [CI 38144954055](https://github.com/CiBeDerORG/Navloom/actions/runs/38144954055) **4/4 通过**；后续安全审计与超时用例已追加，最新 CI 仍须以 GitHub Actions 结果为准。
- **Codex 验收只写入 [原统一文件](./M1-CODEX-REGRESSION.md) D5～D8**，不可凭代码或 CI 勾选 T-044～T-047；T-045/T-047 的 Docker 执行子项仍需 T-055，T-046 真实 Docker 环境须明确授权。

## 尚未完成与状态纪律

- **T-034**：身份持久化和唯一约束已实现；WSS 重连代码已具备，仍须 Codex 双端联调同一设备 ID 后才能完全验收。
- **T-035**：签发/消费/限流/审计路径已实现，CI 已通过，**已按任务原文验收**。
- **T-036**：Go 配对和安全保存已实现；WSS 重连与未配对拒绝已具备代码，待 Codex 端到端验证。
- **T-041/T-042/T-043**：设备 API/UI 和数据库撤销已开始；在线状态与撤销主动断线已具备代码；T-042 容器池筛选仍依赖 T-053，完整验收待 Codex。
- **T-037～T-040**：WSS、Go 重连、心跳和协议基础已提交，自动化 CI 已通过，等待 Codex 独立联调；T-039 任务消息关联仍依赖 T-044。**T-044～T-047**：安全任务、命令白名单、只读 Docker/Compose 探测和双 Agent 隔离代码已提交，Codex 未独立验收；**T-048～T-059**：容器发现、容器池、实例与操作尚未实现，不得标记通过。
- Q-09「首次配对流程」仍是**建议**的一次性令牌方案；本轮作为可回滚的实现基线，不能把它写成用户已确认决策。

## Codex 验收统一交接

**所有 M2 验收任务统一记录到原先交给 Codex 的 [M1-CODEX-REGRESSION.md](./M1-CODEX-REGRESSION.md)**（C 组当前代码 6 项，D 组 8 项已提交安全代码 + 12 项尚未实现）。该文件同时保留 M1 的 A/B 组回归与统一结果表。此处仅记录实施进度与 CI 证据；不要再另建一份 M2 Codex 验收清单。任务勾选状态仍以 [Agent 任务](./tasks/04-agent.md) 和 [容器池任务](./tasks/05-inventory.md) 为准。

## 下一批顺序

1. Codex 在统一验收文件中验证 T-034/T-036/T-037～T-043 的双 Agent WSS 联调，记录证据。
2. Codex 按 D5～D8 验证 T-044～T-047 已提交的安全子集，记录只读探测与双 Agent 结果。
3. 在**明确授权**的测试 Docker 环境中实现 T-048～T-059 容器池、事件、实例和受控操作，补齐 T-045/T-047 的完整验收。
4. 解除 M1 T-028～T-031/T-033 的容器关联验收阻塞。

## 开发验证

```bash
npm ci
npm run build
npm run typecheck
npm run lint:ts
npm run test:server
npm run db:migrate
npm run db:migrate
npm run test:go
```

使用本地独立数据库，不要将配对令牌、设备凭据、数据库或真实 NAS Docker 信息提交到 Git。

## 自动化验收证据

- [CI 38142225822](https://github.com/CiBeDerORG/Navloom/actions/runs/38142225822)：Web + Server + SQLite、Go Agent、Local Docker Compose startup **3/3 成功**。
- [CI 38144150805](https://github.com/CiBeDerORG/Navloom/actions/runs/38144150805)：Web + Server + SQLite、Go Agent、Local Docker Compose startup、M2 Go-to-Node WSS integration **4/4 成功**。双 Go Agent 真实进程联调在临时 SQLite/回环网络进行。
- 上述 CI 不代表真实 NAS 或生产 TLS 反向代理验收，也不代表 M2 其他任务完成。

## T-036～T-059 新架构实施边界（2026-10-11 确认）

- **连接方向**：Server 是 WSS 客户端，Agent 是仅监听可信内网/EasyTier 地址的 WSS 服务端；NAS 不暴露公网。配对是管理员显式触发的单次 HTTPS 注册，不是后台轮询。
- **认证**：配对建立设备 ID 与双向 TLS 证书/公钥信任；Server 只连接经过地址校验与证书绑定的端点，Agent 只接受已配对 Server；证书轮换需要明确流程，旧凭据不能自动降级使用。
- **唯一全局管理器**：任何持有效管理员会话或首页访问口令凭据的已登录页面（含普通导航页）都可登记在线，未登录/仅打开登录界面的页面不计入；0→1 建立各 Agent 连接，N→0 关闭全部连接。切换标签页但页面未关闭仍计入。Server 统一合并多个页面，禁止重复连接/探测。
- **唯一 Agent 心跳**：仅使用 WSS Ping/Pong；自动模式的全局间隔可配置，手动模式仅按钮触发。删除旧 JSON heartbeat、Agent 主动定时 Ping、无页面重连和定期 SQLite 心跳写入。浏览器页面在线登记的连接检测与 Agent 心跳不是同一通道。
- **0 已登录页面语义**：无 WSS、无 Ping、无 Agent→Server 轮询、无自动重连、无 Docker 数据上报；保留最后 Agent 状态、能力、容器快照与身份，**不触发下线或注销**。历史结果应标注时间，不能冒充当前实时健康。
- **安全/恢复**：页面登记须验证首页访问凭据或管理员会话；首页凭据仅能触发连接，不能读取 Agent 管理数据、修改探测配置或下发 Docker 任务；管理操作仍需管理员会话与 CSRF/Origin 严格校验；登出/凭据失效/页面异常消失时清理登记；断开时在途任务记为 unknown，不能自动重放可能有副作用的 Docker/Compose 命令；重新进入后进行能力/容器全量对账。
- **交付顺序**：先 T-036 配对/证书/私网端点，再 T-037～T-040 反向 WSS 和页面调度，接着 T-041～T-047 API/UI/任务/双 Agent 回归，最后 T-048～T-059 容器池。所有新验收记录只写入原 `planning/M1-CODEX-REGRESSION.md`。
- **安全约束**：未取得明确授权前，不能访问真实 NAS 或操作真实 Docker。旧实现的 4/4 CI 与 T-035 自动化验收历史保留，但 T-036～T-059 仍全部未按新架构验收。

## T-036 第一批代码：反向连接端点配对元数据（尚未验收）

- 新增 SQLite 迁移 `0004_m2_reverse_endpoint.sql`：每台 Agent 的私网 IP、端口、公开 TLS 证书与 SHA-256 指纹；不存 Agent TLS 私钥。现有设备字段为空，后续必须重新配对/安全迁移才能进入反向 WSS。
- 一次性配对请求可携带经 IP 私网/EasyTier 限制、X.509 有效期和 IP SAN 校验的端点；拒绝公网、域名、回环、错误证书，且不消费无效令牌。Go 配对 CLI 已准备读取配置的 TLS 证书并检查私钥文件权限。
- **这只是 T-036 的基础数据与输入验证**：Agent TLS 证书生成、Server 客户端证书信任、反向 WSS 监听与主动连接尚未实现；旧通信代码仍在，不能宣称零通信目标已经生效。旧配对请求暂时兼容但不具备反向连接端点。

- **T-036 基础代码 CI 证据**：[GitHub Actions 38150454809](https://github.com/CiBeDerORG/Navloom/actions/runs/38150454809) 四项作业通过（Web/Server/SQLite、Go Agent、双 Go↔Node WSS 旧架构回归、Compose 启动）。**只验证目前的增量代码和历史回归，不等于反向 WSS 已实现或 Codex 独立验收通过。**

### 页面在线范围补充（2026-10-11）

**连接条件已由“管理员页面在线”修正为“任一已登录页面在线”**。普通用户输入首页口令并进入导航页、已登录管理员进入后台或首页，任一页面都可使全局连接计数从 0 变为 1；只打开未登录的导航口令输入界面或管理员登录界面不算在线。首页访问凭据仅授予导航访问与页面在线登记，不授予 Agent 配置、任务或设备管理权限。浏览器保留有效 Cookie 但没有打开页面时不计数；最后一个已登录页面关闭/注销/失效时关闭 WSS 并冻结最后状态。多个标签页和设备仍只运行一套 Server 连接与 Ping/Pong 调度器。

## T-036 后续增量：TLS 密钥生成与 Server 客户端证书交换

- Agent 新增 `-init-tls`，为配置的私网 IP SAN 生成 Ed25519 自签名服务器证书与 0600 私钥，已有文件不可覆盖。配对前验证证书与私钥匹配、证书用途/有效期/IP SAN。
- Server 新增可选 `AGENT_CLIENT_CERT_FILE`/`AGENT_CLIENT_KEY_FILE`：校验客户端证书用途、私钥权限、密钥配对；当 Agent 注册反向 WSS 端点时必须配置这对凭据，配对响应只返回 Server 客户端**公开证书**，绝不返回私钥。Agent 将其保存为身份文件中的固定信任证书。
- **阶段限制**：T-036 仍待完成真实双向 TLS 联调；Agent 被动 WSS 监听、Server 主动连接与全局页面在线调度尚未完成，旧 Agent 主动连接路径暂存，不能声称新通信架构已生效。

## T-038 第一批代码：被动 Agent WSS 监听（尚未验收）

- 当配置 `endpoint_host`/`endpoint_port` 时，Go Agent 改为在可信私网/EasyTier IP 上监听 TLS 1.3 WSS `/agent`，**不主动连接、心跳或重连**。仅接受配对时固定信任的 Server 客户端证书（精确 DER 匹配），检查 Agent ID 和协议版本；不接受浏览器 Origin；每台 Agent 最多一个已认证 WSS；收到任务时只执行现有只读能力探测；Server Ping 由 WebSocket 协议自动回复 Pong。
- 未配置反向端点的旧 Agent 暂时走旧连接路径，待 T-037/T-040 完整迁移后删除；因此**项目整体尚未达到零通信目标**。Server 主动 WSS 客户端和全局已登录页面调度仍待开发。

- Go 被动 WSS 隔离测试覆盖无客户端证书/伪造证书拒绝、错误 Agent ID 拒绝、重复 WSS 拒绝、只读任务回传、Ping/Pong 和无周期 JSON heartbeat；通过本地 TLS 测试服务，不连接真实 NAS。

## T-037 第一批代码：Server 私网 WSS 主动拨号器（尚未接入页面生命周期）

- 新增 `server/src/realtime/agent-dialer.ts`：仅在显式 `setActive(true)` 时为未撤销且已配置端点的 Agent 建立 WSS；对目标做私网 IP、端口、证书 SAN/有效期/指纹二次校验，使用 Server TLS 客户端身份并严格校验 Agent 服务端证书；禁止重定向，禁止同 Agent 重复拨号。
- `setActive(false)` 会终止建立中与已建立的连接。**目前暂未接入 app.ts、未实现首页口令授权导航页与管理员页面的全局在线登记（T-040）**，因此不能声称运行态已经自动按页面连接。此增量只是 Server 主动拨号基础模块；后续还须替换旧 AgentHub 业务心跳和旧 /agent 入站路由，并完成真实 Go↔Node mTLS 联调。

## T-036/T-037/T-038 增量 CI 记录（2026-10-11）

- [GitHub Actions 38154719616](https://github.com/CiBeDerORG/Navloom/actions/runs/38154719616)：**4/4 通过**（Go Agent、Web + Server + SQLite、旧 Go→Node WSS 集成回归、Compose 启动）。新增 Go 被动 mTLS WSS 隔离测试覆盖证书校验、单连接、只读任务和 Ping/Pong；Server 主动拨号器的私网/无页面拒绝单测通过。
- **不等于新架构端到端验收**：目前 Server 主动拨号器尚未接入全局页面在线机制，旧 WSS 入站/主动连接路径尚未清除；真实 Go 被动 Agent ↔ Node 主动 Server 双向 TLS 联调仍需执行。T-036～T-059 的 Codex 状态继续 NOT_RUN。

## T-039/T-040 增量：全局页面在线与唯一 Ping/Pong 检测（尚未独立验收）

- 新增 `0005_m2_page_presence.sql`，全局 `manual/auto` 和 `interval_ms` 设置写入 SQLite（默认手动、30 秒；自动 5～300 秒）。管理员 GET/PATCH `/api/v1/admin/agents/probe-settings`、POST `/api/v1/admin/agents/probe`；手动检测仅发送 WSS Ping，不会下发 Docker 能力任务。设置变更通过已认证页面 WS 广播至各浏览器。
- `/api/v1/presence` 浏览器 WebSocket 必须具备有效首页或管理员 Cookie，并验证同源 Origin；Server 全局管理已登录页面集合，首个页面触发 Agent 主动拨号，最后一个页面离开时立即终止 Agent 连接、自动 Ping 和重连定时器；后台标签页仍计入。浏览器异常断开由 Server→浏览器 Ping/Pong 和定时鉴权检测处理；该通道与 Agent WSS 分离。
- Server `AgentHub` 为反向会话新增仅 Ping/Pong 探测，Pong 不写 SQLite，手动模式无定时 Agent Ping；旧主动会话暂保持旧行为，避免在未完成新双端联调前破坏旧回归。反向 Agent 收到 hello 不再自动下发能力探测任务。Agent 掉线后只在页面在线期间指数退避重连；配对新 Agent 时仅在已有在线页面下触发连接。
- Web 在已解锁导航页和已登录后台建立页面 WS，登录界面不登记，页面路由变化/注销时释放；后台「应用实例管理」新增自动/手动间隔设置与「检测连接」按钮。开发 Vite WS 代理已启用。
- **限制**：旧 `/agent` Agent 主动接入和旧 Agent 无端点回退路径仍存在，故尚未全面达成「无人在线零 Agent 通信」；需先完成新 Go 被动 Agent ↔ Node 主动 Server 的双向 TLS 实机/隔离端到端联调，再移除旧路径并重做旧集成测试。新页面登记/探测也未经过 Codex 独立验收。

## T-036～T-040 反向 mTLS 端到端 CI 证据（2026-10-11）

- [GitHub Actions 38155682480](https://github.com/CiBeDerORG/Navloom/actions/runs/38155682480)：**4/4 作业通过**，其中 `scripts/smoke-m2-reverse.mjs` 在 CI runner 的隔离私网接口上启动**真实 Go 被动 Agent**、**真实 Node 主动 Server**，由 OpenSSL 创建 Server mTLS 客户端证书、Go CLI 生成 Agent 私钥/证书并一次性配对，验证「无页面不连接」「首个管理员页面建立 WSS」「Ping/Pong 不更新 SQLite last_seen_at」「管理员手动只读任务成功」「首页+管理员两页共享连接」「最后页面离开停止通信」「页面重新打开恢复连接」。
- 这条 CI 同时运行旧主动 WSS 两 Agent 回归，以便迁移期间发现兼容性回归。**不等于旧路径已移除，不等于真实 NAS 环境或 Codex 独立验收**；E 组 T-036～T-059 仍全部 `NOT_RUN`。
- 下一步优先移除旧 Server `/agent` 入站和 Agent 无反向端点时的主动 WSS 回退，并将旧集成测试替换为新架构的双 Agent/撤销/重连/异常断开回归；随后验证 0 页面严格无 Agent 网络流量和异常浏览器退出的有限探测延迟。

## T-037～T-047 旧路径退役与双 Agent v2 联调（2026-10-12）

- [CI 38159332832](https://github.com/CiBeDerORG/Navloom/actions/runs/38159332832) **4/4 通过**：Node/Web/SQLite、Go、开发 Compose、真实 Node Server ↔ 两台被动 Go Agent 的私网 mTLS 联调。
- 删除旧 Go 主动 WSS 客户端及测试、Server `/agent` 入站路由、旧主动双 Agent 冒烟脚本；Agent 没有反向监听端点时直接拒绝正常启动，不再回退旧模式。
- Agent 信封协议升级为 v2；删除 Go/TypeScript 的 JSON heartbeat、旧 v1 心跳 fixtures，改用版本化 hello 和显式任务结果。Server 唯一 Ping/Pong 只检查 WSS 连接，不周期写 SQLite。
- 集成 CI 覆盖：仅普通首页口令导航页也能激活两台 Agent；多个已登录页面共享连接；管理员手动 Ping 不写最近通信时间；A/B 只读任务隔离；B 停止/重启而 A 不受影响；A 撤销后不再重连；最后页面关闭后冻结最近状态；新页面进入可恢复未撤销设备；旧 `/agent` Server 路由返回 404。
- 旧主动式设备须停止服务、备份并归档旧身份文件、撤销旧设备后按新反向 mTLS 重新配对，详见 `agent/README.md`。
- **不得误标验收**：本 CI 不等于真实 NAS 抓包、浏览器交互或 Codex 独立验收，异常关闭页面的回收时间、证书轮换及容器操作仍需按 T-036～T-059 正式验证。

## T-036 强制反向端点配对、T-041/T-042 设备连接视图（2026-10-12）

- **配对安全收口**：新的 `POST /api/v1/agent/pair` 必须提交有效的私网/EasyTier IP、端口、Agent 服务端证书，Server 端必须配置客户端 mTLS 身份；不能再以旧兼容模式省略端点创建永远不能建立反向连接的设备。Go `-pair` 同样在发起请求前拒绝没有反向端点的配置。证书额外检查非 CA、有效期、IP SAN 与 ServerAuth 用途。一次性令牌对无效请求不消费。
- **设备观测**：管理员 Agent 列表/详情新增固定证书是否配置、Endpoint Host/Port、当前会话 hello 握手状态、本次连接开始时间、最近一次收到 WSS Pong 的时间；Pong 仅保留进程内的实时信息，Server 重启/连接关闭后不伪造历史 Ping，`last_seen_at` 继续只保留已发生的业务通信记录。
- **hello 安全超时**：Node Server 在建立 Agent WSS 后要求 8 秒内收到合法 v2 `hello`；没有收到就拒绝会话并允许页面在线期间按原策略重连，避免只完成 TLS 的静默设备无限占用连接。新隔离测试验证超时、审计记录和 Pong 时间。
- **界面改进**：应用实例管理显示私网端点、TLS 是否固定信任、握手状态、最近一次 Pong 与历史业务时间；配对说明明确一次性 Server URL 只用于配对，正常连接为 Server 主动 WSS。
- **阶段门槛**：自动化测试并非 Codex 独立验收；仍需真人浏览器多端交互、NAS 实网、异常页面离线、TLS 轮换和零页面包级网络检验。T-036～T-059 继续不得提前勾选。

## T-040～T-042 补充：异常页面回收与跨后台页面共享控件（2026-10-12）

- `PagePresence` 保持生产默认每 15 秒检查浏览器在线鉴权/Ping，连续无 Pong 超过 45 秒回收；新增仅由测试启动参数注入的计时器配置，便于在隔离环境快速覆盖页面凭据撤销和异常关闭。零页面仍关闭 Server→Agent WSS、取消自动 Agent Ping 和重连；浏览器保活 Ping 不属于 Agent 业务心跳。
- 新增 Server 回归：普通导航页与管理员页面同时在线时撤销首页凭据，只回收前者；管理员退出后最终归零；无关闭握手的浏览器进程断开回收；零页面的管理员 Ping API 返回 409。管理员首页有效性由既有 `GET /api/v1/auth/home/status` 同时识别管理员会话，不需要第二套登录检查。
- 把检测模式/间隔/手动按钮从 `AdminInstancesView` 提升为公共 `AdminShell` 中的 `AgentProbeControls.vue`：导航页管理、应用实例管理、安全设置均可修改同一条 SQLite 全局配置。组件只操作已有管理员 API、通过现有浏览器页面 WS 接收配置广播，**不建立另一条 Agent WSS 或第二个全局心跳调度器**。普通首页口令导航页仍只登记在线，不取得任何管理权限。
- 相关提交：`bdd6c995`、`41d643db`、`ab4ee4a4`、`c6288a13`、`5a448669`、`c890f2cd`。自动化验证以当前 main SHA 对应的 CI 结果为准，**Codex 独立验收和真实网络抓包依旧 NOT_RUN**，不可因新增测试或页面就勾选 T-040～T-042。

## T-043～T-047 安全子集补强（2026-10-12；待独立验收）

- **任务结果校验**：`AgentTasks.acceptResult` 不再对任何已完成的 task_id 无条件回报成功。只有与已持久化 payload **结构一致**的重复结果才幂等接受；冲突成功/失败/能力结果返回拒绝，Hub 将按协议违规关闭相应连接并记录无秘密审计。Agent 撤销后，包括原本合法任务的迟到结果，均不能再写入任务或能力快照；其他 Agent 的结果不受影响。
- **断开/超时/重启**：隔离 Node 测试增加 A/B task_id 定向隔离、同设备任务发送去重、断连后 `unknown`、未撤销设备迟到结果关联、deadline 过期 `unknown`、Server 新实例构建时把未完成 `sent` 迁移为 `unknown`，并确认**不重新投递**旧命令。
- **唯一 Ping/Pong 超时**：Hub 维持生产默认 10 秒 Pong 超时，新注入参数仅供隔离测试模拟无 Pong 的 Agent；待定 Ping 不叠加，A 超时后只关闭 A、A 未决任务转 `unknown`，B 仍在线且其任务不变；迟到 Pong 不能让已断开的 A 复活；Ping 不修改 SQLite 历史业务时间。
- 对应文件：`server/src/realtime/agent-tasks.ts`、`server/src/realtime/agent-hub.ts`、`server/src/m2-task-recovery.test.ts`、`server/src/m2-pong-timeout.test.ts`。代码及回归不等于真实 NAS 抓包、真实 Docker 操作或 Codex 独立 PASS；原任务复选框保持不变。

## T-040/T-047 半开浏览器与零页面 TCP 连接证据（2026-10-12，非 Codex PASS）

- [CI 38188149086](https://github.com/CiBeDerORG/Navloom/actions/runs/38188149086) **4/4 通过**：`m2-presence.test.ts` 使用真实浏览器 WSS 客户端模拟**TCP/WebSocket 保持连接但不自动回应 Pong**的半开页面；缩短的 sweep/Pong 超时仅在隔离测试配置中生效。Server 在有限时间回收该页面，不影响另一条仍有 Pong 的首页访问凭据页面；最后一个正常页面关闭后 activePages 归零，管理员手动 Ping API 返回 409。
- [CI 38188177991](https://github.com/CiBeDerORG/Navloom/actions/runs/38188177991) **4/4 通过**：真实 Node Server 与两台 Go 被动 Agent 的 Linux 隔离集成脚本增加读取 `/proc/net/tcp`/`tcp6` 的 ESTABLISHED 连接计数。验证初始 0 页面两 Agent 没有已建立 TCP 连接、单个首页页面建立连接、加开管理员页面**不重复建立**、撤销 Agent A 后仅 A 的连接消失、关闭管理员后首页仍保持 B 连接、最后首页关闭后 B 的 TCP 连接也消失且空闲期间无自动重连、重新打开普通导航页后 B 可建立连接、再次关闭归零。检查的是**实际内核 TCP 状态而非 API 的 paused 文本标签**。
- 生产默认仍为每 15 秒浏览器存在性 sweep、无 Pong 超过 45 秒回收；Agent Pong 超时 10 秒；未新增第二套 Agent 心跳。**TCP ESTABLISHED 数归零不能取代真实 NAS 环境的网络抓包/所有协议零包结论。**Web 浏览器跨端交互、实网网络抓包、证书轮换及 Codex 独立验收仍待执行；T-036～T-047 不提前勾选。

### 全局自动检测模式的两页面联调（2026-10-12）

- [CI 38188385381](https://github.com/CiBeDerORG/Navloom/actions/runs/38188385381) **4/4 通过**。在两台真实 Go 被动 Agent、首页访问口令导航页与管理员页面同时在线的反向 WSS 集成流程中，管理员 PATCH 将全局检测切换为 `auto` / 5000ms；首页页面和管理员页面均收到同一 `probe_settings` WS 广播，随后 Agent B 按设置产生新的 Pong 观测时间。
- 两页面仍仅对应一条到 Agent B 的内核 TCP 连接；关闭管理员页面后普通导航页维持 WSS；关闭最后的导航页后 Agent B 的 ESTABLISHED TCP 连接归零。等待**超过整个 5 秒自动 Ping 周期**仍为 0，历史业务时间不改变，持久的 `auto` 配置不因无人在线而抹除。重新打开普通导航页按需恢复连接。
- 本验证在隔离 Linux CI 上完成，支持**一套全局自动/手动管理、无页面不保持 Agent TCP 连接**的实现判断，但不代替真实 NAS 抓包、非 TCP 通道审计及 Codex 独立验收；任务清单保持待验收。

## T-036/T-038/T-047 TLS 目的约束与降级拒绝（2026-10-12）

- Go 被动 Agent 在启动时显式校验自己持有的 TLS 证书具备 `serverAuth` EKU、受配置的私网 IP SAN、非 CA、有效期和符合 TLS 签名的 KeyUsage；对配对时固定信任的 Server 客户端公开证书检查 `clientAuth` EKU、非 CA、有效期及签名用途。符合 X.509 规范：**KeyUsage 扩展缺省允许**，但若明确存在且禁止数字签名则拒绝；原 CI 中不包含 KeyUsage 扩展的 OpenSSL Server 客户端证书可继续工作。
- 扩充 Go 被动 mTLS 测试：合法 pinned 客户端证书对比缺失/伪造证书、旧 v1 协议头、浏览器 Origin、TLS 1.2 降级均被拒绝；有效证书可完成 WSS 和既有 Ping/Pong、只读任务。独立测试刻意为 Agent 签发含正确 IP SAN 却只有 `clientAuth` 的证书，以及有 `serverAuth` 却明确禁止签名的证书，均要求在启动前拒绝。Server pinned 客户端证书如果只有 `serverAuth` 同样拒绝。
- 相关改动：`agent/internal/transport/server.go` 和 `server_test.go`。这些为隔离 CI 安全测试，不涉及真实 NAS/运行中 Docker。需以对应 GitHub CI 成功结果作为自动化证据；Codex 独立验收、实网证书轮换与网络包级零通信仍为 `NOT_RUN`。

## T-044/T-045/T-047 Agent 防重放与旧会话隔离（2026-10-12；尚未独立验收）

- [GitHub Actions 38189254603](https://github.com/CiBeDerORG/Navloom/actions/runs/38189254603) **4/4 通过**：Go Agent、Web/Server/SQLite、开发 Compose、真实双 Go 被动 Agent↔Server 反向 mTLS WSS 集成均通过。
- **Agent 接收侧防重放**：Go 被动 `/agent` 会话在成功验证 v2 任务信封后，检查本会话的 `task_id` 与 `message_id` 去重集合；相同 ID 不重复执行只读 `capability_probe`，直接发 WSS policy violation 关闭帧；每个会话最多接受 1,024 个任务以防无限内存占用。新的 Go TLS WebSocket 回归分别使用不同 message_id 重放 task_id，以及使用不同 task_id 重放 message_id，验证首个任务成功而第二个被拒绝。
- **Server 新旧会话隔离**：新增 Node 回归覆盖同一 Agent 的新会话替换旧连接时，将旧未决任务视为 `unknown`，旧连接的结果、Pong、close callback 不得修改新会话、任务状态或能力快照。Go 和 Server 验证不产生新的周期性 Agent 心跳。
- **重要限制**：Agent 去重集合仅维持在**单条 WSS 会话内**，断开或进程重启后失效。当前只执行只读探测；将来 T-055 开放 `container_start/stop/restart`、Compose 等副作用命令前，须设计并验收持久化去重/执行记录与明确的断连结果恢复规则，绝不能把本阶段的会话去重宣传为跨重启 exactly-once。真实 NAS 网络抓包、浏览器与 Codex 独立验收仍未完成，T-044/T-045/T-047 保持 `NOT_RUN`。

## T-048～T-059 容器池完整功能代码联通（2026-10-12，自动化阶段）

在继续保留 T-034～T-047 反向按需 WSS 架构和 **0 页面无 Agent↔Server 通信** 前提下，已新增以下实现：

- **T-048/T-049/T-051**：Go Agent 使用限定 Docker Unix Socket 的固定只读 HTTP API `GET /containers/json?all=1` 一次列举启动前已存在、运行中与已停止容器（不依赖 Agent 启动后的事件）。采集容器 ID、名称、镜像、规范化状态/端口、仅允许的 Compose project/service labels（不上传其他 Docker labels）。最多 2,000 个容器，按 20 条一段发送严格 v2 `inventory_chunk`，Server 验证 Agent ID、task_id、顺序/总数并使用单事务替换快照；断线、失败、重复/越权片段不覆盖旧快照。记录独立全量扫描时间和 count。实现出于安全最小化使用 Docker Unix HTTP 协议而非引入 Docker SDK，接口与 Docker API 兼容。
- **T-050**：仅在至少一个有效页面在线的 WSS 生命周期内，Go Agent 订阅本地 Docker `/events`，对 container create/start/stop/die/destroy/rename/pause/unpause/restart/update 变更发通知；Server 1 秒防抖后发起只读全量校正。另按全局管理员可配置（30 秒至 1 小时）的间隔进行全量核对；首次连接也全量扫描；最后页面离开后取消事件监听、对账定时器与所有 Agent WSS。**已知容器事件先按 Agent/容器 ID 增量修正状态或删除记录，再经 Server 防抖进行全量核对，新增容器及端口/名称仍由扫描补齐。Agent 不再以全局 500ms 节流丢弃快速连续事件；事件发生时如旧扫描未结束，会在旧扫描结束后再安排一次新扫描，避免 pending 去重吞掉对账。仍需大量容器与实际网络的压力验收。**
- **T-052～T-054**：管理员 `/admin/containers` 支持 Agent、状态、来源、名称/镜像搜索、分页与详情；`/admin/agent-inventory` 返回快照时间、容器数、实时/历史/过期标志；`AdminInstancesView` 内有响应式容器池、扫描、来源筛选和空状态。0 页面历史数据保持不变，不向首页自动推送。
- **T-055**：管理员对已发现且 5 分钟内快照未过期的单个容器显式确认才可提交 `container_start/stop/restart`。Server 保存幂等 UUID 与任务、旧请求只返回旧 task_id，不重发；Agent 仅固定 Docker Unix Socket 的 POST `/containers/{hexId}/{start|stop|restart}`，先在私有 `token_file.operations.jsonl` 中持久认领任务并 fsync。断连/进程崩溃未能确认结果保留 `unknown`，**不自动重试**；绝无容器删除、任意 shell、Docker exec 或未经审计的 Compose 部署。受控操作只在管理员明确触发时发生；隔离测试不接触真实 NAS/Docker。
- **T-056/T-057**：已有 `app_instances` 模型配合新增管理员实例列表/详情/登记/取消登记 API。稳定关联 Agent ID + Compose project（跨容器重建）；发现外部容器不会自动登记。管理员可手动关联现有 Compose 项目，`template_id=external` 的记录仍视为外部来源。取消目录登记不会停止/删除 Docker 容器。
- **T-058**：管理员可请求单个已发现容器最近最多 100 行、每行不超 512 字节、请求/响应有超时与总大小上限的只读日志。Agent 解析 Docker 非 TTY multiplex 日志头，尽量遮盖常见 password/token/API key/Bearer 格式。日志任务与结果限定到同一 Agent，按 task_id/sequence 持久存储；不在浏览器后台持续跟随日志。
- **T-059**：`agent/internal/probe/inventory_test.go`、`control_test.go`、`events_test.go`、`transport/journal_test.go` 和 `server/src/m2-inventory.test.ts`、`m2-container-operations.test.ts` 覆盖隔离 Unix Docker API（包括启动前已存在与停止容器）、秘密 label 过滤、管理员权限、A/B 隔离、原子快照/空快照、快照过期、Compose 关联、幂等键冲突/跨重启不重复下发、日志绑定与限量、基本动作路径/非法命令拒绝。页面可从容器池**手动填写访问 URL**生成导航卡片，绝不推测地址或修改 Docker。

**阶段边界**：CI 是自动化代码回归，不是 Codex 独立验收。真实 NAS 的 Docker 权限、跨设备首页/WSS 生命周期、Docker 大规模事件与日志、TLS 轮换、包级 0 页面通信以及真实容器启停与重建验证仍不能伪称 PASS。T-048～T-059 现有代码功能覆盖不等于任务验收状态为完成，验收复选框保留待执行；未获取真实 NAS 或运行中 Docker 的操作授权。

## 2026-10-12 T-050 事件并发与对账修复（自动化证据，非独立验收）

- **连续事件不丢失**：移除 Go `WatchDockerEvents` 全局 500ms 静默节流，`events_test.go` 新增同一容器 rapid start/stop 与另一容器 destroy 的完整有序通知测试；Server 仍对高成本全量扫描做每 Agent 1 秒防抖。提交 `d703ad8`、`f4844bd`；[CI 38210360821](https://github.com/CiBeDerORG/Navloom/actions/runs/38210360821) **4/4 通过**。
- **扫描中事件不被旧任务吞并**：`AgentTasks.hasPendingInventoryRefresh` 检测正在执行的扫描；Server 的 Docker 事件重对账会在旧扫描完成后重新派发，直到连接结束或任务过期。`m2-inventory.test.ts` 模拟 event 与旧扫描竞态、旧扫描完成后新任务独立发送，以及最后一个页面退出时停止派发、未决任务转 `unknown`。提交 `e669371`、`fe52c0f`、`4fd54b0`；[CI 38210779521](https://github.com/CiBeDerORG/Navloom/actions/runs/38210779521) **4/4 通过**。
- **并发竞争检测纳入 CI**：Go Agent 工作流除常规单测外执行 `go test -race ./internal/probe ./internal/transport`，针对本地 Docker 事件读取与 Agent WSS 传输的现有测试启用数据竞争检测。提交 `6672080`；[CI 38210899055](https://github.com/CiBeDerORG/Navloom/actions/runs/38210899055) **4/4 通过**。
- **边界**：以上都是隔离自动化，不是 Go 事件高负载压测、真实 NAS、实际 Docker 容器重建、跨设备浏览器或包级零通信抓包。T-050/T-059 及相关 E 组复选框保持未验收，不将 CI 绿色视为完整 M2 PASS。
