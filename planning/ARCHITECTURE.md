# Navloom v1 技术架构与职责边界

> 记录已在讨论中确定的技术基线；细节属于建议设计，不代表已经实现。

## 1. 技术栈

| 层级 | 技术 | 说明 |
| --- | --- | --- |
| Web | Vue 3、TypeScript、Vite | SPA，导航首页和管理后台 |
| UI | Tailwind CSS 4、shadcn-vue | 可定制界面 |
| Server | Node.js、TypeScript、Fastify | **固定部署在云端** |
| 数据 | SQLite、Drizzle ORM | 单 Server，事务和迁移 |
| Agent | Go | Linux / FNOS 等设备端独立二进制 |
| 传输 | WSS + 版本化 JSON | Agent 主动连接，双向消息 |
| Docker | Docker Go SDK | Agent 发现/控制容器 |
| 部署 | Docker Compose v2 | Agent 执行应用安装 |
| 模板 | YAML + JSON Schema | 元数据、参数与默认导航 |
| 网络 | EasyTier | 现有跨设备传输，不承担认证 |
| 发布 | Docker Compose + Caddy | Server HTTPS；Agent 独立发布 |

## 2. 系统职责

### Web

- 访问首页前的弱口令验证、导航浏览、搜索。
- 管理员登录；导航编辑、容器池、Agent、应用目录、任务日志。
- 不直接连接 Docker，也不直接持有 Agent 长期凭据。

### Server（Fastify）

- 认证与会话、导航 API、应用模板目录。
- SQLite 数据、任务持久化、导航创建事务。
- Agent 注册、认证、在线状态、消息路由与结果接收。
- 从 Agent 接收容器快照，供管理后台查询。
- **不执行设备上的 Docker/Compose 操作**。

### Agent（Go）

- 主动建立 WSS、心跳、重连、接收授权任务。
- 使用 Docker SDK 发现、启动、停止、重启容器。
- 使用 Compose v2 执行可信模板生成的部署。
- 回传进度、日志、退出码和最终结果。
- 在本地持久化或可恢复地识别已执行任务，防止重放。

## 3. 核心对象及关系

- NavigationGroup 1:N NavigationCard。
- NavigationCard 可无关联；可关联 AppInstance 或 ContainerInventory 记录。
- Agent 1:N ContainerInventory、AppInstance、InstallTask。
- AppInstance 1:N 容器（通过 Compose project/service 等稳定标识关联）。
- InstallTask 记录模板版本、Agent、参数引用、导航草稿、状态与结果。
- HomeAccessCredential 与 AdminSession 完全独立；两者都不能代替 Agent 凭据。

**不变量**：删除卡片不删除容器；外部发现容器不自动成为受管实例；Compose 退出码 0 不代表健康；任务重复不生成第二张卡片。

## 4. Agent 消息协议建议

每条消息建议包含：
- protocol_version：协议版本。
- message_id：消息唯一标识。
- type：register、heartbeat、inventory_snapshot、task_dispatch、task_log、task_result 等。
- agent_id：Agent 身份。
- task_id：任务相关消息必填。
- sent_at：发送时间。
- payload：按消息类型进行 Schema 校验。

设计原则：
1. Agent 只连接预配置的 Server；WSS 证书校验不可关闭。
2. 首次配对后持有独立凭据，可撤销；通信双方验证身份。
3. Server 仅下发已定义的操作，不接受任意 Shell 命令文本。
4. 每次执行必须校验任务 ID、参数与模板来源。
5. 断线后先对账任务状态，再决定是否重试。
6. 不以 WebSocket 已送达作为任务已完成的证据。

## 5. 数据与事务边界

- SQLite 使用 WAL、数据库迁移、唯一索引和定期备份。
- 管理员凭据、首页长期通行凭据和 Agent 凭据分开存储、可独立撤销。
- 任务创建、结果落库和导航生成应可恢复、可幂等。
- 关键唯一约束建议覆盖：Agent 身份、任务 ID、Agent + Compose project（根据部署策略）、任务生成的导航卡片。
- 容器池是设备实际状态的快照，不是用户声明的安装记录。
- 任务日志需要对敏感参数进行脱敏。

## 6. 交付边界

建议采用单仓库：
- web/：Vue SPA。
- server/：Fastify API 与任务调度。
- agent/：Go Agent。
- packages/：前后端共享类型/Schema（Agent 协议需跨语言约定）。
- apps/：可信应用模板（待确认来源）。
- deploy/：云端部署与 Agent 安装。
- planning/：本规划资料。

此结构是**建议**，实际工程目录可在 T-001 确定。不得将未定的容器池展示模式或模板来源写死在基础协议中。
