# P0-4 历史双视图与完整亲属图状态

状态：进行中。最后更新：2026-10-23。

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

## 后续切片

1. 历史/统一差异 API：只对“来源记录已人工映射且关系语义已解释”的边输出 `same`、`canonical_only`、`historical_only`；其余输出 `uncomparable`。
2. 后台只读双视图：在 SVG 中显示历史图与差异标记；待解释、非图与无法比较主张显示在侧栏，不强行连线。
3. 完整亲属图：先补齐已发布 `canonical_relation_snapshot` 的写入、预览与回退语义，再采用独立的人物中心布局。
