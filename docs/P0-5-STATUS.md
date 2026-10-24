# P0-5 编修、审核与发布状态

状态：进行中。最后更新：2026-10-24。

## 已完成：首切片（管理员提案闭环）

- `0009_change_requests.sql` 新增 `change_request`、`change_item`，并为发布 revision 记录可选提案引用和版本。
- 草稿只保存明确的承谱边或 canonical 亲属关系增删意图；纯 TypeScript 预览从基准 snapshot 构建候选边与关系，不改写任何权威数据。
- 管理员 API 支持创建草稿、读取预览、提交、批准、驳回和发布。批准会核对提案基准 revision 与发布指针版本；发布时迁移触发器再次核对提案仍为相同的 `approved` 版本。
- 提案发布以一个 D1 batch 写入 immutable revision、承谱/亲属 snapshot、发布指针、提案终态和审计记录。来源主张与既有 revision 不被覆盖。
- 本地认证集成回归覆盖“草稿 → 预览 → 提交 → 批准 → 发布 → 已发布亲属图读取”、驳回理由与陈旧基准冲突；单元测试覆盖纯提案增删投影及直发策略。
- 编辑员可在显式 `global`、覆盖变更双方人物的 `person` 范围，或提案基准 revision 的精确房支 `blood_primary` 成员范围内创建、预览并提交提案；管理员可用受版本保护的 API 替换账号范围。房支权限不递归包含子房，也不从关系图推导。
- 创建者不能批准、驳回或发布自己的提案；本地集成回归使用第二位管理员验证该分离职责。
- 发布新 revision 时原样复制基准的 `branch_membership_snapshot`，关系提案不会隐式改变房支成员归属。

## 实际验证

| 命令 | 结果 |
|---|---|
| `npm run lint` | 通过。 |
| `npm run check` | 通过：21 个 Vitest 文件、43 项测试。 |
| `npm run build` | 通过。 |
| `npm run test:local-auth` | 通过：隔离 local Worker/D1，不使用 `--remote`。 |
| `npm run test:local-core-model` | 通过：隔离 local D1，不使用 `--remote`。 |

## 未完成与风险

- 房支成员的创建/调整、对象级审批人策略与前端编辑工作台尚未启用；当前 `branch` 范围仅使用已存在的基准 revision 快照，不能通过关系提案变更成员归属。
- 管理员直接 revision 发布/回退 API 仅允许 `development` 环境，供现有 local fixture、千人回归和演示工具使用；preview 与 production 返回 `change_request_required`，不能绕过提案发布路径。生产回退通过历史 revision 自动生成的变更提案完成。
- 人物合并、拆支、删除、媒体引用与来源纠错不在本切片范围，不能复用当前关系提案机制而省略各自的影响预览与恢复规则。

## 下一步

1. 管理员可由任一历史 published revision 生成回退提案；系统将当前与目标 snapshot 的承谱/亲属关系差异转换为显式 `change_item`，仍须提交、批准后才会发布新的 immutable revision。
2. 为房支成员的创建、调整、来源依据与对象级审批人策略做独立设计审查。
3. 为更多非法候选与审计原子性补充 local Worker/D1 回归。
4. 在 P0-6 前保持所有迁移仅用于 local 验证；preview/production 迁移、Secrets 和部署仍须单独授权。
