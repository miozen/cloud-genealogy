# 当前接力快照

最后更新：2026-10-29。此文件面向下一台接力电脑；以仓库内容和 Git 状态为准，绝不将本文件视为远端/生产操作授权。

## 1. 从何处继续

- 远端：`ssh://git@ssh.github.com:443/miozen/cloud-genealogy.git`
- 当前功能分支：`feat/p0-3-chart-api-svg`
- 接力基线提交：`279aa30 feat(media): preflight cleanup run drift`；本次接力文档提交后应以该提交的后继提交为准。
- 当前开发阶段：P0-6 local 备份恢复基线及可审计写冻结、P2 媒体资产/清理**审阅流程**已完成；真实 remote 备份、远程媒体恢复、清理执行器、部署与生产资源操作均未开始或未获授权。

在新电脑上执行：

```bash
git clone ssh://git@ssh.github.com:443/miozen/cloud-genealogy.git
cd cloud-genealogy
git switch feat/p0-3-chart-api-svg
git pull --ff-only origin feat/p0-3-chart-api-svg
git status --short --branch
```

若 GitHub 22 端口不可用，使用 SSH 443；详细配置见 `docs/DEVELOPMENT-HANDBOOK.md`。不要复制其他电脑的 SSH 私钥。

## 2. 环境与首次验证

本仓库没有 `pom.xml`，也没有 Maven 构建链。`mvn` 不是本项目的 Node 运行环境；应使用 NVM 启用 Node 22：

```bash
source ~/.nvm/nvm.sh
nvm use 22
node --version
npm --version
npm ci
npm run lint
npm run check
npm run build
```

当前接力基线实际使用 Node `22.23.4`、npm `10.9.9`。`package.json` 最低要求 Node `>=20.19.0`，但为了和 lockfile、Wrangler 与已有验证一致，接力统一使用 Node 22。

如本机端口冲突，可为 local Worker 集成测试指定未占用端口：

```bash
LOCAL_AUTH_TEST_PORT=18992 npm run test:local-auth
```

与媒体/备份相关的完整本地验证为：

```bash
npm run test:local-core-model
npm run test:local-auth
npm run test:local-backup-recovery
```

它们只使用隔离的 Wrangler local D1/R2 状态；不得添加 `--remote`。

## 3. 必读顺序

1. `AGENTS.md`：不可突破的工作约束。
2. `README.md`、`PRODUCT.md`、`ARCHITECTURE.md`、`DATA_MODEL.md`、`ROADMAP.md`：项目事实与范围。
3. `docs/P0-6-STATUS.md` 与 `docs/P0-6-BACKUP-RECOVERY-DESIGN-REVIEW.md`：备份恢复边界。
4. `docs/P2-MEDIA-ASSET-DESIGN-REVIEW.md`：第 29–43 项的已实现媒体能力。
5. `docs/P2-MEDIA-CLEANUP-DESIGN-REVIEW.md`：清理协议、待确认事项与禁止项。
6. `docs/DEVELOPMENT-HANDBOOK.md`：环境、SSH、验证和远端授权规则。
7. 里程碑完成报告必须遵循 `DEVELOPMENT-HANDBOOK.md` 的“0.0 里程碑交付报告契约”。

## 4. 当前已实现

- 媒体资产的上传意图、完成校验、私有读取、直传签名、管理员上传入口、人物关联/排序/退休和 30 天保留期。
- local 离线备份包 v2：媒体 D1 清单与 R2 对象逐项绑定；活动及保留期内退休媒体都在隔离恢复演练中校验。
- 到期候选的管理员只读预览：`GET /api/admin/media-assets/cleanup-preview`，不读/写 R2，不写 D1 或审计。
- 仅 `APP_ENV=development` 可用的清理 run 审阅闭环：冻结候选、不同第二管理员确认、取消、过期收敛、查询及 D1 漂移预检。它始终返回 `executionAvailable: false`，没有执行或删除 API。
- `0017_media_cleanup_runs.sql` 已加入本地迁移链；它只保存 run/item/确认状态，不改变媒体状态且不删除数据。
- `0018_backup_write_freeze.sql` 已加入本地迁移链；管理员可开启、查询及解除单一活动的逻辑写冻结。冻结期间管理端业务写入统一被拒绝，读取保持可用；启停均有审计。
- `remote-backup-preflight.mjs` 已提供 future remote 备份的 local-only 输入校验：仅允许与 `wrangler.jsonc` 相符的 preview 目标，要求两位不同确认、写冻结与外部归档标识，拒绝秘密字段和 production；它明确不能执行 remote 操作。
- `remote-backup-command-plan.mjs` 只从合格 preflight 生成供人工审阅的 future 执行步骤；它不调用 Wrangler、不读取凭据，且始终标明不可执行。
- `remote-backup-execution-precheck.mjs` 已为 future executor 增加本地前置校验；它验证冻结与审批记录一致性、本机目录安全性，始终不可执行。
- 授权包校验器已将授权记录、preflight 与执行前检查串联；它只确认材料完整，不能替代用户的一次性 remote 授权。
- `backup-local-archive.mjs` 已提供受控本机加密归档：先验证包，再写入一个新的 `.tar.gz.cgbk` 文件并清除临时明文 tar；它是 Cloudflare 账户外副本，但不是异地副本。
- `backup-recovery-catalog.mjs` 已登记并重验本机加密归档的 SHA-256；local 演练现要求至少三个恢复点。目录仅证明本机文件完整性与数量，不替代异地保管或 remote 恢复证明。

