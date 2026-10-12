# Navloom M3 · 模板驱动安装与自动导航

> 开始日期：2026-10-12。**第一阶段仅实现可信模板目录、参数表单与无副作用预览，尚未开放真正安装。** 所有 M3 正式任务复选框以 planning/tasks/06-catalog.md 与 07-deployment.md 的完整验收为准。

## 仓库边界（用户要求）

- CiBeDerORG/Navloom：M3 业务代码、内置模板和文档。
- CiBeDerORG/deploy：本轮没有改动。**一旦 M3 需要修改 deploy 仓库，必须先新建独立开发分支，绝不直接改 deploy/main。**
- Q-08 模板来源**尚未最终确认**；当前仅按路线图默认建议使用内置、受审查模板，不自动拉取或运行外部仓库脚本。未来是否接入 deploy 模板需要单独决定。

## 当前第一批代码交付

| 任务 | 已提交的代码 | 剩余验收 |
| --- | --- | --- |
| T-060 | 随仓库发布的可信 YAML 模板目录 templates/builtin | Q-08 产品决策，审核/更新/打包演练 |
| T-061 | navloom/v1 ID、版本、分类、架构、Compose services、导航建议，单容器与双服务 YAML | 完整模板格式与兼容性验收 |
| T-062 | 严格安装参数规范：string/integer/boolean、枚举、默认值、必填、secret、port、absolute-path | 所有 Web 与 Server 边界回归 |
| T-063 | 白名单 Compose 渲染：仅固定 image、ports、env、命名卷，端口仅绑定 localhost；禁止 command、privileged、host mount、任意 Shell | Agent 受限执行器和安全目录属于后续任务 |
| T-064 | js-yaml v4 + Zod fail-closed 解析、未知字段/重复 ID/符号链接/64KiB 上限 | 发布安装包和版本迭代验收 |
| T-065 | 管理员目录列表、搜索、详情、严格参数预览 API；无参数秘密回传 | UI 和 API 综合验收 |
| T-066 | 应用实例管理页面的模板卡片、搜索、详情 | 浏览器响应式/键盘验收 |
| T-067 | 动态字段表单、在线 Agent 选择、秘密输入遮蔽和无副作用预览 | 安装任务闭环尚未接通 |

## 可信来源、审核和更新

1. **唯一来源**：只能读取本仓库版本中的 templates/builtin 下普通 YAML 文件；拒绝大于 64KiB、符号链接、损坏模板及同一 ID 的重复模板，不允许前端上传任意 Compose 或远程 URL。
2. **人工审查**：更改模板时检查固定镜像版本、架构、容器端口、数据卷、环境变量/密码、导航建议，以及是否违反 Shell/特权/host 网络/设备访问禁令。新增模板必须通过 Schema 和安全测试。
3. **版本锁定**：模板 ID 长期稳定；version 是 MAJOR.MINOR.PATCH；升级必须提交版本变更并通过 CI。未来任务必须持久引用选定 ID 与版本，不可被外部源静默改变。
4. **安全保密**：secret 字段不许有默认秘密；Server 预览仅返回服务名、镜像、端口、卷和环境变量键，不返回任何 env 值。正式部署前必须完善敏感参数存储/传输/文件权限（T-068、T-077）。
5. **访问 URL**：默认端口映射在 Agent localhost，导航 URL 仍由管理员编辑；不能擅自根据 EasyTier IP 推断浏览器可访问地址。
6. **实际部署**：目前**不会创建安装任务，也不会调 Docker Compose**。后续需先实现 SQLite 状态机、Agent 严格执行器、fsync Journal、重连对账、唯一实例与卡片幂等。仅 Compose up 退出码 0 为部署成功，不做健康检查。

## 自动化与后续工作

- Server 新增 m3-catalog.test.ts，覆盖两个可信 YAML、重复/恶意模板、非法参数/secret 默认值、Compose 白名单、管理员 Cookie 与首页 Cookie 隔离、无秘密反射预览。
- 持续运行 npm 构建、类型检查、ESLint、Server/SQLite 测试，以及现有 M2 双 Go Agent、真实 Chrome、真 Docker/Compose 重建与零页面抓包 CI。
- 下一阶段 T-068～T-070：秘密安全策略、可编辑导航草稿、动态表单完整验收；T-071～T-075：持久安装状态、幂等 API/Agent 离线策略；T-076～T-082：Agent Compose 执行、受限目录、日志与重连对账；T-083～T-088：唯一 AppInstance/单卡片事务、Web 任务页、并发限制和隔离实机测试。
- **M3 尚未正式完成任何整项任务的独立验收；不能用功能代码存在或 CI 全绿冒充任务 PASS。**

