# 当前接力快照

最后更新：2026-10-26。此文件面向下一台接力电脑；以仓库内容和 Git 状态为准，绝不将本文件视为远端/生产操作授权。

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
- preview 是唯一远程测试环境：D1 `cloud-genealogy-preview`，ID `aaaacbfb-762d-41b7-a424-aaa6e69ec563`；仅已应用 `0001`–`0015`。本地 `0016`、`0017`、`0018` 尚未获 preview 迁移授权。
- production D1 ID 仍为占位值；production 未创建/未使用。

## 6. 推荐下一步

停止扩展 local 清理功能。P0-6 写冻结和 remote 执行前置校验已具备 local 基线；下一步仍是补齐真实 remote 备份命令的最小权限设计与实现，但在责任人、异地存放、加密密钥保管、测试窗口、最小权限凭据、preview 覆盖授权和恢复验收记录齐备并经一次性授权前，不得操作任何远程资源。

只有在这些前置条件完成且负责人再次明确授权后，才重新评审清理执行器。届时仍应遵循 `P2-MEDIA-CLEANUP-DESIGN-REVIEW.md`：候选冻结、双人确认、逐项重新核验、R2 删除后的 D1 墓碑与半完成恢复，不得直接删 D1 历史记录。
