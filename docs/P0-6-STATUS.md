# P0-6 状态：备份与恢复

状态：local 基线、媒体引用恢复核验、D1 数据导入准备工具、可审计写冻结与 preview 合成恢复演练已完成；真实 remote 备份、远程媒体引用校验与灾难切换尚未开始。最后更新：2026-10-26。

## 已完成

- 基于实际 migrations、Worker/R2 使用情况、Wrangler 环境配置和现有本地验证脚本完成备份恢复审查。
- 复核当前 Cloudflare 官方 D1 导入导出、R2 S3 API 与 Workers 限制文档，并在 [设计审查](/home/mio/projects/cloud-genealogy/docs/P0-6-BACKUP-RECOVERY-DESIGN-REVIEW.md) 中固化限制与推荐方案。
- 确认本切片开始前没有既有 backup/restore 工具；当前仍没有 `backup_record` 物理表、远程备份/恢复命令或 CI 工作流，因此没有宣称未发生的 remote 备份、恢复或演练。
- 新增 `scripts/backup-package.mjs`：只处理已落在本地目录的离线包，生成带 D1 SQL、R2 对象、迁移基线、计数与 SHA-256 的 `manifest.json`，并在任何导入前执行只读预检。它不含 remote 命令、凭据读取、加密或恢复写入。
- 新增 `npm run test:local-backup-recovery`：在一次性临时目录中使用 Wrangler local D1/R2 完成导出、对象取回、manifest 生成/预检、全新目标恢复和对象内容比对；篡改对象后预检会失败，恢复命令不会执行。
- 新增 `scripts/backup-counts.mjs` 与 `npm run collect:local-backup-counts -- ...`：它只接受显式 local Wrangler 可执行文件、local 工作目录和输出文件，实际查询账号/权限、人物、谱书、来源、revision、关系、房支、媒体和审计 D1 计数；同时输出活动及保留期内退休媒体的稳定 ID、对象键、哈希、大小、MIME、状态与活动引用数。`backup-package.mjs --counts-file` 只接受该采集器产生的 v2 清单。
- local R2 演练对象会在 manifest 中标记为 `local_fixture`，但必须逐一绑定 D1 媒体清单；未登记对象、缺对象或哈希/大小/MIME 不符均会在生成或预检失败。该能力仅证明隔离 local 演练，不能把测试夹具误用为 remote 备份。
- 新增 `scripts/backup-crypt.mjs` 与 `npm run crypt:backup -- ...`：对完整离线归档进行 AES-256-GCM 加密和认证解密，使用随机 salt/IV 与 Node 内建 scrypt；拒绝覆盖输出，认证失败不留下输出文件。真实密钥保管流程见 `P0-6-KEY-RECOVERY-DESIGN.md`。
- 新增 `P0-6-ADMIN-RUNBOOK.md`：将 local 演练、remote 备份前置条件、恢复预检、测试环境演练和生产恢复的授权边界固化为管理员清单；不含任何真实秘密或远程资源标识。
- 新增 `P0-6-TEST-RECOVERY-AUTHORIZATION.md`：固化测试环境演练的成功标准、一次性授权范围、禁止事项和待安全审批记录补齐的事实。
- 新增 `scripts/prepare-d1-restore-data.mjs` 与 `npm run prepare:d1-restore-data -- --input <data-only.sql> --output <prepared.sql>`：仅处理 Wrangler 的 data-only D1 导出，移除内部 `d1_migrations` 记录，并仅将三个固定权限种子表的插入改为幂等形式。`test:local-backup-recovery` 已覆盖“先迁移空目标、拒绝非 Wrangler 输入与覆盖输出、再准备并导入数据、查询恢复人物”的链路。
- 新增 `0018_backup_write_freeze.sql` 和管理员写冻结 API：`GET/POST /api/admin/backup-write-freeze`、`POST /api/admin/backup-write-freeze/release`。冻结时所有管理端业务写入统一返回 `423 backup_write_freeze_active`；读取和纯内存 revision preview 保持可用。启动与解除均写入 `audit_log`，且数据库只允许一个活动冻结窗口。该能力只在 local 测试中验证，未迁移到 preview。
- 新增 `scripts/remote-backup-preflight.mjs` 与 `npm run preflight:remote-backup -- --plan <non-secret-plan.json> --wrangler-config wrangler.jsonc --output <new-result.json>`：只校验不含秘密的 preview 备份计划，要求两个不同确认标识、活动写冻结 ID、外部归档位置标识，并精确核对 preview D1/R2 binding。它拒绝 production、目标不匹配和 token/secret/password/credential 字段，输出固定 `remoteExecutionAvailable: false`，不调用 Wrangler remote 或 Cloudflare API。
- 新增 `scripts/backup-local-archive.mjs` 与 `npm run archive:local-backup -- --package <verified-package-dir> --migration-dir migrations --destination <existing-local-dir> --backup-id <safe-id> --passphrase-file <mode-0600-file>`：先验证 manifest 与迁移基线，再生成临时 tar.gz、AES-GCM 加密到指定本机目录并删除临时明文；拒绝符号链接目录和覆盖已有归档。本机副本位于 Cloudflare 账户之外，但不等同于异地容灾副本。
- 新增 `scripts/backup-recovery-catalog.mjs` 与 `npm run catalog:backup-recovery -- <register|verify-retention> ...`：目录仅登记常规加密归档的 ID、路径、大小、SHA-256 与登记时间；保留校验重新哈希每个归档，且当前 local 演练强制至少三个恢复点。它不解密、不读取远程资源，也不以同机三份文件宣称已具备异地容灾。

