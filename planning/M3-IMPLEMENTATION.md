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
