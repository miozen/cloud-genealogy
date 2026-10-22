# P0-1 项目基础状态

状态：进行中。最后更新：2026-10-22。

## 已完成

- 建立 Vue 3/Vite 前端与 Hono/Workers API 的单仓库基础。
- 建立本地 D1/R2 binding，以及明确分离的 development、preview、production 配置。preview/production 使用占位资源 ID；创建真实 Cloudflare 资源并替换 ID 属于后续获得明确授权后的操作。
- 新增首个 D1 迁移：账号、角色、权限、范围和可撤销会话的最小身份模型。
- 实现安全响应头、健康检查和默认拒绝未认证身份读取的 API 边界。
- 增加权限判定及 Worker 路由单元测试。
- 已确认认证为传统论坛式用户名密码注册审核，不采用 Passkey、WebAuthn、Cloudflare Access 或第三方认证。密码记录采用 Workers 原生 PBKDF2-HMAC-SHA-256、100,000 次迭代、每账号 16 字节随机盐、版本化编码、常量时间比对及格式校验。该参数是个人家族站面对 Workers 上限所接受的折中，不宣称达到 OWASP 当前推荐强度。
- 实现不透明 session/CSRF token 生成及仅存哈希的校验工具；实现基于 HMAC 派生的登录限流键和 5 次/15 分钟的纯规则，并新增本地 D1 限流状态表。
- 实现有效 session 读取中间件、默认拒绝未认证访问，以及 CSRF 中间件。注册和登录是建立认证前的严格校验入口；其他非安全 API 方法均需有效会话与 CSRF token。会话读取仅接受未撤销、未过期且账号仍为 `active` 的记录。
- 新增论坛式注册、登录、退出、待审核账号列表、管理员批准/拒绝与管理员重置密码 API。注册账号默认为 `pending`；批准时必须选择已存在的稳定人物 ID，默认授予族人角色，编辑员/管理员为额外授权。重置密码会撤销目标账号的现有会话。
- 新增最小 `person` 身份锚点、`account_person_link` 和审计表；未实现人物事实、关系或谱系业务。注册填写的房支和祖辈名称仅是审核线索，不能自动建立人物身份或亲属关系。
- 新增一次性首个管理员 bootstrap API，以及最小注册、登录、人物锚点创建与账号审核界面。bootstrap 仅允许在没有活跃管理员、配置 `BOOTSTRAP_SECRET` 且请求携带匹配 header 时执行；成功后应立即删除该 Secret。
- 已创建隔离的 preview D1、私有 R2 和 `cloud-genealogy-preview` Worker；仅部署 `dev` 用于运行时验证，未创建或访问 production 资源。
- preview 资源仅用于 `dev` 验证；`0003_forum_auth.sql` 已应用到 preview D1，Worker 已部署版本 `5277339b-1dfe-40a3-aca6-78d18f1c29ba`，部署后健康检查返回 200。未创建或访问 production 资源。

## 实际验证结果

| 命令 / 检查 | 结果 |
|---|---|
| `npm run lint` | 通过：ESLint 无 warning。 |
| `npm run check` | 通过：TypeScript 类型检查和 14 个 Vitest 测试。 |
| `npm run build` | 通过：Vite 生产构建。 |
| 本地 `wrangler dev --local` | 通过：`GET /api/health` 返回 200；未认证 `GET /api/me` 返回 401。 |
| `wrangler d1 migrations apply DB --local` | 通过：`0001_identity.sql` 的 11 条命令执行成功，关键表可查询。 |
| 本地 D1 限流迁移 | 通过：`0002_auth_rate_limit.sql` 的 3 条命令执行成功，`auth_login_rate_limit` 表可查询。 |
| 本地 Worker 会话集成 | 通过：临时账号/会话下 `GET /api/me` 返回 200；无会话返回 401；测试记录完成清理并经查询确认。 |
| 本地 PBKDF2 基准 | 100,000 次迭代由单元测试实际执行；本机墙钟时间不作为 Workers CPU 配额结论。 |
| 本地 D1 认证迁移 | 通过：`0003_forum_auth.sql` 的 16 条命令完成，角色种子正确，`PRAGMA foreign_key_check` 无结果。 |
| 本地 Worker 认证流 | 通过：健康检查 200；测试用户注册返回 201 / `pending`；正确密码登录在审核前返回 403，不发放会话。 |
| preview Worker 认证流 | 通过：`POST /api/auth/register` 在真实 Workers Web Crypto 下以 100,000 次 PBKDF2 返回 201 / `pending`；正确密码登录返回 403，不发放会话。测试账号及其审计记录已清理。 |

## 未完成与风险

- 浏览器注册/登录/管理员审核界面与首个管理员受控初始化流程已实现；完整“管理员关联人物、批准、角色、密码重置”的端到端流程仍待在可用 preview 或本地 Worker 运行时复测。
- 本轮 UI 与 bootstrap 代码已完成静态验证，但尚未部署至 preview：Cloudflare API 在写入临时 `BOOTSTRAP_SECRET` 和 Worker 部署时返回 `10013`。本地 Worker 全链路重启也受当前受控终端无法保持新进程监听影响；两者均需在可用运行时复测。
- 100,000 次 PBKDF2 是项目确认的运行时折中，低于 OWASP 当前推荐工作因子；登录限流与强密码长度限制只能降低风险，不能消除此差距。
- 已创建 preview 资源并完成最小部署验证；production 的 D1、R2、Secrets 与 Worker 均未创建或部署。
- `person` 目前仅为账号审核所需的身份锚点；人物资料、关系图、搜索和导出尚未实现，后续必须统一应用 `PUBLIC` / `MEMBER` / `ADMIN` 授权，防止旁路。
- 批准 API 以单一 D1 `batch` 写入账号状态、默认族人角色、可选额外角色、人工人物关联和审计，并以更新后的版本约束所有附属写入；仍需在首个管理员与人物锚点准备好后补充端到端集成测试。
- 当前工作区的 `.git` 是只读环境挂载的空占位目录，无法直接初始化为 Git 仓库。已通过 SSH 443 完成首个提交 `d36e67c` 的推送并建立远程 `main`、`dev`；该操作使用临时 Git 元数据目录完成。后续接力电脑应正常克隆远程仓库，不受此特殊工作区限制。

## 下一步

1. 补充本地认证集成测试：批准关联、角色、CSRF、退出、密码重置会话撤销、重复用户名与登录限流；将批准写入收敛为原子 D1 操作。
2. 按受控初始化流程创建首个 preview 管理员和测试人物锚点，再验证完整预览认证链路；不得创建 production 资源。
3. 完成最小前端认证/审核界面，随后在人物、图谱、搜索、导出 API 中复用三级可见性判定。
4. 在 GitHub 对 `main`、`dev` 启用分支保护、PR、必需 CI 检查和禁止 force push；后续开发从 `dev` 创建短分支。
