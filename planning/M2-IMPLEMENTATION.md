# M2 · Agent 接入与容器池（实施中）

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

## 尚未完成与状态纪律

- **T-034**：身份持久化和唯一约束已实现；WSS 重连代码已具备，仍须 Codex 双端联调同一设备 ID 后才能完全验收。
- **T-035**：签发/消费/限流/审计路径已实现，CI 已通过，**已按任务原文验收**。
- **T-036**：Go 配对和安全保存已实现；WSS 重连与未配对拒绝已具备代码，待 Codex 端到端验证。
- **T-041/T-042/T-043**：设备 API/UI 和数据库撤销已开始；在线状态与撤销主动断线已具备代码；T-042 容器池筛选仍依赖 T-053，完整验收待 Codex。
- **T-037～T-040**：WSS、Go 重连、心跳和协议基础已提交，自动化 CI 已通过，等待 Codex 独立联调；T-039 任务消息关联仍依赖 T-044。**T-044～T-059**：任务路由、Docker 发现、容器池、实例与操作尚未实现，不得标记通过。
- Q-09「首次配对流程」仍是**建议**的一次性令牌方案；本轮作为可回滚的实现基线，不能把它写成用户已确认决策。

## Codex 验收统一交接

**所有 M2 验收任务统一记录到原先交给 Codex 的 [M1-CODEX-REGRESSION.md](./M1-CODEX-REGRESSION.md)**（C 组当前代码 6 项，D 组后续 20 项）。该文件同时保留 M1 的 A/B 组回归与统一结果表。此处仅记录实施进度与 CI 证据；不要再另建一份 M2 Codex 验收清单。任务勾选状态仍以 [Agent 任务](./tasks/04-agent.md) 和 [容器池任务](./tasks/05-inventory.md) 为准。

## 下一批顺序

1. Codex 在统一验收文件中验证 T-034/T-036/T-037～T-043 的双 Agent WSS 联调，记录证据。
2. 实现 T-044～T-047 安全任务路由、命令白名单与双 Agent 隔离。
3. 在授权的测试 Docker 环境中实现 T-048～T-059 容器池、事件、实例和受控操作。
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