## 后续补充：安装任务状态机基础（T-071/T-073/T-079/T-081 部分）

- 新增 server/src/install/tasks.ts：内部 InstallTaskStore 使用已存在的 SQLite install_tasks 表，不新增容器操作入口。reserve() 在同一个 SQLite 事务中按幂等请求键检查和写入，只允许未撤销且已登记的 Agent；冲突键不得指向其他 Agent/模板/版本。
- 显式状态转移：pending → running 或 unknown；running → succeeded/failed/unknown；unknown → succeeded/failed；终态不能重新派发。相同退出码的终态重复回报是幂等读取，相反结果不可覆盖。
- Docker Compose up 的退出码 0 代表部署成功，非 0 代表失败；丢失连接时标 unknown，绝不依据 HTTP/健康检查改判，也不把 unknown 重新设为 pending。
- server/src/m3-install-state.test.ts 在隔离 SQLite 文件上关闭并重新打开 Server DB，验证 idempotency、唯一任务、跨重启状态、未知任务迟到结果、错误终态重放与非法转移。
- **严格限制**：该模块目前没有管理员安装 POST API、秘密参数落库/加密、Agent 真 Compose 执行或成功自动生成导航，不能将内部状态机视为 T-071～T-088 完整实现，正式勾选仍为 0。


## 2026-10-12 第二轮：真实 Agent 预检、导航草稿与加密待部署任务

**T-068 安全基础**：server/src/install/secrets.ts 使用外部 NAVLOOM_INSTALL_KEY（32 字节随机 base64url 密钥）进行 AES-256-GCM 加密，每次使用随机 nonce，并把 taskId、agentId、模板 ID 与版本作为认证附加数据。密文被篡改、错任务、错 Agent、错密钥、密钥缺失均安全拒绝。密钥没有静态默认值。加密密钥轮换/备份、真实 Agent 安全传输和日志审计仍待完善，不能据此完成整个 T-068。

**T-069 可编辑导航草稿**：模板管理表单已允许修改标题、实际浏览器 URL、图标、说明、分组、打开方式。不擅自推测 EasyTier IP/端口为浏览器可访问的导航 URL；URL 为空时预检提醒。只有管理员明确选择安全保存草稿才落库；不自动创建导航卡片。

**T-072 预检**：POST /api/v1/admin/install/preflight 仅管理员可用，要求准确模板版本、Agent 当前认证在线、CPU 架构适配、Docker/Compose 能力未过期、容器快照未过期、参数合法、无明显端口冲突、导航草稿有效；只回安全资源元数据、ready 和警告，决不回传密码/环境变量值。端口预检属于 best-effort，不保证无并发冲突；Agent 离线直接拒绝。

**T-071/T-073 加密持久草稿**：新增 server/drizzle/0009_m3_install_task_inputs.sql 与 Drizzle schema。状态 prepared 的 install_tasks 与 install_task_inputs 在同一 SQLite 事务中保存，后者只存 AES-GCM 参数密文与外部密钥 HMAC 计算的全请求摘要。相同幂等键/完全相同请求复用原 ID；复用幂等键同时更改密码、目标 Agent 或导航信息会被拒绝。状态 prepared 不允许自动转换成 running，**不会调用 Docker Compose，也没有后台派发器**。接口 POST /api/v1/admin/install/prepared-tasks 需管理员显式提交、预检全部就绪和有效外部加密密钥；GET /api/v1/admin/install/prepared-tasks 只返回不含明文、密文、哈希的草稿元数据；首页 Cookie 无权访问。Web 中的按钮明确写明仅加密保存、未部署。