最近真实验证（代码提交 `279aa30`）：

- `npm run lint`、`npm run check`、`npm run build`：2026-10-26 通过；29 个测试文件、73 项测试。
- `LOCAL_AUTH_TEST_PORT=18992 npm run test:local-auth`：2026-10-26 通过；覆盖 local 清理 run 审阅闭环及备份写冻结的拒绝、读取与解除。
- `npm run test:local-core-model`：2026-10-26 通过，验证 local D1 迁移链含 `0018`。
- `npm run test:local-backup-recovery`：2026-10-26 通过，验证活动及保留期内退休媒体恢复，并确认 `0018` 可进入空 local 目标的恢复迁移链。
- `npm run test:remote-backup-preflight`：2026-10-26 通过；preview-only 正向计划通过，production 和秘密字段计划被拒绝，未连接 Cloudflare。

## 5. 明确禁止与远端基线

- 不得实现或调用 `MEDIA.delete()`、R2 lifecycle rule、Cron、Dashboard 批量删除、D1 物理删除或清理执行器。
- 不得把 local 的 `backupRecoveryPoint`/包哈希字段描述为真实 remote 备份恢复证明。
- 不得在未经明确一次性授权时操作 preview/production D1、R2、Secrets、部署或迁移。
- preview 是唯一远程测试环境：D1 `cloud-genealogy-preview`，ID `aaaacbfb-762d-41b7-a424-aaa6e69ec563`；仅已应用 `0001`–`0015`。本地 `0016`–`0021` 尚未获 preview 迁移授权。
- production D1 ID 仍为占位值；production 未创建/未使用。

## 6. 推荐下一步

2026-10-28：`execute-preview-remote-backup.mjs` 只提供隔离 mock 适配器，CLI 明确拒绝真实执行；`npm run test:preview-backup-mock` 验证对象完整性和失败清理。下一步先解决写冻结并发排空、既有直传 URL 失效等待及真实远程媒体清单与迁移基线核验，不能把现有本地 JSON 当成授权或一致性证明。

mock 编排已在导出前后分别校验模拟冻结/活动写入/待上传状态，故障注入已通过；实际线上排空协议和远程适配器未完成，不得将此断言当成可信状态。

本地新增 `0019` 写入原子准入及 readiness 查询；直传进行中请求与中断恢复仍未解决，不能视为完整冻结。preview 仅到 `0015`，不得应用新迁移或启用 remote 执行，除非另获授权并完成一致性审查。

最新增量将 API 写入准入扩展至认证，真实 local HTTP 并发交错及冻结期间认证阻断已测试通过。readiness 的 `uploadsDrained` 恒为 false；中断遗留准入没有自动解除，直传 PUT 的完成证明和受审计恢复尚未实现。preview 未应用 `0019`。

最新接力增加只读 blockers 清单和完成记录写入故障注入；`P0-6-QUIESCENCE-RECOVERY-REVIEW.md` 记录远程静默与中断恢复的方案和限制，仍无真实恢复或远程执行能力。

独立 SQLite/内存对象 fencing 原型与故障注入已加入 `scripts/fencing-prototype.mjs` 和 `npm run test:fencing-prototype`。对象复制后数据库失败会留下未发布孤儿；原型不具备真实 R2 不可变性、孤儿恢复或业务路径 fencing，远程执行仍禁用。

`scripts/cross-store-recovery-prototype.mjs` 对上述孤儿场景补充本地 `prepared → copied → published` 恢复和 `needs_review` 标记；测试覆盖中断重试、哈希不符和旧代次。仅内存 SQLite/Map，同一进程重新实例化不等于跨进程或 Cloudflare 恢复；不得用作真实 remote 授权或备份证明。

`npm run test:cross-store-persistence` 使用磁盘 SQLite 与文件对象夹具，并以子进程 SIGKILL 验证重启及并发创建。它不证明掉电或真实 D1/R2 的持久性、条件写和并发语义；生产路径与 remote 备份仍未启用。

