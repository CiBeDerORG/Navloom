# M2 · Agent 接入与容器池（实施中）

> 状态：**首批安全配对代码已提交，CI 三项作业全部通过；真实设备/WSS 联调仍待完成**。M1 回归工作暂时独立保留，不在此阶段改写 M1 验收结论。

## 本轮交付（Agent 安全接入基线）

- SQLite 增量迁移 `0002_m2_agent_pairing.sql`：设备注册时间、唯一凭据摘要、一次性接入令牌及无密钥审计事件；旧数据不覆盖。
- 管理员 API：`POST /api/v1/admin/agents/pair-tokens` 签发 10 分钟有效随机令牌，最多同时 5 枚未用令牌；数据库仅存 SHA-256 摘要。
- 设备配对 API：`POST /api/v1/agent/pair` 校验并**原子消费**令牌，Server 分配 Agent UUID 和独立随机凭据；错误响应不区分不存在/过期/已使用；按请求 IP 限流，记录不含秘密的审计事件。
- 凭据验证基础：`verifyAgentCredential` 检查设备 UUID、凭据摘要和撤销状态，供后续 WSS 连接认证复用。管理员 Cookie/首页 Cookie 均不能代替设备凭据。
- 管理员设备列表、重命名、撤销 API，以及「应用实例管理」内设备登记与一次性令牌 UI。**列表中的未撤销设备当前显示离线**，不伪称在线。
- Go Agent `-pair`：从标准输入读取一次性令牌，WSS URL 自动映射 HTTPS 配对接口；仅回环开发允许非 TLS；禁止 HTTP 重定向；私有 `0600` 身份文件，拒绝覆盖。普通启动仍为未连接的骨架。
- Node 注入测试：管理员授权、CSRF、令牌有效期、一次性消费、失败限流、摘要存储、设备撤销与隔离；Go 单测：配对请求、拒绝重定向、私有身份文件及安全 URL。

## 尚未完成与状态纪律

- **T-034**：身份持久化和唯一约束已实现；仍须 WSS 重连验证同一设备 ID 后才能完全验收。
- **T-035**：签发/消费/限流/审计路径已实现，CI 已通过，**已按任务原文验收**。
- **T-036**：Go 配对和安全保存已实现；待 WSS 重连、未配对拒绝任务的端到端验证。
- **T-041/T-042/T-043**：设备 API/UI 和数据库撤销已开始；在线状态与即时断开连接需要 T-037～T-040 的 WSS 会话管理。
- **T-037～T-040、T-044～T-059**：WSS、心跳、命令路由、Docker 发现、容器池、实例与操作均未实现，不得标记通过。
- Q-09「首次配对流程」仍是**建议**的一次性令牌方案；本轮作为可回滚的实现基线，不能把它写成用户已确认决策。

## Codex 验收统一交接

**所有 M2 验收任务统一记录到原先交给 Codex 的 [M1-CODEX-REGRESSION.md](./M1-CODEX-REGRESSION.md)**（C 组当前代码 6 项，D 组后续 20 项）。该文件同时保留 M1 的 A/B 组回归与统一结果表。此处仅记录实施进度与 CI 证据；不要再另建一份 M2 Codex 验收清单。任务勾选状态仍以 [Agent 任务](./tasks/04-agent.md) 和 [容器池任务](./tasks/05-inventory.md) 为准。

## 下一批顺序

1. WSS 握手与独立 Agent 凭据认证、撤销后即时断开、重复连接策略。
2. Go Agent WSS 重连、心跳、协议版本/消息校验与在线/离线状态。
3. 真实双 Agent 联调后再引入 Docker SDK 容器快照、事件与容器池。
4. 最后接入管理员 Docker 操作、实例/导航关联及 M1 的 M2 阻塞任务。

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
- 此 CI 不代表真实 NAS 上的 WSS/Agent 联调，也不代表 M2 其他任务完成。
