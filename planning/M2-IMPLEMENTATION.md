# M2 · Agent 接入与容器池（T-036 起架构重做）

> **架构重做决定（2026-10-11）**：用户要求 **T-036～T-059 全部按反向按需 WSS 重新实现和验收**，T-034/T-035 既有身份/令牌成果保留。以下“第二批/第三批”均为**历史旧架构交付记录，不代表新方案已完成**。当前代码仍含 Agent 主动 WSS 和 15 秒业务心跳，替换完成前不可声称满足“0 管理员页面 = 0 Agent↔Server 通信”。

> 状态：**首批安全配对 CI 已通过；第二批 WSS/Go 自动重连/心跳代码已提交，本批 4/4 CI 作业已通过，等待 Codex 独立联调**。M1 回归工作暂时独立保留，不在此阶段改写 M1 验收结论。

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
- **唯一全局管理器**：任何已登录管理员页面（含持管理员会话的首页）都可登记在线，普通首页口令不计入；0→1 建立各 Agent 连接，N→0 关闭全部连接。切换标签页但页面未关闭仍计入。Server 统一合并多个页面，禁止重复连接/探测。
- **唯一 Agent 心跳**：仅使用 WSS Ping/Pong；自动模式的全局间隔可配置，手动模式仅按钮触发。删除旧 JSON heartbeat、Agent 主动定时 Ping、无页面重连和定期 SQLite 心跳写入。浏览器页面在线登记的连接检测与 Agent 心跳不是同一通道。
- **0 页面语义**：无 WSS、无 Ping、无 Agent→Server 轮询、无自动重连、无 Docker 数据上报；保留最后 Agent 状态、能力、容器快照与身份，**不触发下线或注销**。历史结果应标注时间，不能冒充当前实时健康。
- **安全/恢复**：管理员会话与 CSRF/Origin 严格校验；页面异常消失时清理登记；断开时在途任务记为 unknown，不能自动重放可能有副作用的 Docker/Compose 命令；重新进入后进行能力/容器全量对账。
- **交付顺序**：先 T-036 配对/证书/私网端点，再 T-037～T-040 反向 WSS 和页面调度，接着 T-041～T-047 API/UI/任务/双 Agent 回归，最后 T-048～T-059 容器池。所有新验收记录只写入原 `planning/M1-CODEX-REGRESSION.md`。
- **安全约束**：未取得明确授权前，不能访问真实 NAS 或操作真实 Docker。旧实现的 4/4 CI 与 T-035 自动化验收历史保留，但 T-036～T-059 仍全部未按新架构验收。

## T-036 第一批代码：反向连接端点配对元数据（尚未验收）

- 新增 SQLite 迁移 `0004_m2_reverse_endpoint.sql`：每台 Agent 的私网 IP、端口、公开 TLS 证书与 SHA-256 指纹；不存 Agent TLS 私钥。现有设备字段为空，后续必须重新配对/安全迁移才能进入反向 WSS。
- 一次性配对请求可携带经 IP 私网/EasyTier 限制、X.509 有效期和 IP SAN 校验的端点；拒绝公网、域名、回环、错误证书，且不消费无效令牌。Go 配对 CLI 已准备读取配置的 TLS 证书并检查私钥文件权限。
- **这只是 T-036 的基础数据与输入验证**：Agent TLS 证书生成、Server 客户端证书信任、反向 WSS 监听与主动连接尚未实现；旧通信代码仍在，不能宣称零通信目标已经生效。旧配对请求暂时兼容但不具备反向连接端点。

- **T-036 基础代码 CI 证据**：[GitHub Actions 38150454809](https://github.com/CiBeDerORG/Navloom/actions/runs/38150454809) 四项作业通过（Web/Server/SQLite、Go Agent、双 Go↔Node WSS 旧架构回归、Compose 启动）。**只验证目前的增量代码和历史回归，不等于反向 WSS 已实现或 Codex 独立验收通过。**
