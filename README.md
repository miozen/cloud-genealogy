# 云族谱项目 · Codex 交接包

状态：P0-0 至 P0-4 已完成既定首切片；P0-5 已完成受控提案、审核发布、房支成员/结构最小变更、审核人指派、可审计草稿废弃与本地验证。P0-5 的高风险扩展操作、P0-6 备份恢复和任何 preview/production 迁移、部署仍待单独确认（2026-10-25）。

阅读顺序：
1. `PRODUCT.md` 产品范围与业务规则
2. `ARCHITECTURE.md` 技术架构与部署边界
3. `DATA_MODEL.md` 数据实体与约束
4. `ROADMAP.md` 阶段计划与验收
5. `P0-0-DECISIONS.md` 已确认的架构、数据、权限和恢复规格
6. `P0-1-STATUS.md` 项目基础的实际进度、验证和风险
7. `P0-2-STATUS.md` 人物、来源、世系与投影进度
8. `P0-3-STATUS.md` 吊线图投影、布局与验收记录
9. `P0-4-DESIGN-REVIEW.md` 历史双视图与完整亲属图的既有边界和待确认语义
10. `P0-4-STATUS.md` 历史关系语义、投影与后续切片
11. `P0-5-DESIGN-REVIEW.md` 编修、审核与发布的已确认边界、最小增量与待确认事项
12. `P0-5-STATUS.md` 编修提案首切片的实现、验证和未完成项
13. `P0-5-BRANCH-MEMBERSHIP-DESIGN-REVIEW.md` 房支成员变更与对象级审批的待确认边界
14. `P0-5-BRANCH-STRUCTURE-DESIGN-REVIEW.md` 房支结构变更的待确认边界
15. `P0-5-REVIEWER-ASSIGNMENT-DESIGN-REVIEW.md` 对象级审批人、代理与失效规则的待确认设计
16. `P0-5-BRANCH-WORKBENCH-DESIGN-REVIEW.md` 房支成员与结构工作台的待确认交互边界
17. `P2-MEDIA-ASSET-DESIGN-REVIEW.md` 媒体资产、上传、关联、恢复与当前实施状态
18. `P2-MEDIA-CLEANUP-DESIGN-REVIEW.md` 媒体到期清理的待确认安全协议
19. `DEVELOPMENT-HANDBOOK.md` 接力电脑的环境、Git、SSH、验证与部署流程
20. `AGENTS.md` Codex 工作约束
21. `CODEX_START.md` 首轮可复制提示词

## 不可随意变更的已确认决策
- 单一家族，多房支、多本谱书、多座云祠；不是 SaaS 多租户。
- 人物约 1000 名，包含未能接续世系者；不得虚构父子关系。
- 统一人物档案；各谱书的历史原始记载独立保存；统一世系与历史谱书世系双视图。
- 传统吊线图参考用户提供的大谱师截图：**世代横向分列、同辈纵向排列、横竖直线连接、逐支展开**，右侧人物编辑面板；另有完整亲属关系视图。
- SVG 主渲染，独立布局引擎；不以 Canvas 为默认方案。
- Vue 3 / TypeScript / Vite；Hono / Cloudflare Workers；D1；R2；免费套餐优先。
- 后台一级菜单：概览、管理成员、内容、云谱、云祠、收益、设置。
- 备份、恢复、审核、修订、日志和迁移能力是正式上线门槛。

## 后续待定事项
- 家族名称、域名、网站视觉风格和上线时间。
- 历史谱书的详细录入字段与首批资料样本；首批资料以人工录入为主，Excel 导入后置。
- 视频的具体容量配额及家族财务公开范围；P0 视频仅管理员受控上传或外链。

已确认的 P0-0 决策见 `docs/P0-0-DECISIONS.md`。其余未定事项不得由 Codex 擅自当作已确认需求；先提出建议与影响，再请求确认。
