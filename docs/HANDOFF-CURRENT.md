# 当前接力快照

最后更新：2026-10-25。此文件面向下一台接力电脑；以仓库内容和 Git 状态为准，绝不将本文件视为远端/生产操作授权。

## 1. 从何处继续

- 远端：`ssh://git@ssh.github.com:443/miozen/cloud-genealogy.git`
- 当前功能分支：`feat/p0-3-chart-api-svg`
- 接力基线提交：`279aa30 feat(media): preflight cleanup run drift`；本次接力文档提交后应以该提交的后继提交为准。
- 当前开发阶段：P0-6 local 备份恢复基线与 P2 媒体资产/清理**审阅流程**已完成；真实 remote 备份、远程媒体恢复、清理执行器、部署与生产资源操作均未开始或未获授权。

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

## 4. 当前已实现

- 媒体资产的上传意图、完成校验、私有读取、直传签名、管理员上传入口、人物关联/排序/退休和 30 天保留期。
- local 离线备份包 v2：媒体 D1 清单与 R2 对象逐项绑定；活动及保留期内退休媒体都在隔离恢复演练中校验。
- 到期候选的管理员只读预览：`GET /api/admin/media-assets/cleanup-preview`，不读/写 R2，不写 D1 或审计。
- 仅 `APP_ENV=development` 可用的清理 run 审阅闭环：冻结候选、不同第二管理员确认、取消、过期收敛、查询及 D1 漂移预检。它始终返回 `executionAvailable: false`，没有执行或删除 API。
- `0017_media_cleanup_runs.sql` 已加入本地迁移链；它只保存 run/item/确认状态，不改变媒体状态且不删除数据。

最近真实验证（代码提交 `279aa30`）：

- `npm run lint`、`npm run check`、`npm run build`：通过；28 个测试文件、71 项测试。
- `LOCAL_AUTH_TEST_PORT=18992 npm run test:local-auth`：通过；覆盖 local 清理 run 冻结、双人确认、取消、过期及漂移预检。
- `npm run test:local-core-model`：第 40 项执行通过，验证 local D1 迁移链含 `0017`。
- `npm run test:local-backup-recovery`：第 37 项执行通过，验证活动及保留期内退休媒体恢复；此后只增加 local 清理审阅能力，未改变备份包代码。接力电脑应在继续媒体或备份工作前重新执行该命令。

## 5. 明确禁止与远端基线

- 不得实现或调用 `MEDIA.delete()`、R2 lifecycle rule、Cron、Dashboard 批量删除、D1 物理删除或清理执行器。
- 不得把 local 的 `backupRecoveryPoint`/包哈希字段描述为真实 remote 备份恢复证明。
- 不得在未经明确一次性授权时操作 preview/production D1、R2、Secrets、部署或迁移。
- preview 是唯一远程测试环境：D1 `cloud-genealogy-preview`，ID `aaaacbfb-762d-41b7-a424-aaa6e69ec563`；仅已应用 `0001`–`0015`。本地 `0016`、`0017` 尚未获 preview 迁移授权。
- production D1 ID 仍为占位值；production 未创建/未使用。

## 6. 推荐下一步

停止扩展 local 清理功能。先回到 P0-6，补齐并由负责人确认真实 remote 备份与恢复演练方案：责任人、异地存放、加密密钥保管、写冻结、测试窗口、最小权限凭据、preview 覆盖授权和恢复验收记录。

只有在这些前置条件完成且负责人再次明确授权后，才重新评审清理执行器。届时仍应遵循 `P2-MEDIA-CLEANUP-DESIGN-REVIEW.md`：候选冻结、双人确认、逐项重新核验、R2 删除后的 D1 墓碑与半完成恢复，不得直接删 D1 历史记录。
