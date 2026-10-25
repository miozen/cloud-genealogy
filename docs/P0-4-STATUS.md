# P0-4 历史双视图与完整亲属图状态

状态：切片 A/B/C/D 与历史受限阅读已完成。最后更新：2026-10-25。

## 已完成：切片 A（历史关系语义与纯投影）

- `0008_source_relation_semantics.sql` 新增独立的 `source_relation_semantic_rule`。它不修改 `source_relation_claim`，只将已确认的原始关系词解释为 `parent_to_child`、`child_to_parent`、`spouse` 或 `non_graph`。
- 父子解释必须显式声明 `biological_parent`、`adoptive_parent` 或 `successor_parent`；配偶和非图关系禁止伪造父系类型。
- 管理员可受权创建、列出和退役语义规则；创建与退役均写审计。规则退役不删除来源主张。
- `historical-lineage-projection.ts` 是不依赖 D1/Vue 的纯投影：仅对有活动语义规则的来源主张生成关系边。未知关系词、已退役规则、缺失关联来源记录和明确非图关系分别保留为 `pending_interpretation`、`incomplete` 或 `not_graphable` 注记。
- 历史投影 API 仍只读取指定谱书版本的未撤销来源记录/主张，并返回来源记录 ID、人工确认映射状态、可解释关系边及注记。它绝不使用统一承谱补齐历史边。

## 实际验证

- `npm run lint` 通过。
- `npm run check` 通过：16 个测试文件、35 个测试；新增单测覆盖显式方向化、未映射来源人物、未知关系、明确非图关系与缺失关联记录的区分。
- `npm run build` 通过。
- `npm run test:local-auth` 通过：在隔离 local D1/Worker 中验证管理员建立语义规则后历史投影生成定向父子边；规则退役后，同一来源主张变为 `pending_interpretation`，而原始主张未被删除。
- 未部署；未访问 Preview、生产 D1/R2。

## 已完成：切片 B（历史/统一差异 API）

- 新增管理员受权的 `GET /api/admin/lineages/:lineageId/historical-comparison?editionId=...`。它读取当前已发布统一承谱快照和指定谱书版本，不写入任一层数据。
- 比较结果仅为 `same`、`canonical_only`、`historical_only`、`uncomparable`。只有来源父子边的两端都已人工确认映射到统一人物时，才可能判定前三类；未映射记录绝不被误标为差异。
- `npm run check` 已通过：17 个测试文件、36 个测试。`LOCAL_AUTH_TEST_PORT=8799 npm run test:local-auth` 已通过，验证已映射的相反来源关系与统一承谱分别显示为 `historical_only` 和 `canonical_only`。

## 已完成：切片 C（最小人物中心亲属图）

- revision 发布接口现在可写入 `canonical_relation_snapshot`；回退从目标 revision 重建承谱与亲属关系 snapshot，旧 revision 保持不可变。
- 新增管理员受权的 `GET /api/admin/lineages/:lineageId/kinship?personId=...`：仅从当前发布 revision 读取与中心人物直接相连的生父母、嗣父母、养父母或配偶关系。
- 亲属图投影与布局独立于传统吊线图；前端以人物为中心只读展示，不修改统一世系或来源记录。
- `npm run test:local-auth` 覆盖生父、嗣父和配偶共同发布到 canonical relation snapshot、读取亲属图以及回退后关系仍保持可读；本地验证未使用 `--remote`。
- 亲属图 SVG 直接标示生父母、嗣父母、养父母或配偶，避免将生父与嗣父混同。

## 后续切片

1. 已完成历史受限阅读：管理员历史投影默认最多返回 100 个来源记录和 200 条范围内主张，可选 `rootRecordId` 时只读取来源图两跳；达到限制只返回 `truncated`，不返回范围外标识。`historical-reading-layout.ts` 只接收来源记录和显式解释的边，使用 SCC 将环保留为冲突组、独立输出配偶线和未连通来源记录，不读取 canonical snapshot。管理员页已采用该受限阅读图；统一差异接口仍独立读取完整比较数据，不受阅读截断影响。

## 历史阅读实际验证

- `npm run lint`、`npm run check`、`npm run build` 通过：24 个测试文件、57 项测试。
- `LOCAL_AUTH_TEST_PORT=18982 npm run test:local-auth` 通过：隔离 local Worker/D1 验证既有历史投影/差异/关系语义链路仍兼容；并固定验证两跳 `rootRecordId` 边界、100 节点与 200 主张截断，以及响应不包含范围外关系端点。为覆盖实际 D1 参数上限，历史读取的关系和记录加载均按小批量合并排序；未使用 `--remote`。
- 第 26 项已完成：历史图节点显示来源记录 ID，并可通过鼠标、Enter 或空格直接选入既有 `rootRecordId` 输入；仍须由管理员明确点击“读取历史差异”才重新请求，避免自动连续加载或扩大范围。`npm run lint`、`npm run check`、`npm run build` 均通过；未调用远端资源。
2. 已完成切片 D：管理员可读取当前 published revision 的亲属图 `radius=1|2`，服务端按层查询并限制在 60 节点/120 关系；超过限制只返回 `truncated`，不泄露边界外信息。布局按距中心分层且画布高度随节点数增长。管理员以外继续被拒绝。关系预览会拒绝与同一候选承谱边方向相反的父母关系，反向配偶重复会被合并；无法从既有 UUID 判断的独立亲子方向仍需审核，详见 [设计审查](/home/mio/projects/cloud-genealogy/docs/P0-4-KINSHIP-EXPANSION-DESIGN-REVIEW.md)。

## 切片 D 实际验证

- `npm run lint`、`npm run check`、`npm run build` 通过：23 个测试文件、56 项测试。
- `LOCAL_AUTH_TEST_PORT=18979 npm run test:local-auth` 通过：隔离 local Worker/D1 验证默认半径、半径 2、非法半径拒绝、提案方向冲突预览、发布和回退后的读取；未使用 `--remote`。
