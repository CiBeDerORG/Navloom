# M0 工程初始化 · 实施与验收记录

> 日期：2026-10-11 · 状态：**T-001～T-008 全部完成** · 仅表示工程基础通过验收，不表示 Navloom 的 M1～M4 业务功能已实现。

## 1. 代码交付

| 任务 | 结果 | 主要位置 |
| --- | --- | --- |
| T-001 Monorepo | npm workspaces、Node 22/npm 10、Go 1.24、统一目录和文档 | `package.json`、`README.md`、`web/`、`server/`、`agent/`、`packages/` |
| T-002 Fastify | 启动、统一错误结构、404、Server 自身状态接口、优雅退出 | `server/src/app.ts`、`server/src/index.ts` |
| T-003 Vue Web | Vue 3 + TS + Vite + Tailwind 4、shadcn-vue 配置、首页/管理占位路由 | `web/`、`web/components.json` |
| T-004 Go Agent | 配置文件/环境变量、版本、结构化日志、退出信号、TLS 可达性检查、Linux 双架构构建 | `agent/` |
| T-005 契约 | Web/Server 共用 Zod Schema、Agent v1 消息草案、Go/TS heartbeat JSON fixture 交叉测试 | `packages/contracts/`、`agent/internal/protocol/` |
| T-006 SQLite | Drizzle Schema、初始 SQL 迁移、WAL/外键/忙等待、唯一约束及迁移幂等测试 | `server/src/db/`、`server/drizzle/` |
| T-007 本地环境 | 环境示例、忽略真实密钥、Vite API 代理、Docker Compose 本地开发与真实启动检查 | `.env.example`、`.gitignore`、`compose.dev.yml` |
| T-008 CI | TypeScript/Vue 构建与类型检查、ESLint、Server/DB 测试、Go gofmt/测试/双架构构建、HTTP/Compose smoke | `.github/workflows/ci.yml` |

依赖通过 `package-lock.json` 锁定，开发和 CI 使用 `npm ci`。

## 2. 自动化验收证据

**GitHub Actions：** [M0 验收工作流（3 个 Job 全部成功）](https://github.com/CiBeDerORG/Navloom/actions/runs/38139083401)

- **Web + Server + SQLite**：`npm ci`、全仓构建、Vue/TS 类型检查、ESLint、Fastify/协议/SQLite 单测、迁移连续执行两次、Web/Server HTTP 启动检查、Compose 配置语法检查。
- **Go Agent**：gofmt、Go 测试、Linux amd64/arm64 构建、版本输出及 Server 不可达时的明确错误退出。
- **Local Docker Compose startup**：真正执行 `docker compose -f compose.dev.yml up -d`，等待并验证 Web 与 Server HTTP 端点，结束时清理容器与卷。

CI 证明构建与开发环境基础流程可运行。**未进行人工桌面/移动端视觉审查**；UI 细节与可访问性完整验收属于 M4 的 T-098。

## 3. 开发启动

```bash
git clone https://github.com/CiBeDerORG/Navloom.git
cd Navloom
npm ci
npm run db:migrate
npm run dev
```

Web：http://localhost:5173；Server：http://127.0.0.1:3000/api/v1/system/status。

也可以：

```bash
docker compose -f compose.dev.yml up
```

Agent 独立运行：

```bash
cd agent
go test ./...
go run ./cmd/navloom-agent -version
```

`-check` 只检查 TCP/TLS，不是 WSS 握手或 Agent 注册。

## 4. 未实现范围与安全提示

- **M1 未开始**：首页弱口令、浏览器长期凭据、管理员登录、导航卡片 CRUD 均尚未实现。
- **M2 未开始**：Agent WSS 注册/认证/心跳、Docker SDK 容器发现和操作尚未实现。
- **M3 未开始**：模板安装、Compose 部署任务、实例管理和成功自动导航尚未实现。
- **M4 未开始**：生产 Docker Compose + Caddy HTTPS、完整端到端安全/兼容性与发布验收尚未实现。
- 当前管理路由只有占位内容且**未受认证保护**；仅供本地开发，**不得公开部署到互联网**。
- Server 的 `/api/v1/system/status` 是 Server 自身状态接口，**不是**被安装应用的健康检查；v1 仍不做应用健康检查。
- 初始数据库模型为后续模块预留字段，不表示对应 API 或业务行为已经完成。

## 5. 下一步

按照 [ROADMAP](./ROADMAP.md) 进入 **M1（T-009～T-033）**：先实现管理员初始化与首页弱口令，再实现独立导航卡片、分组、排序和管理界面。Agent 关联功能在 M2 补齐。
