# Navloom

**Navloom** 是面向个人自托管场景的导航优先应用平台。首页只展示用户编排的导航卡片；云端 Server 管理导航、应用实例与多个设备 Agent。Go Agent 已实现按需 Docker 容器发现与受控启停/日志；M3 正在实现可信模板与安全的远程 Compose 部署。Server 仅在有已登录页面在线时建立主动私网双向 TLS WSS（协议 v2），无人在线时停用 Agent 通信。

> **当前状态：M0 已完成；M1 主要功能已实现、仍待逐项验收；M2 反向 WSS、私网 mTLS、页面在线调度、真实 Docker/Compose 容器池已在隔离 Runner 自动化通过，但仍待 Codex 对真实 FNOS/NAS/跨设备网络完成正式验收；M3 正在开发可信模板、可编辑导航草稿与加密待部署任务。M3 已提供受限、双端独立显式开关下的单次远程 Compose 派发；默认关闭，自动导航闭环与实机验收仍待完成。生产部署与完整安全审查在 M4。**

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `web/` | Vue 3 + TypeScript + Vite，Tailwind CSS 4、shadcn-vue 组件约定 |
| `server/` | Fastify + TypeScript、SQLite + Drizzle ORM |
| `agent/` | Go 被动 mTLS WSS、Docker 发现/事件、受控容器操作；M3 安装执行器开发中 |
| `packages/contracts/` | Web/Server 共享 API 类型与 Zod 运行时 Schema；Agent JSON 协议 v2 |
| `templates/builtin/` | M3 内置审查版 YAML 应用模板（单服务/多服务） |
| `deploy/` | 部署资料（M4 实现生产部署） |
| `planning/` | [PRD、架构、路线图、114 项任务](./planning/README.md) |

## 环境要求

- Node.js **22 LTS**，npm **10+**（npm workspaces）
- Go **1.24+**（仅 Agent 开发/构建）
- SQLite 通过 Server 内置驱动运行，无需另起数据库服务
- 可选：Docker Engine + Compose v2（用于开发容器，**不是**当前 Agent 的应用部署功能）

## 本地开发

```bash
git clone https://github.com/CiBeDerORG/Navloom.git
cd Navloom
npm ci
npm run build:contracts
npm run db:migrate
# 在 Server 本机一次性初始化管理员与首页口令（见下文）
npm run dev
```

- Web： http://localhost:5173
- Server 状态接口： http://127.0.0.1:3000/api/v1/system/status
- 开发模式中 Vite 将 `/api` 代理到本地 Server。
- 初次启动的 SQLite 文件为 `server/data/navloom.db`，已在 Git 中忽略。
- **M1 中首页、管理后台与导航 API 已接入认证，但尚未完成生产 HTTPS/反向代理配置和完整安全审查。不要直接暴露公网。**

### 首次管理员初始化（M1）

先执行 `npm run db:migrate`，再在 **Server 主机终端** 运行以下命令。输入时不会回显口令，也不会把密码放进命令行参数：

```bash
read -r -p "管理员用户名: " NAVLOOM_ADMIN_USERNAME
read -r -s -p "管理员密码（至少 12 位）: " NAVLOOM_ADMIN_PASSWORD; echo
read -r -s -p "首页访问口令（至少 4 位）: " NAVLOOM_HOME_PASSPHRASE; echo
export NAVLOOM_ADMIN_USERNAME NAVLOOM_ADMIN_PASSWORD NAVLOOM_HOME_PASSPHRASE
npm run admin:init -w @navloom/server
unset NAVLOOM_ADMIN_PASSWORD NAVLOOM_HOME_PASSPHRASE NAVLOOM_ADMIN_USERNAME
```

该示例适用于 Bash 终端；初始化只允许执行一次，不能覆盖已有管理员。首页默认需要弱口令；浏览器验证后使用长期 HttpOnly Cookie 记住权限。管理员账号密码独立，点击首页「管理后台」后登录。管理员可在后台辅助「设置」中修改口令和撤销浏览器凭据。

使用 Docker 开发环境时，需在容器内运行迁移与管理员初始化，或者让 CLI 连接相同的 SQLite 数据文件。生产初始化、Caddy/HTTPS 与备份说明将在 M4 提供。

### 开发 Docker Compose

```bash
docker compose -f compose.dev.yml up
```

此模式使用单个 Node 开发容器启动 Web + Server；Agent 在宿主设备上单独运行。生产部署将在 M4 添加 Caddy/HTTPS。

### M2 Agent 安全配对（当前可用）

管理员登录「应用实例管理」，点击「生成一次性接入令牌」；该令牌 10 分钟内有效，只能使用一次。Go Agent 使用 `-pair` 从标准输入读取令牌，成功后在设备本地私有文件中保存独立身份凭据。具体命令见 [agent/README.md](./agent/README.md)。