`0020` 在 local D1 提供写入代次保护；已接入人物锚点、姓名和事实创建，以及谱书/版本/来源人物/事实主张/关系主张创建与来源人物关联替换。冻结后旧请求不得写入业务数据或审计；local 并发和姓名/关联审计失败回滚均已验证。名称、事实和地点退休，来源主张撤回，来源语义、媒体、账号及世系写入等仍未接入，不构成全局 fencing 或远程备份就绪证明。

2026-10-29 人物和来源生命周期增量：姓名、事实、地点退休、事实及关系主张撤回、关系语义规则创建/退休均在业务事务中检查写入准入代次；更新和审计同批次，姓名主名和地点活动引用在更新时重查。local 并发重复撤回和审计注入用于验证单次审计及回滚；语义创建的延迟请求参与冻结交错。无请求体的退休/撤回入口尚未逐一验证“准入后冻结再提交”的真实 HTTP 交错，仍需可控屏障测试。媒体、账号及世系等写入口仍未全部接入，远程执行保持禁用。

下一阶段 P0-6 媒体及其余写入口 fencing 盘点：先建立无请求体生命周期写入的可控并发测试，再审查媒体上传意图、完成和关联写入的事务边界；前置条件为 local 隔离测试与冻结模型，验收包括旧代次拒绝、审计和业务回滚及不启用远程执行。

2026-10-29 媒体增量：上传意图、完成、人物媒体关联、排序和退休在 D1 事务中校验准入代次；最后关联退休时在事务内重新判断是否退休资产，仅对实际更新写审计。`tests/fixtures/fencing-barrier-worker.ts` 是独立 local 测试入口，在真实请求到达 D1 batch 前暂停，测试冻结、解除后旧代次的提交；正式 Worker 不包含该测试控制入口。既有直传 PUT 仍可在冻结外进行，完成 API 的保护不能证明 R2 已排空，也不允许远程执行。

下一阶段仍为 P0-6：盘点并保护账号、世系等其余写入口及媒体清理审阅状态；前置条件为 local 可控测试。验收须覆盖跨冻结旧请求、事务内审计和失败回滚，并持续报告任何未接入路径，不能据此宣称全局写冻结或远程备份就绪。

2026-10-29 账号、世系与清理审阅增量：本地迁移 `0021` 增加不持久化记录的事务内准入断言；账号审批/范围/拒绝/密码重置、世系提案审核/发布与审核人指派，以及 local 清理审阅创建/确认/取消/过期使用事务内代次保护，相关单次状态变更与审计放入同一批次。屏障和审计故障仅验证 local D1，不允许应用 preview 迁移或启用远程执行。认证注册、登录、登出及其限流/会话写入仍未完整接入事务内 fencing；备份冻结释放本身也需审计原子性评审。直传 PUT 的排空仍未解决。

下一阶段 P0-6：审查认证、会话、限流和冻结控制写入的事务边界，补齐 local fencing 和中断恢复；前置为本地隔离测试与现有迁移，验收覆盖旧代次、审计回滚、无凭据及禁止远程执行。

2026-10-29 认证及冻结控制增量：bootstrap、注册、登录限流、会话签发和登出均在各自 D1 写批次内校验准入代次；bootstrap、注册、登录会话与审计原子提交。登录在密码验证前先独立提交限流计数，后续失败或中断保留该计数；重试会再次计数。冻结释放与审计已合并为原子批次。审计注入、冻结交错及重复释放仅证明 local 行为；请求进程中断留下未完成准入时仍须人工处理，readiness 不自动清除，也没有受审计的真实恢复操作。磁盘原型的进程终止重启不证明真实 Worker/D1 崩溃恢复。

下一阶段 P0-6：盘点剩余 D1 写入和全局 fencing 漏洞，设计并验证中断准入的受审计恢复与 PUT 排空；前置条件为仅 local 夹具和受控恢复方案，验收要求不误清仍在运行的写入、旧代次不提交、远程执行持续禁用。

2026-10-29 中断准入恢复 local 演练：`npm run test:local-auth-crash-recovery` 使用临时独立 Wrangler local 状态、测试专用 Worker 和其受控进程组；在认证注册请求已准入但 D1 业务批次未开始时 SIGKILL，重启后验证该记录仍阻塞。只有测试监督器确认独占进程组全部终止、冻结仍活动、准入代次已过期时，`scripts/local-admission-recovery-fixture.mjs` 才能在隔离 SQLite 中同事务完成夹具记录并写审计；活动进程、未过时代次、错误冻结、审计失败和重复恢复均拒绝或回滚。该夹具没有 HTTP 入口、不用于普通 local、preview 或 production；单个 Worker 进程组终止无法证明 Cloudflare 所有实例已停止，现有真实恢复仍不可用，远程执行保持禁用。认证请求进程死在事务提交中、跨实例进程证明、R2 PUT 排空尚未验证。

