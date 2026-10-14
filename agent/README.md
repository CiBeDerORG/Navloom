# Navloom Agent · M2 反向按需 WSS（协议 v2）

**当前开发状态**：Go Agent 已具备私网被动 WSS、双向 TLS 固定信任、按页面在线情况启动的 Docker 容器发现、受控启停与短日志读取。连通性检测仅使用 WebSocket Ping/Pong；Docker 扫描/事件通知是另一类业务任务，**仅在至少一个已授权浏览页面在线期间运行**。隔离 CI 已覆盖核心流程，**真实 NAS 和 Codex 独立验收仍未完成**。

> 旧主动连接已移除：没有私网监听端点及 TLS 的旧 Agent 无法正常启动，Server 也不再提供旧 `/agent` 入站。升级需安全重新配对；浏览器和真实 NAS 的独立验收仍待执行，请勿直接暴露公网。

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
  "server_url": "wss://navloom.example.com",
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
- Agent 白名单允许只读 `capability_probe`、`inventory_refresh` 和 `container_logs`；后者最多返回 100 行、每行 512 字节的日志。容器发现通过本机固定 Docker Unix Socket 执行 `GET /containers/json?all=1`，包含停用和先前存在的容器；快照按 20 条分块、原子更新，最多 2000 个容器。
- 只有已认证页面在线时，Server 才会在 Agent 握手完成后执行只读自动容器对账、订阅该 Agent 的本地 Docker 容器事件、定期全量核对；**无页面立即断开 WSS、停止事件订阅/对账，不在后台继续上报**。容器池显示历史快照与过期标记。
- 管理员可显式发起 `container_start` / `container_stop` / `container_restart`（基于已发现、快照不过期的容器），每次须确认；Server 持久化幂等请求键，Agent 在任何 Docker POST 前把任务 ID 和操作记录写入私有 `token_file.operations.jsonl` 并 `fsync`，进程崩溃后不会重复执行该任务。操作结果无法确认时以 `unknown` 保留，**绝不自动重试**。
- **安全警告**：Docker Unix Socket 可以授予近似主机 root 的控制权限。只允许可信管理员及受控内网访问，不把 Socket 暴露到公网；禁用任意 shell、`docker exec`、`compose_deploy`。应用实例登记仅映射已发现的 Compose 项目，不自动安装容器或生成导航卡片。
- **双层防重放**：每条已认证的 Agent WSS 会话记录 `task_id`/`message_id`（最多 1024 条）；额外针对有副作用的容器操作使用持久私有 Journal，跨 WSS 重连及 Agent 重启保留执行认领记录，避免同一个任务再次触发 Docker POST。日志文件必须可安全持久化；损坏或权限不符合要求时启动失败而非降级执行。**防重放仅保证同一任务至多尝试一次，不保证任何不确定的操作一定成功，也不能替代真正的 Docker 事务语义。**
- `-check` 只检查配置的 Server TCP/TLS 可达性，不代表反向 Agent WSS 握手成功。仅显式设置 `allow_insecure_dev: true` 且 Server URL 为回环 `ws://` 时允许不加密配对开发。

构建：`go test ./...`、`./scripts/build-linux.sh`。配置字段参考 [config.example.json](./config.example.json)，新架构与未完成项见 [M2 实施记录](../planning/M2-IMPLEMENTATION.md)。

## M3 · Compose 执行回执和只读远程对账（开发中）

- 本地 Go `internal/deploy` 执行器已经能在隔离 Docker 环境使用固定 Compose 命令，安全记录任务认领、0600 配置文件以及 Docker CLI 的确切退出码。回执另存 0600 JSON、执行结束后 `fsync`。如果 Agent 在执行后、回执落盘前退出，只能报告 `unknown`，**不能假设失败或重试部署**。
- 为现有部署任务启用**只读回执查询**，可在 Agent 配置文件加入 `"deploy_root": "/var/lib/navloom/deployments"`，或通过 `NAVLOOM_AGENT_DEPLOY_ROOT` 指定同一受控目录。目录必须是所在设备自己的绝对路径，权限 0700，由可信部署组件创建；无目录时 Agent 拒绝查询、不会自动执行 Docker。不要把这个根路径指向系统目录、共享数据卷或现有应用目录。
- `compose_status` 是独立、只读的 WSS 命令；通过双向 TLS 认证的 Server 才能请求指定 `install_task_id` 的回执。Go Agent 只返回 `not_found`、`unknown`、`succeeded` 或 `failed` 和持久退出码，不包含 Compose 环境变量、密码或输出日志。
- Server 仅管理员能够调用 `POST /api/v1/admin/install/tasks/:id/reconcile` 发起查询。若没有已登录页面维持 Agent WSS，查询会拒绝而**不会**创建定时拨号/后台轮询。查询一个 `prepared` 草稿也会拒绝；这不是执行任务的入口。完整派发、管理员激活、实时脱敏日志与自动生成导航卡片仍待 M3 后续任务完成。
- **M3 远程安装已提供受限、默认关闭的显式开关**：Server 必须独立配置 `NAVLOOM_ENABLE_REMOTE_INSTALL=1`，并且 Agent 自身也须设置 `enable_compose_deploy: true`（或私有环境变量 `NAVLOOM_AGENT_ENABLE_COMPOSE_DEPLOY=true`）和 0700 的专用 `deploy_root`。管理员必须先加密保存草稿，再进行第二次明确确认。未配置时不得执行 `compose_deploy`；只有经管理员授权的目标设备可以开启。Compose `up -d` 返回码 0 才标记部署成功，不代表 HTTP 可用。状态为 unknown 时**只能先对账，不自动重试**。自动生成唯一应用实例/导航卡片、日志增量脱敏及真正的跨设备正式验收仍未完成。

## 旧版 Agent 升级

旧 v1 主动 WSS 身份文件不能静默升级。先停止旧 Agent，安全备份配置和私有凭据；在 Server 管理后台撤销旧设备。配置新的私网监听 IP/端口，生成 Agent TLS 证书，并安全归档旧身份文件（配对命令拒绝覆盖）。管理员生成新的一次性令牌后执行 `-pair`，再启动新版 Agent。重新配对会建立 v2 协议与双向 TLS 信任；旧设备历史数据不会因为撤销而被删除。

无人浏览页面时 Agent 只监听指定私网端口，不主动向 Server 发请求。管理员明确执行的首次配对或 `-check` 属于单次手动操作。页面意外断开后的回收由 Server 与浏览器之间的在线检测处理，并非 Agent 业务心跳。

**配对强制要求**：当前版本不再允许缺少 `endpoint_host`/`endpoint_port`/Agent TLS 证书与私钥的 `-pair`；Server 也不会接收无端点的配对请求。旧主动 WSS 设备应撤销原有身份并重新安全配对。只有有效首页或管理员页面开启时，Server 才会主动建立 Agent WSS；TLS 握手成功但 v2 hello 未完成的连接不显示「已连接」。
