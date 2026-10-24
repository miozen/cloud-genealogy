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
- 该安全阻止已由下一阶段的完整原子发布链路取代；本节保留为草稿 API 的历史状态。

## 已完成：房支结构审批与发布（阶段 B-3）

- 仅管理员可以提交、审核及发布含结构条目的提案；创建者仍不能审核或发布自己的提案。
- 批准与发布都会重新从基准 `branch_structure_snapshot` 投影结构，拒绝无效结构；退休还会拒绝候选成员快照仍在该房支、或任何账号范围仍引用该房支的情形。
- 发布在既有单个 D1 batch 内更新当前 `branch`，并同时写入新 revision 的结构/成员/关系快照、published pointer、提案终态和审计。失败不会留下部分结构写入。
- `npm run check`（22 个 Vitest 文件、50 项测试）及 `npm run test:local-auth` 已实际通过。后者覆盖管理员结构改名草稿 → 第二管理员批准/发布 → 当前 `branch` 更新；仅使用隔离 local Worker/D1。

## 已完成：新房与成员组合提案

- 管理员可在同一 `change_request` 创建房支并添加其首位成员；审核、发布和最终 snapshot 均基于同一结构候选，仍要求最终成员只归属活跃房支。
- `0013_allow_membership_items_for_new_branches.sql` 仅移除**提案条目**到当前 `branch` 的外键并重建复制该表，避免草稿阶段阻止尚未发布的新房；`person` 与 `change_request` 外键、唯一约束及索引均保留。
- 发布 batch 的顺序保持先创建当前 `branch`、再写成员/结构 snapshot；任何失败都会回滚整个 batch。`npm run test:local-auth` 已实际覆盖并通过此路径，且只使用隔离 local D1。

## 已完成：房支退休依赖验证

- 本地 Worker/D1 端到端回归覆盖三种退休路径：仍有成员时拒绝、成员已迁出但仍有 `account_scope` 引用时拒绝、依赖全部清除后由第二管理员批准并发布。
- 两种依赖拦截均返回明确的 `branch_retirement_in_use`；成功发布后断言当前 `branch.retired_at`、新 revision 的结构快照退休时间及该 revision 的成员数均符合预期。

## 已完成：世系审核人指派与失效

- `0014_lineage_reviewer_assignments.sql` 新增显式、最长 90 天的世系审核人指派和提交时的审核人快照；它独立于编辑 `account_scope`，不从房支或账号关联推断审批权。
- 仅活跃管理员可被指派；新提案提交时无有效非创建者审核人会返回 `reviewer_assignment_required`。审核和发布时都会重新检查快照、指派有效期、撤销状态、账号活跃状态和管理员角色。
- 管理员撤销指派后，未审核提案保持 `pending_review`；新的草稿不得提交。迁移前无快照的既有提案保留旧的“另一管理员”机制，避免无提示地阻塞存量工作。
- `npm run test:local-auth` 已实际覆盖有效指派下的完整审核发布路径和撤销即时失效；所有验证仅使用 local Worker/D1。

## 已完成：首个提案与审核工作台

- 现有后台单页新增相互独立的提案工作台、审核队列和世系审核人指派区域；提案预览明确显示校验结果及关系、成员、房支结构候选数量。
- 首个 UI 仅允许创建单条 canonical 亲属关系草稿。成员归属和房支结构仍维持后端受控 API，等待专门的批量编辑、依赖预览与恢复交互设计，避免在简单表单中误操作高风险变更。
- 新增管理员只读 API：按世系列出提案队列、列出可指派的活跃管理员账号；local Worker/D1 集成回归已验证上述 API 以及原有审核流程。

## 未完成与风险

- 房支成员的**增删提案后端**已经过本地完整验证，但尚没有前端编辑工作台。房支创建、调整、对象级审批人策略仍不在本切片范围；当前 `branch` 范围仍仅使用已存在的基准 revision 快照，不能通过关系提案隐式变更成员归属。
- 管理员直接 revision 发布/回退 API 仅允许 `development` 环境，供现有 local fixture、千人回归和演示工具使用；preview 与 production 返回 `change_request_required`，不能绕过提案发布路径。生产回退通过历史 revision 自动生成的变更提案完成。
- 人物合并、拆支、删除、媒体引用与来源纠错不在本切片范围，不能复用当前关系提案机制而省略各自的影响预览与恢复规则。

## 下一步

1. 为成员归属和房支结构确认专门的前端编辑交互：批量条目、依赖拦截、影响预览与明确撤销路径；不得直接复用单条关系表单。
2. 如需真正按房支/人物分配审核职责，另行确认跨对象提案、多审核人、代理与历史快照语义；当前仅按世系显式指派。
3. 在 P0-6 前保持所有迁移仅用于 local 验证；preview/production 迁移、Secrets 和部署仍须单独授权。
