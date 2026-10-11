# Navloom · 产品规划与任务

本目录是 Navloom 的**产品需求单一事实来源**。目标是让「导航首页 → 管理后台 → Agent 容器发现 → 应用安装 → 自动生成导航卡片」成为可交付的完整闭环。

> 适用范围：个人自托管 v1；本目录仅包含规划文档和任务，不包含产品实现代码。

## 文档导航

| 文件 | 内容 |
| --- | --- |
| [PRD.md](./PRD.md) | 产品需求文档：场景、页面、规则、验收标准 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 已确定技术栈、职责边界与协议原则 |
| [DECISIONS.md](./DECISIONS.md) | 已确认决策、建议和待确认事项 |
| [ROADMAP.md](./ROADMAP.md) | 里程碑、交付顺序和完成条件 |
| [M0-IMPLEMENTATION.md](./M0-IMPLEMENTATION.md) | M0 工程初始化实施记录与 CI 验收证据 |
| [M1-IMPLEMENTATION.md](./M1-IMPLEMENTATION.md) | M1 首批认证与导航功能、测试及未完成项 |
| [M2-IMPLEMENTATION.md](./M2-IMPLEMENTATION.md) | M2 首批 Agent 配对、设备登记及后续验收依赖 |
| [M1-CODEX-REGRESSION.md](./M1-CODEX-REGRESSION.md) | M1 尚未验收的 14 项任务与 Codex 浏览器回归执行单 |
| [TRACEABILITY.md](./TRACEABILITY.md) | 需求 ID → 任务 ID 对照表 |
| [tasks/README.md](./tasks/README.md) | 任务索引、优先级、状态、执行约定 |
| [tasks/01-foundation.md](./tasks/01-foundation.md) | 工程基础与数据模型 |
| [tasks/02-access-auth.md](./tasks/02-access-auth.md) | 首页弱口令与管理员认证 |
| [tasks/03-navigation.md](./tasks/03-navigation.md) | 导航首页与导航页管理 |
| [tasks/04-agent.md](./tasks/04-agent.md) | Agent 注册、通信与设备管理 |
| [tasks/05-inventory.md](./tasks/05-inventory.md) | 容器池与应用实例管理 |
| [tasks/06-catalog.md](./tasks/06-catalog.md) | 应用模板、目录与动态安装表单 |
| [tasks/07-deployment.md](./tasks/07-deployment.md) | 安装任务、Compose 执行与自动导航 |
| [tasks/08-quality-release.md](./tasks/08-quality-release.md) | 联调、安全、测试与发布 |
| [tasks/09-backlog.md](./tasks/09-backlog.md) | P1/P2 备选功能（非 v1 承诺） |

## 使用方法

1. 先读 PRD 和 DECISIONS，确认产品边界。
2. 按 ROADMAP 的里程碑顺序领取 tasks/ 下的任务。
3. 任务使用稳定的 `T-xxx` 编号，完成后将 `- [ ]` 改为 `- [x]`，并记录对应 PR / Commit。
4. 变更需求时，先更新 PRD 和 DECISIONS，再更新任务与 TRACEABILITY。
5. 任务验收以具体行为和测试证据为准，**不以写完代码代替完成**。

## 范围与状态约定

- **已确认**：用户明确决定的产品行为。
- **建议 / 待确认**：为了落地提出的设计，尚未取得最终确认。
- **P0**：v1 核心闭环必需；**P1**：首版之后增强；**P2**：长期候选。
- 任务进度以各任务文件复选框为准；**M0 已完成，M1 已验收 11/25 项并进入浏览器回归，M2～M4 尚未开始**。
- **不做**：v1 不做多用户、健康检查、Kubernetes、完整服务器运维与跨 Agent 调度。

最后更新：2026-10-11。
