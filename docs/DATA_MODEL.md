# 数据模型设计基线（逻辑模型，不是最终 DDL）

## 1. 统一人物与来源
- `person`: 稳定内部人物 ID、主显示名、基本状态、创建/修改元数据。
- `person_name`: 谱名、字、号、别名、原文姓名，关联来源。
- `person_fact`: 生卒、地点、事迹等事实的标准化值、原始文本、精度、来源、可见级别。
- `place`: 地名及历史地名信息。
- `media_asset`: R2 对象键、文件哈希、MIME、尺寸、大小、隐私。
- `media_cleanup_run` / `media_cleanup_item`: 到期媒体清理的冻结候选、备份恢复点和双人确认；不等同于删除执行记录。
- `person_media`: 人物与附件关联。
- `account`：用户名（唯一）与族谱姓名（可重名）分开保存；注册填写的房支、父辈/祖辈名称仅为待核验线索。账号状态为 `pending`、`active`、`disabled`、`rejected`。
- `account_person_link`：仅管理员人工审核后建立的账号与具体人物关联；不按姓名自动匹配，不等同于对人物资料的编辑权。

## 2. 亲属关系与承谱
- `kinship_relation`: 生父母、养父母、嗣父母等关系，状态、有效期/依据。
- `union`、`union_member`: 婚配关系、参与人物、顺序与出处；允许信息不详。
- `lineage`: 宗族世系与基准始祖。
- `lineage_succession`: 统一世系的承谱父子边，版本/状态、来源和审核结论。
- `lineage_order`: 审核排行、展示顺序、未知状态。
- `branch`: 房支类型、上级、始分祖、名称。
- `branch_membership`: 人物与房支关联、归属类型、出处、状态。

约束：同一已发布统一世系中，一个人物最多一条有效承谱上行边；无环；不以性别限制底层人物数据；未知父系合法；断代不补造节点。对于历史版本的边必须以版本/来源区分，不受统一世系唯一父节点约束。

## 3. 谱书原始记录
- `genealogy`: 谱书资源及范围。
- `genealogy_edition`: 具体历史版本/编纂版本。
- `genealogy_volume`、`genealogy_page`: 卷册、页码、扫描件。
- `source_person_record`: 某版本中出现的人物原始记录，允许尚未关联 `person`。
- `source_relation_claim`: 原谱中记载的父子、排行、婚配、过继等关系说法，引用来源记录，不强制先有统一人物映射。
- `source_fact_claim`: 原谱记载的事实与文字。
- `source_reference`: 版本、卷、页、原文位置等出处。
- `source_person_link`: 来源人物记录与统一人物的人工确认关联，可撤销并留审计。

历史视图的关系投影必须来自指定谱书版本的来源主张；不因统一关系变更而悄悄改变。

## 4. 考证与版本
- `research_case`、`research_evidence`、`research_decision`: 争议及考证。
- `change_request`、`change_item`: 变更草稿、预览与审核。
- `lineage_revision`、`lineage_revision_change`: 已发布世系版本和变更集。
- `audit_log`: 谁在何时对何对象做了什么操作。
- 需设计可回退的版本投影策略：变更日志 + 周期快照或版本化有效边，不能只靠覆盖当前行。

## 5. 内容与管理
- `content_post`、`comment`、`feedback`、`album`、`album_item`。
- `shrine`、`shrine_person`、`shrine_event`。
- `donation_project`、`donation_record`、`finance_transaction`。
- `role`、`permission`、`account_scope`、`setting`、`backup_record`。游客为匿名主体；持久化角色为族人、编辑员、管理员。

## 6. 建模与迁移注意
- 以上是逻辑实体清单，不要求一实体一张表；由 Codex 提出可维护的 D1 物理模型和索引方案供确认。
- 不使用姓名、世次或房支名称作为人物主键。
- 需明确定义删除策略、唯一约束、外键、历史版本读模型和隐私字段边界。
- 导入暂存区须支持批次内来源编号、错误定位、重复候选与人工确认。
