# 开发与交接手册

最后更新：2026-10-23。本文是任一接力电脑从零接手本项目的唯一操作基线；生产资源、Secrets、远程数据库和 R2 均不应在未明确授权时操作。

## 0. 人机接力方式

- 项目负责人只需提出需求或回复“继续”；Codex 负责将当前阶段拆成可验收的小任务并实施。
- Codex 默认连续完成一个完整可验收里程碑（实现、相关本地测试、构建、提交、推送、PR 合并）后再报告，不应在每个微小步骤等待“继续”。
- 只有需要业务负责人决定、生产授权、产生费用、不可恢复操作或遇到真实阻塞时才暂停；不得要求项目负责人重复上下文或自行执行开发命令。
- 只有以下情况才暂停请求决定：会改变已确认产品规则、产生费用、访问/写入生产资源、删除不可恢复数据，或存在无法由仓库与安全检查消除的歧义。
- 每阶段同步更新决策、进度、风险和下一步到 `docs/`，使其他电脑克隆后可直接接力；**任何推送包含实现、迁移、测试或环境变更时，必须在同一提交同步更新对应状态文档与本手册（若接力基线变化）**。

## 0.1 本地优先验证规则

- 每个任务开始前先查看当前分支、未提交修改、`package.json` 脚本和已有测试文档；保护已有修改，不执行未经授权的清理、覆盖或重置。
- 每个功能或修改完成后，优先执行本地类型检查、单元测试、已配置的代码规范检查、构建，以及与改动相关的本地集成测试。
- D1、R2、媒体和测试数据默认使用 Wrangler local bindings。除非明确授权，不得操作 preview/production 的数据库、R2、Secrets 或部署。
- 只有本地验证通过且确实需要验证 Cloudflare 平台行为时，才申请 preview 环境授权；production 操作始终需要单独明确授权。
- preview 是唯一远程测试环境，可在项目负责人明确确认数据可覆盖后重建、迁移和恢复演练；不得把 preview 当作 production，也不得创建额外长期 recovery-test 环境。
- 交付报告必须区分“已执行且通过”“已执行但失败”“未执行及原因”；未执行项绝不写为通过。
- 当前已有本地命令：`npm run lint`（ESLint 代码规范检查）、`npm run check`（类型检查和单元测试）、`npm run build`（生产构建）、`npm run test:local-core-model`（P0-2 固定 D1 数据）、`npm run test:local-auth`（本地 Worker/D1 集成）、`npm run test:local-backup-recovery`（临时 local D1/R2 的离线包预检、加密认证与隔离恢复演练）、`npm run collect:local-backup-counts -- --wrangler <path> --cwd <local-dir> --output <counts.json>`（本地 D1 的核心业务计数采集）、`npm run crypt:backup -- <encrypt|decrypt> --input <file> --output <new-file> --passphrase-file <mode-0600-file>`（离线归档加密/认证解密）、`npm run dev:worker`（本地 Worker）、`wrangler d1 ... --local`（本地迁移/查询）。交付前至少运行与改动相关的 lint、check 和 build，并如实记录结果。
- `npm run test:local-auth` 会在独立的 `.wrangler/local-auth-integration/` 状态目录中启动本地 Worker，自动迁移并验证 bootstrap、注册待审、CSRF、人工人物关联、批准、登录、重置密码、会话撤销与退出。脚本使用临时测试凭证，退出时清理测试账号及关联记录；不得加 `--remote`。

## 0.2 远程测试接力基线

- 唯一远程测试资源：`cloud-genealogy-preview` D1 与同名私有 R2 桶；production 未创建且绝不用于测试。
- preview D1 于 2026-10-25 重建，当前 ID：`aaaacbfb-762d-41b7-a424-aaa6e69ec563`；该 ID 已写入 `wrangler.jsonc` 的 `preview` binding。
- preview 已应用 migrations `0001` 至 `0015`，并完成一次合成 D1/R2 恢复演练：外键检查无结果、合成人物计数为 1、媒体字节一致。未部署 Worker、未写入 Secrets。
- D1 完整导出含内部 `d1_migrations`，不可直接导入已初始化 preview；当前演练先迁移，再导入移除内部行的合成业务数据。未来必须将这一规则固化为受测恢复工具，不能依赖临时命令。
- 接力前先执行 `git status --short --branch`、阅读 `docs/P0-6-STATUS.md`，并且只有用户明确允许覆盖 preview 后才能执行任何 `--env preview --remote` 写命令。

