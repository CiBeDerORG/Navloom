# Navloom Server（M1 导航 + M2 Agent 安全接入开发版）

Fastify 5 + TypeScript + SQLite + Drizzle ORM。Server 固定在云端，**不执行 Docker 命令**。

## 首次启动

在仓库根目录：

```bash
npm ci
npm run build:contracts
npm run db:migrate
# 按根目录 README 的安全输入步骤设置 NAVLOOM_ADMIN_USERNAME、
# NAVLOOM_ADMIN_PASSWORD、NAVLOOM_HOME_PASSPHRASE
npm run admin:init -w @navloom/server
npm run dev:server
```

首次管理员初始化**只能在 Server 本机通过 CLI 完成**，不会提供公开注册接口。CLI 需要管理员用户名（3～64 位，小写字母/数字/下划线/点/连字符）、管理员密码（至少 12 位）和首页弱口令（至少 4 位）。已初始化时会拒绝覆盖。管理员密码和弱口令只保存 scrypt 密码哈希，令牌只保存 SHA-256 摘要。

默认 SQLite 路径：`server/data/navloom.db`。如指定 `DATABASE_URL`，**迁移、初始化和 Server 启动必须使用相同的路径**。迁移文件位于 `server/drizzle/`，迁移可以重复执行；Server 启动不会自动迁移。

## M1 HTTP API

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v1/system/status` | 公开 Server 自身状态 |
| GET | `/api/v1/auth/home/status` | 公开首页访问状态 |
| POST | `/api/v1/auth/home/unlock` | 验证首页弱口令，签发长期 Cookie |
| GET | `/api/v1/home/navigation` | 首页 Cookie 或管理员会话 |
| GET | `/api/v1/auth/admin/session` | 查询管理员会话状态 |
| POST | `/api/v1/auth/admin/login` | 管理员账号密码 |
| POST | `/api/v1/auth/admin/logout` | 退出当前管理员会话 |
| PATCH | `/api/v1/admin/settings/password` | 修改管理员密码并撤销会话 |
| PATCH | `/api/v1/admin/settings/home-passphrase` | 修改首页口令并撤销旧凭据 |
| POST | `/api/v1/admin/settings/home/revoke` | 撤销全部已记住的浏览器 |
| GET | `/api/v1/admin/navigation` | 管理员读取分组/卡片 |
| POST/PATCH/DELETE | `/api/v1/admin/navigation/groups[/:id]` | 管理员分组 CRUD |
| POST/PATCH/DELETE | `/api/v1/admin/navigation/cards[/:id]` | 管理员卡片 CRUD |
| PUT | `/api/v1/admin/navigation/order` | 管理员持久化分组/卡片排序 |

所有修改请求必须带 `X-Navloom-CSRF: 1` 请求头，存在 Origin 时还须与请求 Host 一致。浏览器请求由 Web 客户端自动携带此头。没有开放跨域 CORS。Cookie 使用 HttpOnly + SameSite=Lax；在 `NODE_ENV=production` 时加 Secure（**生产必须通过 HTTPS 访问**）。开发 HTTP 仅限本地。

首页凭据有效期采用十年滑动窗口（剩余不足九年时轮换）；管理员会话七天有效。首页口令修改或管理员手动撤销后，旧首页凭据立即失效。管理员修改密码会撤销全部管理员会话。登录失败有内存限流；当前设计为单 Server 实例，不适用于多实例横向扩容。

## M1 限制

- 已实现独立导航卡片/一级分组、搜索、排序、编辑和权限隔离。
- 容器池/实例关联卡片功能依赖 M2，尚未接入。
- WSS Agent 认证、只读任务与 Docker/Compose 能力探测已提交；Docker SDK 容器池、Compose 安装与生产 Caddy 部署尚未实现。
- M1 尚需浏览器交互、移动端视觉及完整安全验收；**禁止直接部署到公网**。

## M2 Agent 与只读任务 API

| 方法 | 路径 | 权限 / 行为 |
| --- | --- | --- |
| POST | `/api/v1/admin/agents/pair-tokens` | 管理员签发一次性设备接入令牌 |
| POST | `/api/v1/agent/pair` | 一次性令牌配对（不接受管理员 Cookie 代替令牌） |
| GET | `/api/v1/admin/agents` | 管理员设备列表、在线状态与最近能力 |
| GET/PATCH | `/api/v1/admin/agents/:id` | 管理员详情/重命名 |
| POST | `/api/v1/admin/agents/:id/revoke` | 管理员撤销设备，主动断开 WSS |
| POST | `/api/v1/admin/agents/:id/capability-probe` | 管理员请求只读探测，JSON Body 必须为 `{}`；202 返回 `taskId` |
| GET | `/api/v1/admin/agent-tasks/:id` | 管理员查询任务状态、结果与超时未知状态 |
| WS/WSS | `/agent` | 独立 Agent Bearer 凭据 + UUID + 协议版本认证 |

Agent 完成 `hello` 后自动接收只读能力探测任务；只允许与所属 Agent 对应的 `task_result` 更新 SQLite。任务 `sent` 在断线、超时、Server 重启后变为 `unknown`，**不等于失败**；重复结果幂等，迟到结果仍可关联。当前不会自动重放任务，也没有通用命令执行接口。

`AgentCommandSchema` 已定义未来的容器启停/重启、inventory 和 Compose 部署参数，但**本批仅执行 `capability_probe`**。即使 Agent 报告 Docker/Compose 可用，也不意味着已开放安装或容器操作。生产环境必须使用可信 TLS/WSS 反向代理，禁止公网明文连接。完整 Codex 验收步骤见 [统一验收清单](../planning/M1-CODEX-REGRESSION.md)。
