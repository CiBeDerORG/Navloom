# Navloom

**Navloom** 是面向个人自托管场景的导航优先应用平台。首页只展示用户编排的导航卡片；云端 Server 管理导航、应用实例与多个设备 Agent。Agent 将来负责发现 Docker 容器及执行 Docker Compose 部署。

> **当前状态：M0 工程脚手架。尚未实现首页弱口令、管理员认证、Agent WSS 通信或真实容器管理。不可作为已完成的生产服务部署到公网。**

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
npm install
npm run build:contracts
npm run db:migrate
npm run dev
```

- Web： http://localhost:5173
- Server 状态接口： http://127.0.0.1:3000/api/v1/system/status
- 开发模式中 Vite 将 `/api` 代理到本地 Server。
- 初次启动的 SQLite 文件为 `server/data/navloom.db`，已在 Git 中忽略。
- **M0 中的后台页面只是无数据的占位页，未实现认证。不要把 M0 部署到公网。**

### 开发 Docker Compose

```bash
docker compose -f compose.dev.yml up
```

此模式使用单个 Node 开发容器启动 Web + Server；Agent 在宿主设备上单独运行。生产部署将在 M4 添加 Caddy/HTTPS。

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
npm run test:server       # Fastify 与协议契约测试
npm run db:migrate        # 应用 SQLite 迁移（可重复运行）
npm run lint:go           # Go gofmt 检查
npm run test:go           # Go 单元测试
npm run build:agent       # 构建 Linux Agent（当前平台 Go 编译）
```

## 数据与安全边界

- Server 只运行在云端；Agent 将来通过独立认证的 WSS 主动连接，EasyTier 仅提供网络连通性。
- **导航卡片独立于容器/应用**，删除导航不会操作 Docker。
- Compose `up` 退出码 0 定义为“部署成功”，不等于健康或网页可达。
- M0 只提供 Server 自身状态接口；不提供管理员或 Docker 操作 API。
- 真实密码、Agent 令牌、数据库和环境文件不得提交到 Git。

完整范围、待确认决策与任务：[planning/PRD.md](./planning/PRD.md)、[planning/DECISIONS.md](./planning/DECISIONS.md)、[planning/tasks/01-foundation.md](./planning/tasks/01-foundation.md)。