下一阶段 P0-6：评审全局写入口和中断恢复证据契约，设计可区分正常完成与人工恢复的持久化状态及双人审计；在没有可信全局排空证明时继续阻断，验收不得误恢复活动请求且不得启用远程执行。

2026-10-29 独立恢复状态夹具：`local_fixture_admission_recovery` 仅在临时测试 SQLite 创建，记录恢复请求、准入与冻结代次、两名测试管理员、原因、结构化进程组证据和 SHA-256，并禁止修改/删除；正常准入的 `completed_at` 不再被夹具改写。恢复与审计同事务，同请求同证据幂等，冲突和重复审计拒绝；恢复记录不被应用读取，原准入继续阻塞 readiness。测试在本地 SQLite 提交前以及提交完成、响应前分别 SIGKILL 子进程，验证回滚与幂等重试，并测试两个子进程并发重试。该测试不在 SQLite COMMIT 指令内部或真实 Worker/D1 中注入崩溃；两名测试账号和调用方传入的进程组证据不构成真实双人审批或可信跨实例排空证明。远程执行及正式恢复入口仍禁用。

下一阶段 P0-6：评审独立恢复状态如何在真实协议中参与 blockers/readiness、双人审批和证据校验，并先验证真实 Worker/D1 事务中断及直传 PUT 排空方案；前置为可信全局隔离证据与完整 fencing，未满足前不得改变生产准入记录或远程执行。

2026-10-29 全局写入与 readiness 审查：见 `P0-6-READINESS-PROTOCOL-REVIEW.md`。已盘点 47 个 POST/PUT 路由及源码外写面；现有状态是只读快照，恢复夹具记录不抵消开放准入，真实上传排空与远程执行仍为 false。识别世系发布辅助函数缺少 admissionId 时直接调用 batch 的未来绕过风险；所有当前 app 调用均传入，但须收紧并加防遗漏测试。官方文档证实 R2 负读取不能证明未完成 PUT 之后不会提交；证据/双人/窗口状态均为待确认设计，并未接入应用。`tests/fixtures/readiness-review-model.ts` 及对应 Vitest 只是合成反例模型，无权限读取证据或启用远程执行。

下一阶段 P0-6：消除世系发布辅助函数无准入直写回退，建立全路由与辅助函数防遗漏检查，覆盖旧代次、冻结释放/重新冻结和新增入口；本地全部通过后再评审恢复证据适配器，真实 PUT 排空未证明前远程执行保持禁用。

2026-10-29 写入口防遗漏增量：世系发布与回退辅助函数要求非空 `admissionId`，在读写前拒绝缺失值，所有写批次经过 `fencedBatch`；此前允许缺参直写的回退已删除。`tests/fixtures/write-entrypoint-inventory.json` 登记 77 个应用路由（44 受保护写、30 GET、2 冻结控制和 1 只读预览），`npm run check` 中的 AST 检查拒绝未登记、动态/挂载式路由、未经审核中间件和缺少约定标记的写入口，并检查部分委托辅助函数。该静态检查是结构性门槛，不证明事务中每条语句均受保护，也不能发现所有别名、间接调用、其他服务或外部凭据写入。local 集成回归在发布请求准入后执行冻结、解除、重新冻结；两条旧请求分别在第二次冻结中及解除后恢复，均不得改变指针、快照或审计。它不证明导出期间窗口连续、R2 排空或真实 Cloudflare 行为；远程执行仍禁用。

下一阶段 P0-6：研究冻结窗口跨备份步骤的持有与失效协议，先建立 local-only 模型和故障注入；前置为完整写者清单与可信证据设计，验收覆盖解除/重冻/证据过期并保持 PUT 未排空时无法执行远程备份。

停止扩展 local 清理功能。P0-6 写冻结和 remote 执行前置校验已具备 local 基线；下一步仍是补齐真实 remote 备份命令的最小权限设计与实现，但在责任人、异地存放、加密密钥保管、测试窗口、最小权限凭据、preview 覆盖授权和恢复验收记录齐备并经一次性授权前，不得操作任何远程资源。

只有在这些前置条件完成且负责人再次明确授权后，才重新评审清理执行器。届时仍应遵循 `P2-MEDIA-CLEANUP-DESIGN-REVIEW.md`：候选冻结、双人确认、逐项重新核验、R2 删除后的 D1 墓碑与半完成恢复，不得直接删 D1 历史记录。
