# @navloom/contracts

Web 与 Server 共享的 Zod 运行时校验、TypeScript 类型以及 Agent v1 JSON 消息草案。

- `SystemStatusSchema`：M0 唯一公开的 Server 状态接口响应。
- `ApiErrorSchema`：Server 统一错误响应。
- `AgentMessageSchema`：M2 将使用的版本化消息信封与受支持消息类型。**M0 尚未开放 WSS 端点。**

此处是传输层最小契约，不包含 Docker 业务实现。Go 端将按同一 JSON 字段约定编码/解码，并在 M2 添加跨语言契约测试。
