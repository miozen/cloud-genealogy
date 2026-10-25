# P0-4 完整亲属图受限展开：设计审查

状态：推荐方案已获确认；切片 D 的管理员受限展开已实现。最后更新：2026-10-25。

## 1. 审查范围与现状

本审查只讨论已发布统一世系的**只读**人物中心亲属图扩展；不修改来源谱书投影，不创建或编辑关系，也不改变 P0-3 传统吊线图。

当前实现的可验证事实：

- `GET /api/admin/lineages/:lineageId/kinship?personId=...` 只读取当前 `lineage_published_pointer` 指向 revision 的 `canonical_relation_snapshot`，并只返回中心人物的一跳关联。见 `worker/app.ts`、`worker/lineage/kinship-projection.ts`。
- 路由目前要求 `system.manage`；它不是会员或访客读取接口。见 `worker/app.ts`。
- 人物有 `PUBLIC`、`MEMBER`、`ADMIN` 三档可见性，且已有 `canReadVisibility` 工具；但当前亲属图及人物详情均由管理员路由读取，图查询没有按可见性裁剪。见 `migrations/0003_forum_auth.sql`、`worker/auth/authorization.ts`、`worker/app.ts`。
- `canonical_relation_snapshot` 支持生父母、养父母、嗣父母、配偶四种关系，并随发布 revision 不可变保存。现有调用约定把前三种关系写作“`subject` 为子、`related` 为父母”，配偶无方向；数据库检查只禁止同一人物两端相同，未强制这一方向。见 `migrations/0004_core_genealogy_model.sql`、`worker/lineage/revision-publish.ts`、`tests/kinship-projection.test.ts`。
- 现有浏览器布局只为一跳关系固定安排中心和两侧节点，不能安全承载多跳网络。见 `src/kinship-layout.ts`。

因此，不能把当前一跳管理员图直接改成无限展开、会员图或访客图。

## 2. 已确认约束

1. 图只读已发布 revision；不得读取草稿、change request、历史来源关系或用当前 `person` 表补写 revision 中不存在的关系。
2. 生父母、嗣父母、养父母与配偶必须保留关系类型；过继不得抹去生父关系。
3. 图投影与布局仍应独立于 Vue DOM 和 P0-3 吊线图布局。
4. 服务端必须限制查询范围与结果规模；浏览器不能依靠“隐藏节点”实现授权。
5. 账号编辑范围 `account_scope` 是写入提案范围，不能被推断为亲属图读取授权。见 `worker/auth/authorization.ts`。

## 3. 已确认的最小实现

已确认先只扩展管理员后台，保持现有 `system.manage` 读取门槛，不在本切片把图开放给会员或访客。

### API 契约

在既有 endpoint 上新增可选 `radius`，只接受 `1` 或 `2`，默认 `1`。服务端以当前 revision 的关系快照做宽度优先遍历，且只返回图内节点和连接它们的关系：

```text
GET /api/admin/lineages/{lineageId}/kinship?personId={uuid}&radius=1|2

{
  view: "kinship",
  revisionId,
  pointerVersion,
  centerPersonId,
  radius,
  nodes: [{ id, displayName, distance }],
  relations: [{ subjectPersonId, relatedPersonId, relationKind }],
  truncated: boolean
}
```

- 硬上限为 **60 个节点**、**120 条关系**；到达任一上限立即停止并返回 `truncated: true`，不返回未读取节点的 ID、姓名、数量或关系类别。
- 结果排序必须稳定：先按距中心的层级，再按 `person.id`，关系按 snapshot `id`。这让布局与测试可重现。
- 每次请求从中心重新计算；不保存浏览器“已展开”状态，也不写数据库、审计或缓存关系结果。
- 仅返回当前图内两端均存在的关系；关系端点缺少人物行时不猜测、不以 ID 占位，并在服务端记录为一致性异常（本切片先返回通用错误或安全空结果，具体运维呈现不向客户端泄露）。

### 关系语义闸门（已实现的可验证范围）

已补齐纯函数校验，保证：

- 提案 UI 明确前三种关系为“子女 → 父母”；若其方向与同一候选 revision 的承谱边相反，预览会报 `canonical_parent_direction_conflicts_succession`，草稿不能提交审核或发布；
- `spouse` 视为无向关系，投影时去重；
- 不靠人物性别推断关系方向或展示角色。

由于没有年龄、性别或亲子方向可由 UUID 推断，**未与承谱边相交的独立亲子关系无法仅靠现有物理字段自动判定反向**；此类记录仍依赖明确的 UI/API 字段约定与审核。系统不自动改写既有 immutable snapshots。该限制已在实现与验收记录中保留。

### 隐私边界

本切片的管理员图保持现状：管理员可读所有可进入当前 snapshot 的人物节点。会员/访客读取不在本次实现范围内。

未来若开放非管理员读取，必须另行确认并实现服务端策略：逐节点调用 `canReadVisibility` 或等价 SQL 条件，移除不可见节点及关联边；默认不以“隐藏某某亲属”的占位或计数泄露其存在。人物详情的字段级可见性也必须一并落地，不能只过滤图节点。

## 4. 布局与交互建议

半径为 2 的小图采用独立分层布局：中心在中列，父母型关系按方向置左，中心作为父母的反向关系置右，配偶置近侧，同一层纵向稳定排序。它只处理上节的受限节点数，不复用传统吊线图的“世代横向分列、同辈纵排”算法。

首版保留现有选择人物作为下一次中心的交互；不提供无限自动展开、拖拽持久化、导出或编辑。若响应 `truncated`，页面只提示“结果受限，请选择图内人物重新居中”，不提供会绕过服务端上限的连续加载。

## 5. 验收数据与测试

实现后至少新增：

1. 由中心人物、生父、嗣父、养父、配偶、子女及孙辈组成的固定 snapshot，验证 radius 1/2、关系类型和稳定排序。
2. 配偶双向输入或逻辑重复输入不产生重复连线；不同父母类型同时可见。
3. 高扇出 fixture 触发节点/边上限并返回 `truncated`，不返回边界外信息。
4. 仅从当前 published revision 读取；发布新 revision 与回退后图随指针切换，旧 snapshot 不变。
5. 管理员以外的调用继续返回 403；未来若开放会员/访客，必须单独增加不可见节点、边与字段均不泄露的集成测试。
6. 纯投影、布局单测和 local Worker/D1 集成回归均通过；不使用 `--remote`。

## 6. 已确认决策与后续范围

项目负责人已确认：管理员专用、最大半径 2、60 节点/120 边、超限截断且不泄露边界信息，并采用“无效关系只在预览中报错、不自动改写历史 snapshot”的保守策略。

后续若要向族人或访客开放，必须先独立确认 `ADMIN`、`MEMBER`、`PUBLIC` 节点和人物字段的读取矩阵，并实现服务端节点/边/字段共同过滤；本切片没有改变该边界。
