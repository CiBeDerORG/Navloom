# Navloom Agent · M2 反向按需 WSS 迁移中

**当前开发状态**：Go Agent 已具备私网被动 WSS 监听、双向 TLS 客户端证书固定信任和只读能力探测。Server 按已登录页面在线情况主动建立连接；自动/手动连通性检测仅使用 WebSocket Ping/Pong，不发送周期 JSON 心跳。新架构的隔离 Go↔Node mTLS 联调已进入 CI，**尚未完成 Codex 独立验收**。

> 旧配置（没有 `endpoint_host` 的 Agent）暂时仍走历史 Agent 主动 WSS + JSON 心跳路径，Server 也仍接受旧 `/agent` 入站连接。**迁移完成前项目整体不能保证「无登录页面零 Agent 通信」**；请勿把开发版本直接暴露公网。

## 1. 在 Server 创建客户端 TLS 身份

Server 主机上生成一对**客户端身份**（与 Server HTTPS 证书不同）。证书可以交给 Agent，私钥只能留在 Server：

```bash
mkdir -p ./data/agent-tls
openssl req -x509 -newkey ed25519 -nodes -days 365 \
  -keyout ./data/agent-tls/server-client.key \
  -out ./data/agent-tls/server-client.pem \
  -subj "/CN=Navloom Server Agent Client" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "extendedKeyUsage=clientAuth"
chmod 600 ./data/agent-tls/server-client.key
export AGENT_CLIENT_CERT_FILE="$(pwd)/data/agent-tls/server-client.pem"
export AGENT_CLIENT_KEY_FILE="$(pwd)/data/agent-tls/server-client.key"
```

启动 Server 前先执行 `npm run db:migrate`。Server 会校验证书用途、有效期和私钥匹配；密钥不进入配对响应。实际部署需使用持久化、仅 Server 可读取的目录；证书过期/轮换需重新建立信任，**当前没有无感轮换**。

## 2. 在 NAS / Linux Agent 配置私网监听

示例 `agent-config.json`（将 IP、路径和 Server 域名替换为真实值）：

```json
{
  "server_url": "wss://navloom.example.com/agent",
  "agent_name": "nas-1",
  "token_file": "/var/lib/navloom/identity.json",
  "endpoint_host": "10.10.20.30",
  "endpoint_port": 9443,
  "tls_cert_file": "/var/lib/navloom/agent.pem",
  "tls_key_file": "/var/lib/navloom/agent.key"
}
```

`endpoint_host` 必须是 NAS 实际拥有的可信内网/EasyTier IP，不支持公网 IP、DNS 域名、回环地址。**仅在受控内网/覆盖网络开放该端口，不做公网端口映射**。Agent 的 `server_url` 仍用于首次 HTTPS 配对，正常运行不会主动拨号到 Server。

```bash
cd agent
go run ./cmd/navloom-agent -config ./agent-config.json -init-tls
# 在管理后台「应用实例管理」生成 10 分钟有效的一次性令牌
read -r -s -p "一次性接入令牌: " PAIR_TOKEN; echo
printf '%s\n' "$PAIR_TOKEN" | go run ./cmd/navloom-agent -config ./agent-config.json -pair
unset PAIR_TOKEN
go run ./cmd/navloom-agent -config ./agent-config.json
```

- `-init-tls` 生成带私网 IP SAN 的 Agent Ed25519 服务器证书及权限为 `0600` 的私钥，拒绝覆盖已有文件。Agent TLS 私钥永远不发送给 Server。
- `-pair` 从标准输入读取一次性令牌，不接受命令行明文令牌参数；将设备 ID、凭据和 Server **公开客户端证书**保存在私有 `0600` 身份文件，拒绝覆盖。
- 正常启动在指定 IP:端口被动监听 TLS 1.3 WSS `/agent`；只接受配对时固定的 Server 客户端证书，最多一个已认证连接。没有页面时 Agent 不主动发出任何请求或心跳。
- Server 有至少一个已登录导航页/后台页面时按需拨号；多个浏览器共享一条 Agent 连接；管理员可切换自动/手动 Ping/Pong 检测，手动「检测连接」不触发 Docker 任务。
- Agent 仅执行白名单中的只读 `capability_probe`；容器发现、启停、Compose 部署仍未开放。连接成功不代表 Docker 可用。
- `-check` 只检查配置的 Server TCP/TLS 可达性，不代表反向 Agent WSS 握手成功。仅显式设置 `allow_insecure_dev: true` 且 Server URL 为回环 `ws://` 时允许不加密配对开发。

构建：`go test ./...`、`./scripts/build-linux.sh`。配置字段参考 [config.example.json](./config.example.json)，新架构与未完成项见 [M2 实施记录](../planning/M2-IMPLEMENTATION.md)。
