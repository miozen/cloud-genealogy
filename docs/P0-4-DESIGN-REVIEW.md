# P0-4 历史双视图与完整亲属图：设计审查

状态：切片 A 已按“未知关系一律待解释”实施；完整亲属图及前端双视图仍待后续切片。最后更新：2026-10-23。

## 目标与既有事实

P0-4 要提供两种严格分层的阅读视图：

- **统一世系**：只读当前已发布 `lineage_succession_snapshot`，这是 P0-3 吊线图的既有行为。
- **指定谱书版本历史世系**：只读该 `genealogy_edition` 中未撤销的 `source_person_record` 与 `source_relation_claim`；来源人物尚未映射为统一人物时仍必须显示，不能用统一世系补齐。
- **完整亲属图**：以一个统一人物为中心，展示生父母、嗣父母、养父母、配偶及子女；它不是把所有关系压进传统承谱树，布局也不能复用吊线图规则。

前两层已分别有只读端点：`GET /api/admin/lineages/:lineageId/hanging-chart` 与 `GET /api/admin/genealogy-editions/:editionId/historical-projection`（见 `worker/app.ts`）。后者目前只返回原始关系主张列表，尚不是可布局的图谱。

## 已确认约束

1. `source_relation_claim.relation_kind` 是自由文本，且 `related_record_id` 可为空（见 `migrations/0004_core_genealogy_model.sql`、`worker/auth/validation.ts`）。源码没有把“父记子”“子记父”“嗣父”“配偶”等原文关系转换为方向化语义的规则。
2. `source_person_record` 可以没有 `source_person_link`。历史图的节点主键必须是来源记录 ID，不能强制使用统一 `person.id`。
3. `canonical_relation_snapshot` 已能表达 `biological_parent`、`adoptive_parent`、`successor_parent`、`spouse`，但当前发布接口只写入 `lineage_succession_snapshot`；仓库中没有写入或读取已发布亲属快照的业务流程（见 `migrations/0004_core_genealogy_model.sql`、`worker/app.ts`）。
4. 差异比对只能基于**已确认的来源人物映射**和**已确认的关系语义**。未映射来源记录不是“统一世系中不存在”，而应标记为“仅来源记录，无法比对”。
5. 所有 P0-4 读取仍须经过服务端鉴权；历史原文、来源人物和统一关系不得互相覆盖或回写。

## 推荐的增量实现顺序

### 切片 A：历史关系语义字典与纯投影

新增一个管理员维护、可审计的关系解释字典。每条规则把原始 `relation_kind` 映射为 `parent_to_child`、`child_to_parent`、`spouse` 或 `non_graph`；规则必须说明是否为生父、嗣父或养父。没有匹配规则的主张保留原文但不进入世系连线，并显示“待解释”。

在纯 TypeScript 模块中把来源记录、已解释主张和确认映射投影成历史图；该模块不读取 D1、不调用 Vue DOM，也不生成吊线图坐标。输出保留 `claimId`、原文、来源记录 ID、映射状态和解释状态，以便差异标记与审计追溯。

### 切片 B：历史/统一差异 API 与只读切换

已实现受权的 `comparison` API；比较结果只包含 `same`、`canonical_only`、`historical_only`、`uncomparable` 四类，且不把 `uncomparable` 当作差异或缺失。前端只读切换仍待实现；历史图只应显示能被字典安全解释的父子关系，原始文本和待解释主张在侧栏呈现。

### 切片 C：完整亲属图读模型

先补齐经过 revision 发布的 `canonical_relation_snapshot` 写入和回退语义，再建立独立的以人为中心亲属投影。它返回关系类型与方向，限制初始半径/节点数，并提供“继续展开”读取接口。布局采用独立策略，不改动 P0-3 的世代横列规则。

## 需要确认的业务语义

切片 A 前，需要项目负责人确认：

1. 第一批原谱关系词的规范字典：哪些原始 `relation_kind` 分别表示“父记子”“子记父”“配偶”“嗣父/养父”，以及无法确定时是否一律列为待解释。
2. 历史图第一版范围：推荐先支持**只读、显式已解释的父子关系**和差异标记；配偶/过继关系先在侧栏呈现，待完整亲属图切片再绘制。

在上述确认前，不能通过名称、显示顺序或统一承谱关系猜测历史边方向，也不能把统一人物补写进原谱视图。

## P0-4 验收口径

- 同一已映射、已解释关系在统一与历史视图中均可追溯到各自 revision 或 claim。
- 历史来源记录未映射时仍可显示；统一关系变化后其历史图不变。
- 生父与嗣父可同时保留并明确标识；它们不得因传统承谱选择而互相替换。
- 无法解释、映射或比较的记录显式提示，不伪造方向或差异。
- 完整亲属图独立布局，且不改变任何权威数据。
