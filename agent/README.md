# Navloom Agent（M2 配对阶段）

Go Agent 可使用管理员签发的一次性令牌配对到 Navloom Server。**WSS、心跳、容器发现与 Docker 操作尚未实现**；配对成功只代表获得设备身份，不代表设备在线。

```bash
# 先在 Navloom 管理后台的「应用实例管理」生成 10 分钟有效的一次性令牌。
# 在 Agent 设备上配置 server_url（WSS 地址）和 token_file（本机私密文件路径）。
cd agent
go test ./...
read -r -s -p "一次性接入令牌: " PAIR_TOKEN; echo
printf '%s\n' "$PAIR_TOKEN" | NAVLOOM_SERVER_URL=wss://navloom.example.com/agent \
  NAVLOOM_AGENT_TOKEN_FILE="$HOME/.config/navloom/identity.json" \
  go run ./cmd/navloom-agent -pair
unset PAIR_TOKEN
```

- `-pair` 从标准输入读取令牌，**不接受命令行明文令牌参数**。建议使用 `read -s` 防止终端回显；不要将令牌写入 shell 历史、日志或 Git。
- `token_file` 使用私有目录和 `0600` 权限存储独立 Agent ID + 长期随机凭据，**不会覆盖已有身份文件**。请安全保存该文件，遗失后须撤销旧设备并重新配对。
- `server_url` 必须使用 `wss://`，Go 客户端自动使用同一域名的 `https://.../api/v1/agent/pair` 进行首次配对。仅显式开启 `NAVLOOM_ALLOW_INSECURE_DEV=true` 且使用 loopback 地址时允许 `ws://` 和 HTTP。
- Go HTTP 客户端验证 TLS 证书，不跟随重定向，不在错误日志中输出令牌或设备凭据。
- `-check` 仅检测 TCP/TLS 可达性，**不是** WebSocket 握手。
- 普通启动仍是等待退出信号的骨架；M2 下一批实现 WSS 身份校验、心跳与重连。

配置示例见 [config.example.json](./config.example.json)，跨平台构建使用 `./scripts/build-linux.sh`。
