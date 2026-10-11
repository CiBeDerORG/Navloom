# Navloom 任务索引

本目录将 [PRD](../PRD.md) 中每一类需求拆为可实施、可验收的任务。**所有复选框默认未完成**；任务 ID 永久稳定。

## 分组与数量

| 文件 | 编号 | 任务数 | 里程碑 |
| --- | --- | ---: | --- |
| [01-foundation.md](./01-foundation.md) | T-001～T-008 | 8 | M0 |
| [02-access-auth.md](./02-access-auth.md) | T-009～T-018 | 10 | M1 |
| [03-navigation.md](./03-navigation.md) | T-019～T-033 | 15 | M1 |
| [04-agent.md](./04-agent.md) | T-034～T-047 | 14 | M2 |
| [05-inventory.md](./05-inventory.md) | T-048～T-059 | 12 | M2 |
| [06-catalog.md](./06-catalog.md) | T-060～T-070 | 11 | M3 |
| [07-deployment.md](./07-deployment.md) | T-071～T-088 | 18 | M3 |
| [08-quality-release.md](./08-quality-release.md) | T-089～T-102 | 14 | M4 |
| [09-backlog.md](./09-backlog.md) | T-103～T-114 | 12 | P1/P2 |
| **合计** | **T-001～T-114** | **114** | **P0 102 / 候选 12** |

## 每个任务的固定字段

- **编号 / 优先级 / 标题**：唯一引用，例如 T-029。
- **对应需求**：指向 PRD 的需求 ID。
- **前置**：先完成或确认的任务、决策。
- **交付**：需要产生的具体行为、接口、界面或文档。
- **验收**：可测试的通过条件。

## 状态管理

- `- [ ]`：未完成（包括未开始、进行中和阻塞；需要在 PR 或项目板补充状态）。
- `- [x]`：验收完成。
- 若要记录负责人、分支、PR、实际完成时间，建议在 GitHub Project/Issue 中维护，避免在文档中制造重复事实源。
- P1/P2 仅为需求池，不计入 v1 发布阻塞。

## 推荐工作流

1. 查看 [ROADMAP](../ROADMAP.md) 确定当前里程碑。
2. 读取 [DECISIONS](../DECISIONS.md) 检查未确认事项。
3. 选择前置条件已满足的任务，按验收标准实施。
4. 在 PR 描述中写明“Closes task T-xxx / PRD-xxx”，附测试证据。
5. 合并并验证后，将对应复选框勾选。
6. 需求变更时同步更新 PRD、DECISIONS、TRACEABILITY 和任务。

> **注意**：任务的实现细节是建议，已确认的产品行为不可擅自改动；涉及 Q-xx 的任务应先确认决策。