已提交反向私网 mTLS WSS、全局已登录页面按需连接和 Ping/Pong 设置、Docker/Compose 能力探测、容器池快照/事件以及管理员受控启停/日志。配对后需启动 Agent，且至少一个有效登录页面在线才建立连接；设备显示在线并不表示 Docker 已可用。M2 仍待真实多设备独立验收。

### M3 可信模板与加密安装草稿（开发中）

管理员打开「应用实例管理」后，可浏览内置可信模板，选择已在线且 Docker/Compose 可用的 Agent，填写参数并编辑将来生成的导航名称、图标、分组和实际 URL。单纯预览**不落库、不调用 Docker**；预检包含架构、能力新鲜度、库存时间和已发现容器端口的冲突检查，不能保证部署时端口一定空闲。

预检通过后，可以选择“加密保存待部署草稿”；任务状态为 **prepared（未执行）**，不会主动派发 Agent，也不会安装/更新容器。保存此草稿需要 Server 运行环境提供外部 **NAVLOOM_INSTALL_KEY**（32 字节随机值、标准无填充 base64url 编码）；没有密钥时拒绝保存并返回 503，不会回退到明文。密钥应通过容器/主机秘密管理安全注入，与 SQLite 数据库一起备份并妥善保管，**不要提交 Git、粘贴聊天、放入公开环境示例或打印到应用日志**。丢失此密钥将无法解密已保存的安装参数。

管理员可在双端私有配置都明确启用后，从后台对已保存草稿再次确认并一次性派发受限 Compose 安装；默认仍关闭。派发不是成功，任务结果以 Agent 持久退出码为准，未知状态绝不自动重试。**任务日志的增量脱敏和成功后的唯一应用实例/导航卡片事务尚未完成；绝不能将保存草稿等同部署成功。**开发进度与任务依赖见 [M3 实施记录](./planning/M3-IMPLEMENTATION.md)。

**M3 单次远程部署安全开关**：需要由设备管理员分别在 Server 私有运行环境配置 `NAVLOOM_ENABLE_REMOTE_INSTALL=1`，并在被授权的 Agent 私有配置中设置 `enable_compose_deploy: true` 和 0700 专属 `deploy_root`。不开启时，模板浏览、加密草稿保存和只读历史回执查询仍可独立使用；任何预览/页面访问均不会自动安装。管理员还需在应用实例管理中对某条草稿二次确认，任务才会被认领并通过既有 mTLS WSS 单次派发；失败/断线后不可自动重试。上线前必须完成正式授权环境中的 NAS 验收。详细边界见 [M3 实施记录](./planning/M3-IMPLEMENTATION.md)。

### Go Agent

```bash
cd agent
go test ./...
go run ./cmd/navloom-agent -version
NAVLOOM_SERVER_URL=wss://example.com/agent go run ./cmd/navloom-agent -check
```

`-check` **只检测目标地址的 TCP/TLS 可达性**，不是 WebSocket 握手，也不会注册 Agent；反向 WSS 和配对属于 M2，普通启动必须明确配置私网监听端点与身份，不再支持旧主动连接。配置示例见 `agent/config.example.json`。

## 常用命令

```bash
npm run build             # 构建 contracts -> server -> web
npm run typecheck         # TypeScript / Vue 类型检查
npm run lint:ts           # ESLint
npm run format:check      # Prettier
npm run test:server       # Fastify、认证、导航与协议契约测试
npm run db:migrate        # 应用 SQLite 迁移（可重复运行）
npm run lint:go           # Go gofmt 检查
npm run test:go           # Go 单元测试
npm run build:agent       # 构建 Linux Agent（当前平台 Go 编译）
```

## 数据与安全边界

- Server 通过可信 LAN/EasyTier 私网按已登录页面主动连接被动监听的 Agent；Agent 不暴露公网。隔离 Runner 零页面原始 TCP 报文测试已经通过，真实跨家庭 EasyTier 抓包仍待独立验收。
- **导航卡片独立于容器/应用**，删除导航不会操作 Docker。
- Compose `up` 退出码 0 定义为“部署成功”，不等于健康或网页可达。
- M1 已提供首页只读导航和管理员认证/导航管理 API；M2 提供管理员 Agent 与受控 Docker API。M3 的受限远程 Compose 安装必须经管理员显式确认及 Server/Agent 双端独立开启，默认禁止；导航自动创建仍待验收。
- 首页 Cookie 只允许读取导航并登记页面在线；设备管理、探测设置和 Docker API 仍要求管理员会话及 CSRF 保护。
- 真实密码、Agent 令牌、数据库和环境文件不得提交到 Git。

完整范围、待确认决策与任务：[planning/PRD.md](./planning/PRD.md)、[planning/DECISIONS.md](./planning/DECISIONS.md)、[planning/tasks/01-foundation.md](./planning/tasks/01-foundation.md)。
