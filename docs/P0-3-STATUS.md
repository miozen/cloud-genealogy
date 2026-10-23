# P0-3 传统吊线图状态

状态：进行中。最后更新：2026-10-23。

## 已完成

- `worker/lineage/hanging-chart-projection.ts`：从人物和承谱边生成无坐标世代列、节点与稳定排序边。
- `worker/lineage/hanging-chart-layout.ts`：输出世代横向分列、同辈纵排坐标与正交连接点列；坐标只存在于布局输出。
- `expandHangingChart`：按根人物返回该人物及后代的纯数据投影，不修改权威数据。
- 单元测试验证三代世代列、同辈纵排、正交点列和逐支展开。

## 实际验证

- `npm run lint`、`npm run check`（28 个测试）、`npm run build` 均通过。
- 未部署；未访问 Preview、生产 D1/R2。

## 接力起点

从 `dev` 创建 `feat/p0-3-chart-api-svg`。优先实现受权 API，将已发布承谱投影串到吊线图投影与布局输出；随后才实现 SVG 视图、缩放、搜索定位和右侧人物面板。不得将布局坐标写入人物、世系或任何权威表。
