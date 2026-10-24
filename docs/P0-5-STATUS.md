# P0-5 编修、审核与发布状态

状态：进行中。最后更新：2026-10-24。

## 已完成：首切片（管理员提案闭环）

- `0009_change_requests.sql` 新增 `change_request`、`change_item`，并为发布 revision 记录可选提案引用和版本。
- 草稿只保存明确的承谱边或 canonical 亲属关系增删意图；纯 TypeScript 预览从基准 snapshot 构建候选边与关系，不改写任何权威数据。
- 管理员 API 支持创建草稿、读取预览、提交、批准、驳回和发布。批准会核对提案基准 revision 与发布指针版本；发布时迁移触发器再次核对提案仍为相同的 `approved` 版本。
- 提案发布以一个 D1 batch 写入 immutable revision、承谱/亲属 snapshot、发布指针、提案终态和审计记录。来源主张与既有 revision 不被覆盖。
- 本地认证集成回归覆盖“草稿 → 预览 → 提交 → 批准 → 发布 → 已发布亲属图读取”、驳回理由与陈旧基准冲突；单元测试覆盖纯提案增删投影及直发策略。

## 实际验证

| 命令 | 结果 |
|---|---|
| `npm run lint` | 通过。 |
| `npm run check` | 通过：21 个 Vitest 文件、40 项测试。 |
| `npm run build` | 通过。 |
| `npm run test:local-auth` | 通过：隔离 local Worker/D1，不使用 `--remote`。 |
| `npm run test:local-core-model` | 通过：隔离 local D1，不使用 `--remote`。 |

## 未完成与风险

- 编辑员提交、`account_scope` 房支范围授权、对象级审批人策略尚未启用；当前首切片仅允许管理员操作。
- 管理员直接 revision 发布/回退 API 仅允许 `development` 环境，供现有 local fixture、千人回归和演示工具使用；preview 与 production 返回 `change_request_required`，不能绕过提案发布路径。生产回退的提案化流程仍待后续切片设计。
- 人物合并、拆支、删除、媒体引用与来源纠错不在本切片范围，不能复用当前关系提案机制而省略各自的影响预览与恢复规则。

## 下一步

1. 为生产回退设计受控的提案化流程，再为编辑员提案与 `account_scope` 进行独立授权设计审查。
2. 为提案冲突、驳回、非法候选和审计原子性补充 local Worker/D1 回归。
3. 在 P0-6 前保持所有迁移仅用于 local 验证；preview/production 迁移、Secrets 和部署仍须单独授权。
