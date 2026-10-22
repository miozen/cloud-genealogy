# 开发与交接手册

最后更新：2026-10-22。本文是任一接力电脑从零接手本项目的唯一操作基线；生产资源、Secrets、远程数据库和 R2 均不应在未明确授权时操作。

## 0. 人机接力方式

- 项目负责人只需提出需求或回复“继续”；Codex 负责将当前阶段拆成可验收的小任务并实施。
- 每个小任务完成后，Codex 必须简短报告：已完成内容、实际验证结果、风险/未完成项，以及唯一的下一步提示。
- 若不存在需要业务负责人决定的事项，下一步提示使用“回复 `继续` 即可”；不得要求项目负责人重复上下文或自行执行开发命令。
- 只有以下情况才暂停请求决定：会改变已确认产品规则、产生费用、访问/写入生产资源、删除不可恢复数据，或存在无法由仓库与安全检查消除的歧义。
- 每阶段同步更新决策、进度、风险和下一步到 `docs/`，使其他电脑克隆后可直接接力。

## 0.1 本地优先验证规则

- 每个任务开始前先查看当前分支、未提交修改、`package.json` 脚本和已有测试文档；保护已有修改，不执行未经授权的清理、覆盖或重置。
- 每个功能或修改完成后，优先执行本地类型检查、单元测试、已配置的代码规范检查、构建，以及与改动相关的本地集成测试。
- D1、R2、媒体和测试数据默认使用 Wrangler local bindings。除非明确授权，不得操作 preview/production 的数据库、R2、Secrets 或部署。
- 只有本地验证通过且确实需要验证 Cloudflare 平台行为时，才申请 preview 环境授权；production 操作始终需要单独明确授权。
- 交付报告必须区分“已执行且通过”“已执行但失败”“未执行及原因”；未执行项绝不写为通过。
- 当前已有本地命令：`npm run lint`（ESLint 代码规范检查）、`npm run check`（类型检查和单元测试）、`npm run build`（生产构建）、`npm run dev:worker`（本地 Worker）、`wrangler d1 ... --local`（本地迁移/查询）。交付前至少运行与改动相关的 lint、check 和 build，并如实记录结果。

## 1. 工作站前置条件

- Git 2.43+。
- NVM 管理的 Node.js 22 LTS。当前已验证版本为 Node `22.23.4`、npm `10.9.9`。
- Cloudflare 账户与 GitHub SSH 私钥仅在需要部署或推送时配置；不得把密钥放入仓库、`.dev.vars`、日志或截图。

首次安装或切换 Node：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
nvm alias default 22
node --version
npm --version
```

接手项目后：

```bash
nvm use 22
npm ci
npm run check
npm run build
```

`npm ci` 只在存在 `package-lock.json` 时使用，确保所有接力电脑安装同一组依赖。需要更新依赖时使用 `npm install`，审查 `package-lock.json` 差异后再提交。

## 2. 本地开发与验证

```bash
npm run dev
npm run dev:worker
```

前端默认端口由 Vite 分配；前端的 `/api` 请求代理至 `http://127.0.0.1:8787`。Worker 本地运行使用 Wrangler local bindings，绝不接触远程 D1 或 R2。

常用检查：

```bash
npm run check
npm run build
npx wrangler d1 migrations apply DB --local
npx wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master WHERE type = 'table';"
```

若受限环境不允许 Wrangler 写用户目录，可将配置临时放在可写目录：

```bash
XDG_CONFIG_HOME=/tmp/cloud-genealogy-wrangler WRANGLER_SEND_METRICS=false npx wrangler dev --local
```

本地 `.wrangler/`、`dist/`、`node_modules/`、`.env` 与 `.dev.vars` 均不可提交。

## 3. GitHub SSH（443）

远程地址固定为：

```text
ssh://git@ssh.github.com:443/miozen/cloud-genealogy.git
```

新电脑克隆：