## 当前风险与未完成项

- 本地基线采用管理员受控命令、至少保留三个成功点、恢复到新资源而非覆盖的推荐默认值；真正 remote 执行仍须在加密与密钥保管责任、保留节奏、写冻结体验及资源切换细节确认后另行授权。
- 生产资源仍未创建/使用；production D1 ID 为占位值。任何远程 D1/R2 导出、测试恢复、资源创建、Secret 写入或部署都需要独立明确授权。
- D1 与 R2 不具备跨服务原子快照；媒体上线前必须实现可审计写冻结及以媒体元数据为准的对象清单，不能依赖全桶盲扫。
- preview 已完成一次合成 D1/R2 恢复演练；尚无真实备份包的 remote 测试、真实远程媒体引用校验、Worker 已部署后的授权冒烟检查或灾难切换测试。

## 本切片验证

| 检查 | 结果 |
|---|---|
| 本地源码、迁移、运行配置与脚本审计 | 已执行；确认没有既有备份/恢复实现或 CI 工作流。 |
| Cloudflare 官方文档复核 | 已执行；D1 SQL 导出/导入、R2 S3 访问及 Workers 限制与设计一致。 |
| `npm run test:local-backup-recovery` | 通过：仅临时 local D1/R2，验证业务计数采集、导出、只读预检、D1 data-only 准备的拒绝路径和已迁移空目标导入、加密认证解密、错误口令/篡改拦截、隔离恢复及对象内容比对。 |
| `npm run lint`、`npm run check`、`npm run build` | 2026-10-26 通过：29 个测试文件、73 项测试；生产构建完成。 |
| `npm run test:local-core-model`、`npm run test:local-auth`、`npm run test:local-backup-recovery` | 2026-10-26 通过：仅隔离 Wrangler local D1/R2；认证集成覆盖写冻结拒绝业务写入、保留读取及受审计解除。 |
| `npm run test:remote-backup-preflight` | 2026-10-26 通过：验证 preview 计划通过，production 与秘密字段计划被拒绝；未连接远程资源。 |
| preview D1/R2 合成恢复演练 | 通过：已重建 preview、应用 15 项迁移、恢复合成人物与媒体并完成外键/字节校验；未部署 Worker。 |

第 36 项已扩展 local 演练：fixture 现有真实 `active media_asset → person_media → R2` 链；包格式 v2 将 R2 文件逐一绑定媒体 ID/哈希/大小/MIME/状态/引用数，恢复后核验资产元数据、关联行和对象字节。未访问 preview 或 production。

第 37 项进一步加入 `retired media_asset → 已退休 person_media → R2` 夹具：其 `cleanup_after` 仍在 30 天保留窗口内、活动引用数为零。演练验证该资产仍进入 v2 清单和离线包，并在新 local 目标恢复其退休状态、保留截止、历史关联和对象字节；未删除任何对象，也未实现到期清理。