**回归证据**：m3-secrets.test.ts、m3-preflight.test.ts、m3-prepared-tasks.test.ts 验证错误身份/篡改、持久化/重启、重复键及危险输入；scripts/smoke-m2-reverse.mjs 使用隔离 GitHub Runner 中两个真实 Go Agent、Node Server、SQLite 和临时真实 Docker，对在线预检、安全保存、秘密不反射、幂等键冲突、零 Docker 副作用作了端到端回归。正式 CI 结果只认 GitHub Actions 状态 completed/success，未跑或失败须补修。

**仍待完成**：T-074/T-075 的安全任务派发与恢复，T-076～T-082 的受限 Go Compose 执行器、文件权限/日志/重连对账，T-083～T-088 的受管实例与自动导航幂等事务、最终实机验收。真实 NAS 或外部 CiBeDerORG/deploy 依旧没有被操作；如需改 deploy 必须先建独立分支。


## 2026-10-12 第三轮：Go Agent 受限 Compose v2 执行器（未接入远程派发）

**T-076 部分**：新增 agent/internal/deploy/executor.go。独立 Go 模块采用 Go JSON Decoder DisallowUnknownFields 和严格 Compose 安全白名单，限定 project 名称、固定镜像版本、最多 12 个服务、127.0.0.1 端口映射、命名卷、受控 env 键值与 restart 模式。拒绝额外特权、任意 command、host network、任意宿主挂载、Shell、未审查镜像，以及超大或异常 JSON。采用 exec.CommandContext 固定执行 docker compose -p <validated-project> -f <private-compose.json> up -d，不经过 Shell；默认超时 5 分钟。服务原始输出可能含密码，**不会直接输出到普通日志**。退出码按 CLI 原值传出，非零不改判。此模块与既有 Agent transport 隔离，尚未在 WSS 白名单中开放 compose_deploy。

**T-077 部分**：Executor 要求 Agent 本机预置绝对路径的私有部署根（0700），每个 Compose project 使用独立 0700 子目录和 0600 compose.json，写入后执行 fsync。独立的 0600 claim ledger 在 Docker 副作用发生前写入任务 ID/project/digest 并 fsync；Linux flock 对同一 root 跨进程串行化，发生进程崩溃/CLI 失败/超时后同 task_id 不会再自动执行；另外同一 project 被另一 task_id 重新认领也被拒绝。后续仍需补持久化完成结果、明确恢复查询协议、资源清理策略和跨项目并发控制。为了防止受控目录中的符号链接重定向，lock 和 claim ledger 使用 Linux O_NOFOLLOW，根目录/Compose 子目录本身也不允许符号链接。

**自动化覆盖**：
- agent/internal/deploy/executor_test.go：恶意 Compose 属性、非法镜像、非回环端口、任意宿主卷、日志/锁符号链接、磁盘权限、失败退出码 17、同一 task_id 在 Executor 新实例下不重放、不同 task_id 不能重用项目、固定 Docker CLI 参数中不出现密码。
- agent/internal/deploy/disposable_test.go：仅在 GitHub-hosted 一次性 Runner 配合 NAVLOOM_CI_DOCKER_FIXTURES 和 scratch 测试镜像时实际运行 Compose v2 up -d、检查容器存在、同 task_id 拒绝重复执行，并在测试结束后 docker compose down --remove-orphans；禁止外部 DOCKER_HOST。
- scripts/smoke-m2-reverse.mjs：同一 CI 真实双 Agent、Node Server、Chrome、临时 Docker/Compose 及零页面抓包中调用上述真实 Go 执行器测试。证据 [GitHub Actions 38235600666](https://github.com/CiBeDerORG/Navloom/actions/runs/38235600666) **4/4 PASS**，日志含 M3 disposable Go Compose v2 executor PASS 与历史 M3 加密草稿/Agent 预检 PASS。CI 已将 internal/deploy 纳入 Go race 检测。

**重要边界与后续顺序**：这是本地受限执行模块，**并非正式的远程安装成功**。T-074 仍须建立 Server 受控领取/明确管理员激活 API 与审查后的 Agent 协议信封；T-076/T-077 还需 Agent 侧身份/参数/目录全链路绑定；T-078～T-081 需要安全日志、fsync 任务最终结果回报和断线未知任务对账；T-083～T-088 需要唯一实例与唯一导航卡片事务。M3 29 项正式签核保持原状。CiBeDerORG/deploy 未修改，后续如需修改，先在 deploy 新建分支。
