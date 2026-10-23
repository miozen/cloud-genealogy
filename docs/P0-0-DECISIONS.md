# P0-0 架构确认记录

状态：已确认，待进入 P0-1 实施。  
确认日期：2026-10-22。

本文件记录在 `PRODUCT.md`、`ARCHITECTURE.md`、`DATA_MODEL.md` 与 `ROADMAP.md` 基线之上已确认的实施决策；如有冲突，以产品基线与后续经确认的决策为准。

## 1. 已确认决策

- 单一家族、模块化单体、Vue 3 + TypeScript + Vite、Hono/Workers、D1、私有 R2 的技术方向不变。
- 承谱模型在数据层不按性别限制；每个 `lineage` 由配置决定传统吊线图采用哪一种承谱上行规则。一个人物在同一已发布世系版本中最多一条有效承谱上行边。
- 每人默认只有一个血缘主房；迁居、管理等归属可多选。例外归属须走审核。
- 谱书原件与首次转录均不可覆盖。后续纠错以可追溯的校订转录或注释版本叠加，保留被替代关系。
- P0 由单管理员发布。房支编辑者（若启用）只能提交变更提案；双人审批预留为高风险操作的可配置能力。
- 在世人物默认最小披露；姓名、关系、事实、媒体和搜索结果均执行字段级访问策略。
- 首批资料以人工录入为主。Excel、扫描件批量导入及 OCR 不是 P0 前置条件。
- P0 媒体以图片为主。视频不提供面向全体成员的无限上传；仅管理员受控上传或外链。
- 外部备份采用加密离线备份至本地电脑，至少保留三个恢复点；恢复密钥与备份文件分开保存。
- GitHub Actions 可持有最小权限、可轮换的 Cloudflare 部署 Token。

## 2. 统一世系与来源谱书边界

### 来源层（历史事实记录）

`source_person_record`、`source_fact_claim`、`source_relation_claim` 只表达某一谱书版本的原文或转录内容。它们可尚未映射统一人物，且不得被统一世系编辑覆盖。

一次转录更正创建新的转录/注释记录，通过 `supersedes` 指向旧记录；扫描原件、页码和原文定位始终保留。每个来源主张可经多对多的出处关联指向卷、页、图像区域或外部证据。

### 统一层（已审核的当前结论）

`person` 是稳定身份锚点，不用姓名、世次或房支名称充当主键。来源人物与统一人物的人工对应存于可撤销、可审计的 `source_person_link`。

统一承谱只读取 `lineage_succession_snapshot`：该表是某个 `lineage_revision` 中被审核采用的父子边。它可经 `revision_evidence_link` 引用一个或多个来源主张或考证结论，但不会反向写入来源层。

`canonical_relation_snapshot` 表达生父母、嗣父母、养父母、收养等亲属事实；其存在不等于成为传统吊线图的承谱边。过继保留生父关系，并额外记录嗣/养关系；由世系 revision 明确选择承谱上行边。

## 3. 最小物理模型与完整性规则

表按下列模块组织；这不是最终 DDL，P0-1 迁移须据此实现。

```text
身份：account, role, permission, account_role, account_scope, person_claim
人物：person, person_name, person_fact, place, media_asset, person_media
来源：genealogy, genealogy_edition, genealogy_volume, genealogy_page,
      source_person_record, source_fact_claim, source_relation_claim,
      source_reference, claim_reference, source_person_link
统一世系：lineage, lineage_revision, lineage_published_pointer,
          lineage_succession_snapshot, lineage_order_snapshot,
          canonical_relation_snapshot, branch, branch_membership_snapshot,
          revision_evidence_link
编修运维：change_request, change_item, research_case, research_evidence,
          research_decision, audit_log, backup_record, import_batch, import_row
```

- 发布 revision 是不可变完整快照；约 1000 人规模下，关系和排序快照冗余可换取简单、稳定的读取、差异比较和回退。
- 草稿以 `change_request` / `change_item` 表示。发布时校验后生成新的完整 snapshot；恢复旧 revision 也生成新的发布记录，绝不回写旧记录。
- 同一发布 snapshot 对 `child_person_id` 施加有效承谱边的部分唯一约束；提交事务内使用递归查询检测环。未知上行合法，不创建虚构父系节点。
- 同名不唯一、不自动合并；导入只能产出人工确认候选。
- `branch.kind` 固定区分 `agnatic`、`migration`、`administrative`；成员归属也带类型和来源。不得从父子关系自动推导管理房支。
- 权威业务数据采用软删除/禁用与审计。已发布 revision、原始来源和审计日志不可物理删除；媒体在解除全部引用、通过保留期后才可清理。
- 关键索引至少包括：承谱 `(revision_id, parent_person_id, order_key)` 与 `(revision_id, child_person_id)`、来源映射 `(person_id, status)`、来源主张 `(edition_id, subject_record_id)`、房支成员 `(branch_id, membership_kind, status)`、审计 `(object_type, object_id, created_at)`。

## 4. 图谱投影、布局与编辑契约

数据链路固定为：已授权关系投影 → 纯布局输入 → 布局坐标及正交路由 → SVG 渲染。坐标不是权威数据，不写入人物、关系或来源表。