第 38 项新增仅管理员可读的 `GET /api/admin/media-assets/cleanup-preview`：它只报告已过 `cleanup_after` 且不存在活动人物关联的退休资产（最多 100 条），不读取 R2、不写 D1 或审计，也不删除对象。真实清理仍需独立设计、授权与恢复前置验证。

第 39 项已将真实清理的备份门槛、候选冻结、双人确认、逐项重核验、R2/D1 半完成状态和 D1 墓碑策略写入 [媒体到期清理安全协议](/home/mio/projects/cloud-genealogy/docs/P2-MEDIA-CLEANUP-DESIGN-REVIEW.md)。在 remote 备份恢复点与对应授权尚未具备前，任何真实 R2/D1 清理仍被明确禁止。

第 40 项仅加入 local 清理 run/item 模型及纯冻结/双人确认规则，恢复点标识和包哈希为必填；没有 HTTP 入口或执行能力。它不能替代 P0-6 remote 备份与恢复证明，也没有解除真实清理禁令。

第 41 项仅在 local development 环境开放管理员冻结、查询和不同第二管理员确认清理 run；preview/production 会拒绝，且没有 R2/D1 删除执行路径。local 恢复点字段只用于协议演练，不得被表述为真实 remote 备份证明。

第 42 项补齐 local run 的取消和过期收敛：待确认批次可取消，过期确认会收敛为 `expired`；所有这些状态仍不调用 R2 或执行删除。

第 43 项新增 local 清理批次的只读 D1 漂移预检：冻结元数据与当前状态或关联数不一致时只报告将跳过的原因，不写状态、不读 R2，也不开放执行。

接力基线见 [当前接力快照](/home/mio/projects/cloud-genealogy/docs/HANDOFF-CURRENT.md)：其中记录当前功能分支、local `0018` 与 preview `0015` 的迁移差异、最近真实验证和远端禁止事项。

## Preview 恢复演练（2026-10-25）

- 已明确授权重建唯一远程测试 D1 `cloud-genealogy-preview`；新 ID 为 `aaaacbfb-762d-41b7-a424-aaa6e69ec563`，`wrangler.jsonc` 已同步。production 未操作。
- 已对新 preview D1 应用 `0001` 至 `0015` 迁移，并恢复合成人物与合成 R2 对象。外键检查无结果、人物计数为 1、下载媒体与源对象字节一致。
- 完整 schema+data SQL 不能直接导入已经由 Wrangler 初始化的 D1：其包含内部 `d1_migrations` 行。已用受测工具固化“先迁移、再将 data-only 导出移除内部迁移行后导入”的规则；该工具仅适用于刚迁移的空目标，不是将任意备份合并进现有业务库的通用实现。

## 下一步（需确认后）

下一步是保持 preview 当前合成恢复基线不变，优先补齐真实媒体元数据模型与可审计对象清单。第 28 项方案已获确认：图片/扫描件、5 分钟单对象直传、管理员限定、10 MiB、30 天保留期，且不清除 EXIF/GPS；第 29 项已完成 local 媒体数据模型和纯状态规则，第 30 项已完成管理员意图、失败完成校验和 private local R2 读取，第 31 项已完成离线 SigV4 presigned PUT 签名模块和确定性测试，第 32 项已在管理员意图 API 中接入可选运行时签名配置，第 33 项已提供受配置约束的管理员浏览器上传入口，第 34 项已提供资产清单和人物专用关联并收紧关联资产读取边界，第 35 项已补齐关联排序、退休及最后引用资产的 30 天可恢复保留，详情见 [P2 媒体资产设计审查](/home/mio/projects/cloud-genealogy/docs/P2-MEDIA-ASSET-DESIGN-REVIEW.md)。签发真实 presigned URL 仍需要最小权限 R2 S3 Secret、bucket CORS 和经确认的 HTTP API 接入；远端资源和部署仍未授权，因此不得宣称可对真实远程媒体备份或恢复。若要使用真实备份包验证该工具，仍须在安全审批记录中补齐责任人身份、源包、测试窗口、测试资源与最小权限凭据，并由用户发出一次性覆盖 preview 的授权。