## 1. 工作站前置条件

- Git 2.43+。
- **NVM**（不是 Maven 的 `mvn`）管理的 Node.js 22 LTS。当前已验证版本为 Node `22.23.4`、npm `10.9.9`；接手 WSL 会话时先执行 `source ~/.nvm/nvm.sh && nvm use 22`，再运行 npm 命令。
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

### 本地千人吊线图演示

无需部署。执行 `npm run demo:local-chart` 后，脚本会在隔离的 Wrangler local 状态中建立 1000 人、自动建立本地管理员并发布演示世系，再启动 Worker 和 Vite。终端会输出浏览器地址（固定为 `http://127.0.0.1:5173`）与本地测试账号；按 `Ctrl+C` 停止并清理演示状态。该命令不使用 `--remote`，不访问 preview/production。若只需检查本机环境能否完整启动，可执行 `npm run verify:local-chart-demo`；它会验证 Worker、网页服务与 Vite 的 API 代理，然后自动退出。

前端默认端口由 Vite 分配；前端的 `/api` 请求代理至 `http://127.0.0.1:8787`。Worker 本地运行使用 Wrangler local bindings，绝不接触远程 D1 或 R2。

### 本地房支工作台演示

`npm run demo:local-branch-workbench` 会在独立 local D1 状态中创建两名本地管理员、一个已发布世系、两级房支及成员归属，再启动 Worker 和 Vite。它只用于人工检查“本地编排不落库、依赖阻止退休、成员移除加退休、退休名称确认”的前端流程；按 `Ctrl+C` 会清理整个演示状态。测试账号和密码只属于该临时本地环境，不得用于任何远程环境。

若只需检查演示 fixture、Worker、Vite 和 API 代理，运行 `npm run verify:local-branch-workbench-demo`；该命令自动退出并清理状态，不执行浏览器交互。

常用检查：

```bash
npm run check
npm run build
npm run test:local-auth
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

- `wrangler.jsonc` 已分开 local、`preview`、`production` binding。preview 是已隔离的验证环境；production 的资源 ID 仍为占位值。无论资源是否存在，任何 preview/production 的 D1、R2、Secret 或部署操作均须获得对应明确授权。
- preview 与 production 必须使用不同 D1 数据库、R2 桶、Cookie 名称/密钥和 Cloudflare Secrets。
- GitHub Actions 仅使用最小权限、可轮换的 Cloudflare Token；Token 只存 GitHub Secrets。
- 所有远程迁移、Secrets 写入、资源创建与部署都必须先通过 review，且生产操作须有明确授权。

## 6. 认证与首个管理员初始化

- 已确认采用论坛式用户名密码注册审核。密码固定为 Workers 原生 PBKDF2-HMAC-SHA-256、10,000 次迭代、每账号随机 Salt 和版本化哈希记录；这是审核制个人站点确认的基础防护，不宣称符合 OWASP 当前推荐强度。
- 不得改为明文、Passkey、第三方认证或 Cloudflare Access。
- 首个管理员只能经 `POST /api/setup/bootstrap` 初始化：请求须携带 `x-bootstrap-secret`，环境须存在 `BOOTSTRAP_SECRET`，且数据库中没有活跃 `admin`。该操作同时创建管理员、其人物锚点、`member`/`admin` 角色和审计记录。
- Bootstrap Secret 仅用于受控初始化，成功后立即通过 `wrangler secret delete BOOTSTRAP_SECRET --env preview` 删除；不得提交、记录或复用。生产初始化仍须获得单独明确授权。
- 后续账号一律走注册待审流程；管理员必须人工选择人物锚点，不能按姓名自动关联。