### API 契约

- `GET /v1/lineages/{lineageId}/tree`：参数为 `view=canonical|source`、`revisionId` 或 `editionId`、`rootPersonId`、`expand[]`、`depth`、`branchId`。只返回已授权的节点、承谱边、稳定排序键、折叠状态和冲突/来源标记。
- `GET /v1/lineages/{lineageId}/tree/nodes/{personId}/children`：返回某节点的直接子支投影，供逐支展开和前端缓存。
- `GET /v1/persons/{personId}/panel`：按字段级权限返回右侧面板资料、可编辑字段和资源版本号。
- `POST /v1/change-requests/preview`：返回校验错误、循环检测、影响范围与来源差异，不修改正式世系。
- 提交、审核和发布接口均使用乐观并发控制（`If-Match` / 资源版本），并记录审计。

### 投影和布局输入输出

```text
TreeProjection
  nodes: id, label, generation, siblingOrder, childState, badges
  edges: id, parentId, childId, role=succession
  warnings: subjectId, type, severity

TreeLayout
  nodeBoxes: id, x, y, width, height
  edgePaths: edgeId, orthogonal points[]
  bounds, generationColumns, diagnostics
```

- 世代只由当前投影的承谱边计算；历史谱书视图不可借统一世系补齐缺边。
- 同辈顺序为审核排行、审核展示顺序、稳定 ID 的组合；展开无关房支不得改变既有排序。
- 选择节点只改变前端状态。右侧编辑面板创建草稿与变更请求，不直接改正式关系。
- 历史视图默认只读；显示原文、出处、映射状态和与统一世系的差异。
- 配偶、生父母、嗣父母与养父母交由完整亲属图的独立投影处理，不塞入传统树默认边。

## 5. 权限与媒体策略

- 初始主体：游客、族人、编辑员、管理员。游客是未登录主体，不建立账号角色；审核通过的账号默认取得族人角色，编辑员和管理员须由管理员额外授权。角色只授予动作，`account_scope` 决定可操作的房支/对象，字段策略决定可见资料。
- 后端在每个读取与写入接口执行角色、对象、房支和字段授权；搜索和媒体缩略图同样需要授权。
- 采用传统论坛式用户名、密码、族谱姓名注册。用户名唯一，族谱姓名允许重名，且注册时可填写未核验的房支与父辈/祖辈线索。新账号一律 `pending`，管理员选择实际 `person` 后才可激活；绝不按姓名自动关联。
- 密码采用 Workers 兼容的 PBKDF2-HMAC-SHA-256、每账号 16 字节随机 Salt、10,000 次迭代和版本化记录。该参数是审核制个人家族站确认的基础防护，**不宣称符合 OWASP 当前推荐强度**；禁止明文或伪称为 Argon2/scrypt。
- 登录采用短期可撤销会话 Cookie、CSRF 防护、登录限流与审计。管理员可人工重置密码并撤销目标账号全部会话；P0 不提供邮件验证、第三方登录或复杂自助恢复。
- R2 桶保持私有。浏览器通过短时上传凭证直接上传；Worker 负责鉴权、文件元数据注册与最终校验，不转发大文件。
- P0 图片需要校验 MIME、扩展名、大小、随机对象键与 SHA-256；视频受管理员和总配额约束。

## 6. 备份与恢复演练

备份包包含：D1 schema 与数据 SQL、R2 媒体文件、`manifest.json`、迁移版本、每个文件的 SHA-256、数量、总大小、生成时间及备份格式版本。

1. 管理员从远程 D1 导出逻辑 SQL，并通过 R2 S3 兼容接口拉取媒体。
2. 在本地生成和验证 manifest，打包并加密后保存到本地电脑；保留至少三个恢复点。
3. 定期恢复到独立测试 D1 和测试桶，验证 schema、人物/关系/谱书数量、对象哈希、引用完整性及权限。
4. 生产恢复前再次备份当前生产状态，先完成测试环境演练、影响预览和二次确认；恢复操作须审计。

免费 Workers 的 10 ms CPU、50 子请求和最多 5 个 Cron 不适合全量打包备份。完整备份运行在管理员受控本地任务或 GitHub Actions；后者所需令牌必须最小权限、可轮换且不输出日志。当前配额与限制在实施前以 Cloudflare 官方文档复核：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

## 7. 阶段状态、风险与下一步

| 项目 | 状态 |
|---|---|
| P0-0 架构确认 | 已完成；本文件为验收记录。 |
| P0-1 项目基础 | 进行中；单仓库、环境隔离、迁移与最小授权边界已建立，认证实现待性能验证。 |
| P0-2 至 P0-6 | 未开始，按 `ROADMAP.md` 顺序执行。 |

当前风险：本地离线备份须明确保管责任与加密密钥恢复方式；D1 免费日限要求导入和测试数据构造可分批中断；R2 免费额度要求在 P0-1 建立用量观测阈值。

下一步：在不触碰生产资源的前提下，初始化 P0-1 工程基础和本地测试环境；部署、远程 D1/R2 创建、Secrets 写入均在对应验收与授权后执行。
