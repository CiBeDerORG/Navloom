# @navloom/contracts

Web 与 Server 共享的 Zod 运行时校验、TypeScript 类型以及 Agent v1 JSON 消息草案。

- `SystemStatusSchema`：M0 唯一公开的 Server 状态接口响应。
- `ApiErrorSchema`：Server 统一错误响应。
- `AgentMessageSchema`：M2 将使用的版本化消息信封与受支持消息类型。**M0 尚未开放 WSS 端点。**
- `fixtures/heartbeat.valid.json` 和 `heartbeat.invalid-version.json`：Go 与 TypeScript 共用的跨语言契约测试样例。

Go Agent 的 M0 协议实现目前只构造/严格校验 heartbeat 示例，其他消息类型待 M2 按同一契约实现。这里不包含 Docker 业务逻辑。
