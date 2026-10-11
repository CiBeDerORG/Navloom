# Navloom

**Navloom** 是面向个人自托管场景的导航优先应用平台。首页只展示用户编排的导航卡片；云端 Server 管理导航、应用实例与多个设备 Agent。Agent 将来负责发现 Docker 容器及执行 Docker Compose 部署。M2 正在从旧 Agent 主动 WSS/JSON 心跳迁移到 Server 按已登录页面主动连接 Agent 的私网双向 TLS WSS；容器池尚未实现。

> **当前状态：M0 已完成；M1 导航与双层访问控制已实现首批功能，正在验证与完善。M2 反向 WSS、私网 mTLS、已登录页面在线调度和手动/自动 Ping/Pong 已有代码及隔离 CI 联调；旧 Agent 主动接入路径尚未删除，Codex 独立验收尚未完成。容器池和 Docker 管理尚未实现，生产部署与完整安全审查在 M4。当前版本仅用于本地开发。**

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `web/` | Vue 3 + TypeScript + Vite，Tailwind CSS 4、shadcn-vue 组件约定 |
| `server/` | Fastify + TypeScript、SQLite + Drizzle ORM |
| `agent/` | Go Agent，设备端独立程序（M0 仅配置与连接可达性检测） |
| `packages/contracts/` | Web/Server 共享 API 类型与 Zod 运行时 Schema；Agent JSON 协议 v1 草案 |
| `apps/` | 可信应用模板目录（M3 实现） |
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

当前已提交反向私网 mTLS WSS、全局已登录页面按需连接和 Ping/Pong 设置、只读 Docker/Compose 能力探测；配对后还需正常启动 Agent，且至少一个已登录页面在线才会建立反向连接。旧主动连接路径尚未移除。设备详情显示能力与不可用原因，可手动刷新。容器池和实际容器操作仍未实现；「在线」不代表「Docker 已可用」。

### Go Agent

```bash
cd agent
go test ./...
go run ./cmd/navloom-agent -version
NAVLOOM_SERVER_URL=wss://example.com/agent go run ./cmd/navloom-agent -check
```

`-check` **只检测目标地址的 TCP/TLS 可达性**，不是 WebSocket 握手，也不会注册 Agent；WSS、配对、心跳和 Docker 操作属于 M2/M3。运行 `go run ./cmd/navloom-agent` 会启动仅等待退出信号的 M0 骨架，并明确提示未接入服务端。配置示例见 `agent/config.example.json`。

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

- Server 可经可信 LAN/EasyTier 私网主动连接被动监听的 Agent；Agent 不暴露公网。旧 Agent 主动 WSS 代码仍待删除，迁移完成前不可宣称零页面零通信。
- **导航卡片独立于容器/应用**，删除导航不会操作 Docker。
- Compose `up` 退出码 0 定义为“部署成功”，不等于健康或网页可达。
- M1 已提供首页只读导航和管理员认证/导航管理 API，未提供 Agent 或 Docker 操作 API。
- 首页 Cookie 只能读取导航；所有管理 API 必须具有独立管理员会话及 CSRF 保护。
- 真实密码、Agent 令牌、数据库和环境文件不得提交到 Git。

完整范围、待确认决策与任务：[planning/PRD.md](./planning/PRD.md)、[planning/DECISIONS.md](./planning/DECISIONS.md)、[planning/tasks/01-foundation.md](./planning/tasks/01-foundation.md)。
