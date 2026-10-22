# P0-1 项目基础状态

状态：进行中。最后更新：2026-10-22。

## 已完成

- 建立 Vue 3/Vite 前端与 Hono/Workers API 的单仓库基础。
- 建立本地 D1/R2 binding，以及明确分离的 development、preview、production 配置。preview/production 使用占位资源 ID；创建真实 Cloudflare 资源并替换 ID 属于后续获得明确授权后的操作。
- 新增首个 D1 迁移：账号、角色、权限、范围和可撤销会话的最小身份模型。
- 实现安全响应头、健康检查和默认拒绝未认证身份读取的 API 边界。
- 增加权限判定及 Worker 路由单元测试。

## 实际验证结果

| 命令 / 检查 | 结果 |
|---|---|
| `npm run check` | 通过：TypeScript 类型检查和 4 个 Vitest 测试。 |
| `npm run build` | 通过：Vite 生产构建。 |
| 本地 `wrangler dev --local` | 通过：`GET /api/health` 返回 200；未认证 `GET /api/me` 返回 401。 |
| `wrangler d1 migrations apply DB --local` | 通过：`0001_identity.sql` 的 11 条命令执行成功，关键表可查询。 |

## 未完成与风险

- 未实现正式密码登录、会话创建/撤销、CSRF 验证和登录限流。已确认优先使用 Workers 原生 PBKDF2 并尽可能保持免费；Cloudflare Workers 不支持 Argon2，且 Workers Free 的 10 ms CPU 上限使密码哈希强度必须在 preview 实测后才能作为生产方案。若不能达标，不自动升级付费套餐。
- 未创建 Cloudflare preview/production 的 D1、R2 或 Secrets，未部署。
- 角色/权限初始数据、管理员创建流程和真实访问范围将在认证路径确认后实现。
- 当前工作区的 `.git` 是只读环境挂载的空占位目录，无法直接初始化为 Git 仓库。已通过 SSH 443 完成首个提交 `d36e67c` 的推送并建立远程 `main`、`dev`；该操作使用临时 Git 元数据目录完成。后续接力电脑应正常克隆远程仓库，不受此特殊工作区限制。

## 下一步

1. 为 Worker 原生 PBKDF2 密码验证建立最小基准测试，确认在目标免费配额下是否稳定低于 CPU 限制。
2. 若不可满足，提交认证替代方案与影响，等待确认；若可满足，完成登录、会话、CSRF、限流及相应集成测试。
3. 完成后再申请创建 preview 资源和部署验证的授权。
4. 在 GitHub 对 `main`、`dev` 启用分支保护、PR、必需 CI 检查和禁止 force push；后续开发从 `dev` 创建短分支。