```bash
git clone ssh://git@ssh.github.com:443/miozen/cloud-genealogy.git
cd cloud-genealogy
git remote -v
```

若网络阻断 GitHub 的 22 端口，可在该电脑的 `~/.ssh/config` 添加以下仅作用于 GitHub 的配置：

```sshconfig
Host github.com
  HostName ssh.github.com
  Port 443
  User git
```

然后验证身份和仓库连通性：

```bash
ssh -T -p 443 git@ssh.github.com
git ls-remote origin
```

SSH 私钥由接力电脑的使用者自行生成并添加至 GitHub；不得复制他人的私钥。

## 4. 分支、标签与推送规则

采用以下模型：

| 名称 | 作用 | 规则 |
|---|---|---|
| `main` | 已验证的正式版本 | 仅通过 PR 合并；不直接推送；受保护。 |
| `dev` | 日常集成与测试 | 功能/修复合并目标；通过 CI 后再合入 `main`。 |
| `feat/<scope>` | 重要功能短分支 | 从 `dev` 创建；完成后 PR 回 `dev`；合并后删除。 |
| `fix/<scope>` | 独立缺陷修复短分支 | 从 `dev` 创建；紧急生产修复可从 `main` 创建，修复后必须回合 `dev`。 |
| `v0.x.x` | 阶段性版本标签 | 仅标记已合入 `main` 的提交；使用带注释、不可重写的 Git tag。 |

首次建立远程历史时，由项目负责人完成首次提交后执行：

```bash
git push -u origin main
git switch -c dev
git push -u origin dev
```

日常功能流程：

```bash
git switch dev
git pull --ff-only origin dev
git switch -c feat/p0-1-auth-foundation
# 修改、运行 npm run check 与 npm run build
git add <明确的文件>
git commit -m "feat(auth): add session foundation"
git push -u origin feat/p0-1-auth-foundation
```

发布阶段标签：

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.1.0 -m "P0-1 foundation"
git push origin v0.1.0
```

不得强推 `main`、`dev` 或任何已发布 `v0.x.x` 标签；不得移动、复用或删除已发布标签。GitHub 应对 `main` 和 `dev` 启用分支保护、PR、至少一项必需 CI 检查以及禁止 force push。

## 5. Cloudflare 环境与部署边界

- `wrangler.jsonc` 已分开 local、`preview`、`production` binding 名称。preview/production 中的资源 ID 为故意占位值，必须在获授权创建实际资源后才替换。
- preview 与 production 必须使用不同 D1 数据库、R2 桶、Cookie 名称/密钥和 Cloudflare Secrets。
- GitHub Actions 仅使用最小权限、可轮换的 Cloudflare Token；Token 只存 GitHub Secrets。
- 所有远程迁移、Secrets 写入、资源创建与部署都必须先通过 review，且生产操作须有明确授权。

## 6. 认证与首个管理员初始化

- 已确认采用论坛式用户名密码注册审核。密码固定为 Workers 原生 PBKDF2-HMAC-SHA-256、100,000 次迭代、每账号随机 Salt 和版本化哈希记录；这是个人站点接受的运行时折中，不宣称符合 OWASP 当前推荐强度。
- preview 已实际验证该参数可完成注册；不得改为明文、更低工作因子、Passkey、第三方认证或 Cloudflare Access。
- 首个管理员只能经 `POST /api/setup/bootstrap` 初始化：请求须携带 `x-bootstrap-secret`，环境须存在 `BOOTSTRAP_SECRET`，且数据库中没有活跃 `admin`。该操作同时创建管理员、其人物锚点、`member`/`admin` 角色和审计记录。
- Bootstrap Secret 仅用于受控初始化，成功后立即通过 `wrangler secret delete BOOTSTRAP_SECRET --env preview` 删除；不得提交、记录或复用。生产初始化仍须获得单独明确授权。
- 后续账号一律走注册待审流程；管理员必须人工选择人物锚点，不能按姓名自动关联。
