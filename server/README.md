# Navloom Server（M0）

技术：Fastify 5 + TypeScript + SQLite + Drizzle ORM。**Server 运行于云端，不负责执行 Docker 命令。**

当前仅开放 `GET /api/v1/system/status`，返回：
```json
{"service":"navloom-server","status":"ok","api_version":"v1"}
```

M0 没有管理员认证、Agent 接入和管理 API，**不要部署到公网**。

## 启动

从仓库根目录：
```bash
npm ci
npm run build:contracts
npm run db:migrate
npm run dev:server
```

如果仅启动 Server：
```bash
npm run dev -w @navloom/server
```

数据库默认在 `server/data/navloom.db`；也可通过 `DATABASE_URL` 指定路径。Server 启动会打开 SQLite 并设置 WAL、外键检查和 busy timeout，但**不会自动执行迁移**；需先运行 `npm run db:migrate`。

初始迁移为 `server/drizzle/0000_initial.sql`，Drizzle migrator 记录已应用版本，重复运行不会重新创建表。后续结构变更必须同步维护 `src/db/schema.ts` 与新的迁移文件，不要直接修改已应用迁移。

环境变量：`NODE_ENV`、`HOST`、`PORT`、`DATABASE_URL`。认证相关密钥待 M1 实现。
