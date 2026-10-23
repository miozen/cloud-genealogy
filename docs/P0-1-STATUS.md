# P0-1 项目基础状态

状态：已完成。最后更新：2026-10-23。

## 已完成

- 建立 Vue 3/Vite 前端与 Hono/Workers API 的单仓库基础。
- 建立本地 D1/R2 binding，以及明确分离的 development、preview、production 配置。preview/production 使用占位资源 ID；创建真实 Cloudflare 资源并替换 ID 属于后续获得明确授权后的操作。
- 新增首个 D1 迁移：账号、角色、权限、范围和可撤销会话的最小身份模型。
- 实现安全响应头、健康检查和默认拒绝未认证身份读取的 API 边界。
- 增加权限判定及 Worker 路由单元测试。
- 已确认认证为传统论坛式用户名密码注册审核，不采用 Passkey、WebAuthn、Cloudflare Access 或第三方认证。密码记录采用 Workers 原生 PBKDF2-HMAC-SHA-256、10,000 次迭代、每账号 16 字节随机盐、版本化编码、常量时间比对及格式校验。该参数是审核制个人家族站确认的基础防护，不宣称达到 OWASP 当前推荐强度。
- 实现不透明 session/CSRF token 生成及仅存哈希的校验工具；实现基于 HMAC 派生的登录限流键和 5 次/15 分钟的纯规则，并新增本地 D1 限流状态表。
- 实现有效 session 读取中间件、默认拒绝未认证访问，以及 CSRF 中间件。注册和登录是建立认证前的严格校验入口；其他非安全 API 方法均需有效会话与 CSRF token。会话读取仅接受未撤销、未过期且账号仍为 `active` 的记录。
- 新增论坛式注册、登录、退出、待审核账号列表、管理员批准/拒绝与管理员重置密码 API。注册账号默认为 `pending`；批准时必须选择已存在的稳定人物 ID，默认授予族人角色，编辑员/管理员为额外授权。重置密码会撤销目标账号的现有会话。
- 新增最小 `person` 身份锚点、`account_person_link` 和审计表；未实现人物事实、关系或谱系业务。注册填写的房支和祖辈名称仅是审核线索，不能自动建立人物身份或亲属关系。
- 新增一次性首个管理员 bootstrap API，以及最小注册、登录、人物锚点创建与账号审核界面。bootstrap 仅允许在没有活跃管理员、配置 `BOOTSTRAP_SECRET` 且请求携带匹配 header 时执行；成功后应立即删除该 Secret。
- 新增可重复的 `npm run test:local-auth`：使用独立 Wrangler 本地状态目录，自动验证 bootstrap、注册待审、CSRF、人工人物关联、审核批准、登录、管理员重置密码、会话撤销和退出，并在结束时清理测试记录。
- 已创建隔离的 preview D1、私有 R2 和 `cloud-genealogy-preview` Worker；仅部署 `dev` 用于运行时验证，未创建或访问 production 资源。
- preview 资源仅用于 `dev` 验证；`0003_forum_auth.sql` 已应用到 preview D1，Worker 已部署版本 `91fe603e-e0d0-44cd-9c02-86600ae4525c`，部署后健康检查返回 200。未创建或访问 production 资源。

## 实际验证结果

| 命令 / 检查 | 结果 |
|---|---|
| `npm run lint` | 通过：ESLint 无 warning。 |
| `npm run check` | 通过：TypeScript 类型检查和 16 个 Vitest 测试。 |
| `npm run build` | 通过：Vite 生产构建。 |
| 本地 `wrangler dev --local` | 通过：`GET /api/health` 返回 200；未认证 `GET /api/me` 返回 401。 |
| `wrangler d1 migrations apply DB --local` | 通过：`0001_identity.sql` 的 11 条命令执行成功，关键表可查询。 |
| 本地 D1 限流迁移 | 通过：`0002_auth_rate_limit.sql` 的 3 条命令执行成功，`auth_login_rate_limit` 表可查询。 |
| 本地 Worker 会话集成 | 通过：临时账号/会话下 `GET /api/me` 返回 200；无会话返回 401；测试记录完成清理并经查询确认。 |
| 本地 PBKDF2 基准 | 10,000 次迭代由单元测试实际执行；本机墙钟时间不作为 Workers CPU 配额结论。 |
| 本地 D1 认证迁移 | 通过：`0003_forum_auth.sql` 的 16 条命令完成，角色种子正确，`PRAGMA foreign_key_check` 无结果。 |
| `npm run test:local-auth` | 通过：独立本地 Worker/D1 认证全流程通过；未使用 `--remote`，测试数据已由脚本清理。 |
| 本地 Worker 认证流 | 通过：健康检查 200；测试用户注册返回 201 / `pending`；正确密码登录在审核前返回 403，不发放会话。 |
| preview Worker 认证流 | 通过：`POST /api/auth/register` 在真实 Workers Web Crypto 下以 100,000 次 PBKDF2 返回 201 / `pending`；正确密码登录返回 403，不发放会话。测试账号及其审计记录已清理。 |
| preview 完整审核流 | 通过：一次性 bootstrap 建立临时管理员；CSRF 缺失的管理员写入返回 403；建立人物锚点、人工关联待审账号并授予编辑员后，该账号可登录。管理员重置密码返回 204，旧会话返回 401、旧密码返回 401、新密码返回 200。临时账号、人物、会话、角色关联、审计记录及 Bootstrap Secret 均已清理。 |

## 未完成与风险

- 浏览器注册/登录/管理员审核界面与首个管理员受控初始化流程已实现，并已通过 preview 端到端复测。
- 10,000 次 PBKDF2 是审核制个人站点确认的基础防护，低于 OWASP 当前推荐工作因子；登录限流与强密码长度限制只能降低风险，不能消除此差距。
- 已创建 preview 资源并完成最小部署验证；production 的 D1、R2、Secrets 与 Worker 均未创建或部署。
- `person` 目前仅为账号审核所需的身份锚点；人物资料、关系图、搜索和导出尚未实现，后续必须统一应用 `PUBLIC` / `MEMBER` / `ADMIN` 授权，防止旁路。
- 批准 API 以单一 D1 `batch` 写入账号状态、默认族人角色、可选额外角色、人工人物关联和审计，并以更新后的版本约束所有附属写入；本地隔离状态端到端测试已覆盖该流程。
- 当前工作区的 `.git` 是只读环境挂载的空占位目录，无法直接初始化为 Git 仓库。已通过 SSH 443 完成首个提交 `d36e67c` 的推送并建立远程 `main`、`dev`；该操作使用临时 Git 元数据目录完成。后续接力电脑应正常克隆远程仓库，不受此特殊工作区限制。

## 下一步

1. 开始 P0-2 人物/关系/来源实施，并在人物、图谱、搜索、导出 API 中复用三级可见性判定。
2. 由项目负责人决定正式首个管理员的用户名、族谱姓名与安全密码后，才可在相应环境进行一次性 bootstrap；生产初始化仍需单独明确授权。
3. 在 GitHub 对 `main`、`dev` 启用分支保护、PR、必需 CI 检查和禁止 force push；后续开发从 `dev` 创建短分支。
