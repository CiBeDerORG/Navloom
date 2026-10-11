# Navloom Agent（M0）

独立 Go 程序，未来部署在 NAS/FNOS/Linux 设备上；Server 固定在云端。M0 只包含配置解析、TLS 安全限制、可达性检查、日志、版本输出与优雅退出。

```bash
cd agent
go test ./...
go run ./cmd/navloom-agent -version
NAVLOOM_SERVER_URL=wss://navloom.example.com/agent go run ./cmd/navloom-agent -check
```

`-check` 仅测试 TCP/TLS 连接，**不执行 WebSocket 握手**；在 M2 Server WSS 端点实现前，不表示 Agent 已注册或在线。

配置：
- `-config path/to/agent.json`：可选 JSON 文件，格式见 `config.example.json`。
- `NAVLOOM_SERVER_URL`：WSS URL，必填（可由 JSON 配置提供）。
- `NAVLOOM_AGENT_NAME`：设备显示名称。
- `NAVLOOM_AGENT_TOKEN_FILE`：未来用于存储独立设备凭据（M0 尚未读取）。
- `NAVLOOM_ALLOW_INSECURE_DEV=true`：仅允许本机回环地址的 `ws://`，不能用于远程地址。

```bash
./scripts/build-linux.sh
```

生成 Linux amd64/arm64 静态二进制到 `agent/bin/`。M2 再引入 WSS 配对、心跳与 Docker Go SDK；M3 再实现 Compose 安装。
