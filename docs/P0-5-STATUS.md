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
- 创建提案会在写入前拒绝未知人物和重复条目；审核会重新构建候选快照并拒绝成环或其他非法候选，提案继续保留为可驳回的 `pending_review` 状态。
- 本地 D1 集成回归会复用 revision ID 触发发布 batch 失败，并确认指针不变、提案仍为 `approved`、同一 revision 的发布审计没有重复写入。

## 实际验证

| 命令 | 结果 |
|---|---|
| `npm run lint` | 通过。 |
| `npm run check` | 通过：21 个 Vitest 文件、44 项测试。 |
| `npm run build` | 通过。 |
| `npm run test:local-auth` | 通过：隔离 local Worker/D1，不使用 `--remote`。 |
| `npm run test:local-core-model` | 通过：隔离 local D1，不使用 `--remote`。 |

## 本切片验证状态（房支成员提案）

- 已激活接力文档规定的 NVM Node `22.23.4` / npm `10.9.9`。
- `git diff --check`、`npm run lint`、`npm run check`（21 个测试文件、48 项测试）与 `npm run build` 均通过。
- `npm run test:local-auth` 与 `npm run test:local-core-model` 均通过：使用隔离 local Worker/D1 状态，不使用 `--remote`。两项 Wrangler 本地测试需要回环端口绑定权限；这是执行环境限制，不涉及远程资源。

## 已完成：房支结构快照基础设施（阶段 A）

- `0011_branch_structure_snapshots.sql` 新增每个 published revision 的完整 `branch_structure_snapshot`，并在尚无历史结构写 API 的前提下以当前结构回填既有 revision。
- 发布和回退生成的新 revision 会写入结构、成员、承谱与亲属关系完整快照；成员和关系提案在没有结构条目时只复制基准结构。
- 未开放任何房支创建、改名、移动、合并、退休或删除接口；这些仍须走独立高风险提案切片。
- `npm run lint`、`npm run check`（21 个测试文件、48 项测试）、`npm run build`、`npm run test:local-core-model` 与 `npm run test:local-auth` 均通过；后者实际断言已发布 revision 同时写入房支成员与结构快照。所有验证只使用 local D1/Worker。

## 已完成：房支结构提案基础（阶段 B-1）

- `0012_branch_structure_change_items.sql` 新增与关系/成员条目分离的房支结构变更条目表。
- 纯预览模块覆盖创建、改名、同级活跃名称唯一、活跃父房与“有活跃子房不得退休”；它不修改基准结构。
- `npm run lint`、`npm run check`（22 个测试文件、50 项测试）、`npm run build` 与 `npm run test:local-core-model` 均通过；尚未接入 API，下一切片必须将预览、审批、发布和审计放入现有提案原子事务。

## 已完成：房支结构草稿 API（阶段 B-2）

- 管理员可在统一 `change_request` 中保存和预览 `create`、`rename`、`retire` 结构条目；非管理员被拒绝。
- 结构草稿当前返回预览但被 `structure_publish_not_ready` 明确阻止提交，因此不会意外进入审核或修改当前 `branch`。
- `npm run lint`、`npm run check`、`npm run build` 和 `npm run test:local-auth` 均通过；集成回归覆盖结构草稿创建、预览和安全提交阻止。

## 未完成与风险

- 房支成员的**增删提案后端**已经过本地完整验证，但尚没有前端编辑工作台。房支创建、调整、对象级审批人策略仍不在本切片范围；当前 `branch` 范围仍仅使用已存在的基准 revision 快照，不能通过关系提案隐式变更成员归属。
- 管理员直接 revision 发布/回退 API 仅允许 `development` 环境，供现有 local fixture、千人回归和演示工具使用；preview 与 production 返回 `change_request_required`，不能绕过提案发布路径。生产回退通过历史 revision 自动生成的变更提案完成。
- 人物合并、拆支、删除、媒体引用与来源纠错不在本切片范围，不能复用当前关系提案机制而省略各自的影响预览与恢复规则。

## 下一步

1. 将结构条目接入批准与发布；发布时原子更新当前 `branch`、结构快照、pointer、提案状态与审计，并补充成员/账号范围依赖的退休拦截。
2. 设计对象级审批人映射、代理与失效规则；确认前继续由另一位管理员审核，不推断房支负责人。
3. 单独确认前端编辑工作台的最小交互与权限展示；后端 API 已可供该切片使用。
4. 在 P0-6 前保持所有迁移仅用于 local 验证；preview/production 迁移、Secrets 和部署仍须单独授权。
