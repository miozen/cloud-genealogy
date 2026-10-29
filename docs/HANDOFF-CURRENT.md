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
- preview 是唯一远程测试环境：D1 `cloud-genealogy-preview`，ID `aaaacbfb-762d-41b7-a424-aaa6e69ec563`；仅已应用 `0001`–`0015`。本地 `0016`–`0020` 尚未获 preview 迁移授权。
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

停止扩展 local 清理功能。P0-6 写冻结和 remote 执行前置校验已具备 local 基线；下一步仍是补齐真实 remote 备份命令的最小权限设计与实现，但在责任人、异地存放、加密密钥保管、测试窗口、最小权限凭据、preview 覆盖授权和恢复验收记录齐备并经一次性授权前，不得操作任何远程资源。

只有在这些前置条件完成且负责人再次明确授权后，才重新评审清理执行器。届时仍应遵循 `P2-MEDIA-CLEANUP-DESIGN-REVIEW.md`：候选冻结、双人确认、逐项重新核验、R2 删除后的 D1 墓碑与半完成恢复，不得直接删 D1 历史记录。
