# @navloom/contracts

Web / Server 共享的 Zod 运行时协议与 API 类型。反向按需 WSS 使用 **Agent 协议 v2**：仅在 Server 按已登录页面主动连接后，Agent 发送一次 `hello`；Server 可下发白名单内的显式任务，Agent 只回复 `task_result`。可预留 `inventory_snapshot` 等未来类型，但尚未启用。

**没有 JSON heartbeat**。连通性检测使用 WebSocket Ping/Pong（自动或管理员手动），不改写 SQLite `last_seen_at`。旧 v1 心跳示例已删除；跨语言协议共用 `fixtures/hello.valid.json` 与 `fixtures/hello.invalid-version.json`。
