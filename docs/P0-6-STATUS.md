# P0-6 状态：备份与恢复

状态：local 基线、媒体引用恢复核验、D1 数据导入准备工具、可审计写冻结与 preview 合成恢复演练已完成；真实 remote 备份、远程媒体引用校验与灾难切换尚未开始。最后更新：2026-10-26。

2026-10-28 接力：新增隔离 mock 备份编排测试，验证 D1 导出夹具、R2 对象下载夹具、现有 v2 manifest 和失败清理。命令行真实 remote 执行入口仍明确禁用：现有冻结中间件无法证明已进入的写请求已排空，也无法撤销已签发的直传 URL；必须先解决一致性与实际授权凭据校验。测试夹具标记为 local，不是 remote 备份证明。

2026-10-28 后续：mock 编排在导出前与对象下载后检查冻结 ID、冻结状态、活动写入数和待完成上传数；任一条件不满足则失败并清理新建目录。故障注入覆盖活动写入、待完成上传、冻结解除及 ID 不匹配。该状态只来自测试适配器，不是实际请求排空机制；真实 preview 媒体清单和下载适配器仍未实现，CLI 继续禁用。

2026-10-28 本地增量：`0019_backup_write_admissions.sql` 为管理端写入提供原子准入与不自动过期的在途记录，管理员只读 readiness 可查看活动写入与 pending 上传数量。中断遗留记录须调查；pending 上传必须解除冻结并由管理员处置，不能因超时就当作已经收敛。该指标不覆盖登录、登出和限流等认证写入，也不能证明已开始的直传 PUT 停止；因此它不是完整快照证明，remote 执行仍禁用。`0019` 未应用 preview。

本增量验证：`npm run lint`、`npm run check`（29 个文件、73 项）、`npm run test:preview-backup-mock`、`npm run build` 和 `LOCAL_AUTH_TEST_PORT=18995 npm run test:local-auth` 已通过。认证集成以手工注入在途记录和过期 pending 上传验证 readiness 保守拒绝；尚未完成真实并发交错、Worker 崩溃恢复、直传传输收敛测试。认证测试旧的末尾 revision 断言已修正为后续发布后的最终指针。

后续本地增量将准入覆盖至全部 API 写请求，包括注册、登录、登出与 bootstrap；纯内存预览及冻结控制端点除外。`LOCAL_AUTH_TEST_PORT=18996 npm run test:local-auth` 已通过：一个分段发送的真实本地 HTTP 请求先获得准入，再开始冻结；冻结查询看到在途请求，随后请求完成并排空；冻结期间登录/注册/登出被拒绝。readiness 还报告未过期上传 URL 数，但 `uploadsDrained` 始终为 false：无法仅由 URL 到期证明在途 PUT 已停止。Worker 崩溃遗留准入记录无自动修复；认证/写入实际请求覆盖仍须持续审查；remote 执行仍禁用。此测试使用 local D1/Worker，不证明 Cloudflare remote 行为。

同日增加管理员只读阻塞列表、上传意图与签名使用同一签发时间，以及准入完成写入故障的单元注入。静默证明和中断恢复仍未实现；可选方案及官方依据见 `P0-6-QUIESCENCE-RECOVERY-REVIEW.md`。远程执行继续禁用。

同日完成独立 SQLite fencing 与内存对象暂存原型；旧代次写入被拒绝，事务中断回滚，旧暂存写入不改变模拟的发布副本。对象复制后数据库失败会保留未发布孤儿，未实现恢复；原型不接入真实 D1/R2 或业务路径，不解除远程执行禁令。

后续本地跨存储恢复原型以 SQLite 记录 `prepared`/`copied`/`published`/`needs_review`、预期哈希与审计；模拟对象复制后中断可按相同哈希幂等收尾，旧代次须转人工审阅。`npm run test:cross-store-recovery-prototype` 已覆盖复制及发布中断、重复请求、哈希不符、对象缺失与冻结代次变化。该原型的对象存储是内存 Map，不支持真实跨进程恢复或 R2 并发语义，remote 仍禁用。

磁盘增量 `npm run test:cross-store-persistence` 已以磁盘 SQLite、文件对象和真实子进程完成两处 SIGKILL/重启、两个进程并发无覆盖创建、审计去重、篡改和旧代次测试。此夹具只证明本地进程中断场景，不代表掉电或真实 Cloudflare 一致性；remote 执行继续禁用。

2026-10-28 首个业务 fencing 切片：`0020_backup_write_epoch.sql` 建立代次，创建冻结时由 D1 触发器在同一事务内递增；写请求原子准入时记录代次。仅 `/api/admin/persons` 在 D1 batch 内校验开放准入、当前代次及冻结状态，再创建人物和审计。冻结中以及解冻后的旧请求返回 `409 backup_write_epoch_stale`，不创建人物或审计；新代次可以正常创建。注入审计失败时整个批次回滚。迁移仅在 local 测试；其他写路径尚未 fencing，R2 直传与孤儿恢复问题未解决，不能将该切片用于启用远程备份。

2026-10-28 后续扩展：人物姓名创建（含主姓名替换）、人物事实创建（含新增地点）、谱书和版本创建、来源人物记录创建与关联替换、来源事实和关系主张创建，均在各自单个 D1 batch 内执行准入/代次校验，业务写入与审计一起提交。local 集成测试并发挂起八类请求，跨冻结和解冻后确认旧代次均拒绝且表计数、主姓名、既有关联和审计不变；另注入姓名和来源关联审计失败，验证旧主姓名与旧关联回滚保留。该切片不覆盖名称/事实/地点退休、来源主张撤回、来源关系语义、媒体关联/上传、账号认证和审核、世系变更等写路径；不能视为全局 fencing。

本次验证：`npm run lint`、`npm run check`（29 文件、75 项）、`npm run build`、`LOCAL_AUTH_TEST_PORT=19001 npm run test:local-auth`、`npm run test:local-core-model` 与 `npm run test:local-backup-recovery` 均通过；全部集成测试使用隔离 local D1/R2。未访问远程资源。

验证：`LOCAL_AUTH_TEST_PORT=18999 npm run test:local-auth` 和 `npm run test:local-core-model` 通过；`npm run test:local-backup-recovery` 的初次运行暴露代次种子冲突，修复后又以两条历史冻结、源代次 7 和旧准入代次 6 验证末尾恢复，并拒绝缺失/重复单例，最终通过。`npm run lint`、`npm run check`（29 文件、75 项）、`npm run test:cross-store-persistence`、`npm run build` 均通过。此处只验证 local，未执行远程迁移或备份。

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
- 新增 `scripts/prepare-d1-restore-data.mjs` 与 `npm run prepare:d1-restore-data -- --input <data-only.sql> --output <prepared.sql>`：仅处理 Wrangler 的 data-only D1 导出，移除内部 `d1_migrations` 记录，将三个固定权限种子表的插入改为幂等形式，并在导入末尾恢复源写入代次。`test:local-backup-recovery` 覆盖迁移空目标、拒绝无效输入与覆盖输出、导入数据和代次恢复。
- 新增 `0018_backup_write_freeze.sql` 和管理员写冻结 API：`GET/POST /api/admin/backup-write-freeze`、`POST /api/admin/backup-write-freeze/release`。冻结时所有管理端业务写入统一返回 `423 backup_write_freeze_active`；读取和纯内存 revision preview 保持可用。启动与解除均写入 `audit_log`，且数据库只允许一个活动冻结窗口。该能力只在 local 测试中验证，未迁移到 preview。
- 新增 `scripts/remote-backup-preflight.mjs` 与 `npm run preflight:remote-backup -- --plan <non-secret-plan.json> --wrangler-config wrangler.jsonc --output <new-result.json>`：只校验不含秘密的 preview 备份计划，要求两个不同确认标识、活动写冻结 ID、外部归档位置标识，并精确核对 preview D1/R2 binding。它拒绝 production、目标不匹配和 token/secret/password/credential 字段，输出固定 `remoteExecutionAvailable: false`，不调用 Wrangler remote 或 Cloudflare API。
- 新增 `scripts/backup-local-archive.mjs` 与 `npm run archive:local-backup -- --package <verified-package-dir> --migration-dir migrations --destination <existing-local-dir> --backup-id <safe-id> --passphrase-file <mode-0600-file>`：先验证 manifest 与迁移基线，再生成临时 tar.gz、AES-GCM 加密到指定本机目录并删除临时明文；拒绝符号链接目录和覆盖已有归档。本机副本位于 Cloudflare 账户之外，但不等同于异地容灾副本。
- 新增 `scripts/backup-recovery-catalog.mjs` 与 `npm run catalog:backup-recovery -- <register|verify-retention> ...`：目录仅登记常规加密归档的 ID、路径、大小、SHA-256 与登记时间；保留校验重新哈希每个归档，且当前 local 演练强制至少三个恢复点。它不解密、不读取远程资源，也不以同机三份文件宣称已具备异地容灾。
- 新增 `P0-6-PREVIEW-REMOTE-EXECUTOR-DESIGN.md`：固化未来 preview 备份执行器的最小权限、拒绝 production、凭据分离与失败收敛契约；本阶段没有 remote 实现或 Cloudflare 调用。
- 新增 `remote-backup-command-plan.mjs`：只消费合格的 preview preflight JSON，生成不可执行的人工审阅步骤，永久输出 `remoteExecutionAvailable: false`；测试覆盖无效 preflight 与输出覆盖拒绝。
- 新增 `remote-backup-execution-precheck.mjs`：本地核验 preview 预检、不可执行命令计划、活动冻结/审批记录和非符号链接本机目录；不读取凭据、不联网，且拒绝输出覆盖。
- 新增 `validate-preview-recovery-authorization.mjs`：将非秘密授权记录、preflight 与执行前检查绑定校验，要求两位不同确认、演练窗口、清理责任和归档标识一致；输出仍不可执行。

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


## 2026-10-29：人物与来源生命周期 local fencing

姓名、事实、地点退休、来源事实/关系主张撤回及关系语义创建/退休接入 D1 事务内准入代次检查；退休和撤回的业务更新与条件审计同批次，地点引用及姓名主名在更新时重查。测试覆盖 local 审计插入失败的事务回滚、同一主张并发撤回只记一次审计，及来源语义创建的冻结前准入交错。无请求体生命周期入口的逐项准入后冻结交错尚未通过可控 HTTP 屏障验证；媒体、账号、世系等其他业务写入口仍有缺口。这些 local 结果不能证明全局写入排空、真实 D1/R2 行为或远程备份安全；远程执行仍禁用。


## 2026-10-29：媒体入口和可控 local 并发屏障

媒体上传意图、完成、人物媒体关联、排序和退休在本地 D1 写入事务内检查准入代次，关联退休时在事务内重查最后引用并按实际更新写审计。独立测试 Worker 可暂停目标请求的 D1 批次，让冻结和解除先完成，然后验证旧代次拒绝；它不属于正式 Worker 入口。该屏障只测试本地 Worker/D1 交错，不验证真实 Cloudflare 的 D1/R2 并发、直传 PUT 排空或生产安全。账号、世系和清理审阅等其他写入口尚需盘点，真实远程备份执行仍禁用。


## 2026-10-29：账号、世系和清理审阅 local fencing

本地迁移 `0021` 增加事务内准入代次断言：合法请求不持久化断言行，旧代次使整个批次回滚。账号审批、范围、拒绝和密码重置；世系创建、提案生命周期、版本发布和审核人指派；以及 local 清理审阅创建、确认、取消、过期接入该断言或现有 guarded 更新。部分原来分开的状态更新和审计已合并。屏障与故障注入只验证隔离 local Worker/D1，preview 尚未应用 `0016`–`0021`。认证注册/登录/登出、限流/会话及冻结释放仍需审查；R2 直传排空和真实远程备份执行仍未完成。


## 2026-10-29：认证、会话与冻结释放 local fencing

初始化管理员、注册、登录限流、会话签发和登出接入 D1 事务内准入检查；初始化、注册和会话签发分别与审计原子提交，签发时重查账号状态和密码哈希。冻结释放与条件审计同事务。登录限流在密码验证前独立提交：会话阶段失败时已提交的尝试计数保留，重试再次计数。中断后遗留准入记录仍保守阻塞，无自动恢复机制；local 事务故障注入和独立磁盘原型的进程重启测试不证明真实 Worker/D1 故障恢复，亦不能证明 R2 PUT 排空或远程备份可执行。


## 2026-10-29：认证 Worker SIGKILL 与隔离恢复夹具

本地测试在认证写入准入后、业务批次前终止专用 Worker 进程组并重启，验证开放准入仍阻塞；只在独占测试进程组全部停止后，对临时 local SQLite 执行事务化夹具恢复及审计，并检查拒绝和回滚路径。夹具不是可部署恢复接口，不能证明真实跨实例排空、提交中崩溃或 R2 PUT 已排空；远程执行保持禁用。详见 `P0-6-QUIESCENCE-RECOVERY-REVIEW.md`。


## 2026-10-29：独立恢复状态 local 原型

隔离 SQLite 原型使用不可修改的单独恢复记录和证据哈希，不改变准入的正常完成时间；应用不消费该记录，readiness 仍阻塞。子进程在 COMMIT 前和 COMMIT 返回后、确认前的 SIGKILL 测试验证回滚、幂等重试、并发同请求及单次审计；不证明 SQLite COMMIT 内部或真实 D1/Worker 中断语义。测试账号与调用方证据不是实际双人审批或可信全局排空证明，正式恢复与远程执行仍禁用。


## 2026-10-29：全局写入与 readiness 协议审查

`P0-6-READINESS-PROTOCOL-REVIEW.md` 盘点 47 个 POST/PUT 路由、准入/控制写及外部写面，区分当前只读快照和未实现的恢复、证据、双人审核与冻结窗口协议。识别世系发布辅助函数准入参数可选的未来绕过风险。Vitest 的合成反例模型始终拒绝远程执行，不接入应用；真实外部写者、跨实例停止、PUT 排空及 D1/R2 一致窗口仍未证明。


## 2026-10-29：写入口防遗漏与冻结交错

世系发布/回退辅助函数必须提供准入并走 fenced batch；77 项路由登记及 AST 检查纳入本地 `npm run check`。local 并发测试覆盖发布请求跨冻结、解除、重新冻结后在冻结中及解除后被拒绝；静态标记和具体交错均不能证明全局写者覆盖或导出窗口持续持有。远程执行与真实 PUT 排空仍禁用/未知。


## 2026-10-31：本地冻结窗口持有与失效模型

隔离 SQLite 原型验证冻结 ID/代次、单持有人、合成证据版本及有效期、顺序步骤、解除/重冻/撤销/过期、时钟回退和重启失效；子进程在事务提交前后 SIGKILL 及竞争持有均有本地测试。它未接入 mock 编排、Worker 或实际 D1/R2，不进行导出，不验证跨服务证据或真实 PUT 排空；远程执行保持禁用。详见 `P0-6-LOCAL-BACKUP-WINDOW-MODEL.md`。


## 2026-10-31：本地冻结窗口与 mock 备份组合

隔离 SQLite 窗口模型与本地 mock 包的五个步骤已组合，故障注入涵盖解除、重冻、证据失效、异常及进程终止。输出仅发布到测试专用目录，夹具验证器同时检查窗口状态、标记和包；强杀后遗留由测试监督器处理，并无真实自动恢复功能。真实 D1/R2 直传排空、跨服务事务和远程执行仍未实现。

## 2026-10-31：本地孤儿输出恢复夹具

新增独占临时根、SQLite 恢复意图与不可修改审计；窗口失效后的已证明所有权输出可清理，完成窗口保留。拒绝未登记路径、目录/标记身份变化、未知内容与链接，清理失败、审计失败、重试、进程终止和竞争由本地测试覆盖。停止判断是测试回调，文件检查与删除仍存在 TOCTOU，部分删除丢失标记须人工处理；没有通用清理器或远程能力。详见 `P0-6-LOCAL-ORPHAN-RECOVERY.md`。

## 2026-10-31：本地孤儿清理目录句柄与部分中断

测试夹具改用 Linux `/proc/self/fd` 目录描述符逐项清理，复查目录链身份并拒绝输出仍存在时记录完成；并发替换、实际逐项删除后 SIGKILL、重启与审计均有 local 验证。标记丢失仍拒绝自动清理。逐项检查与 unlink/rmdir 不是原子操作，恶意并发写者和目录移动仍有 TOCTOU；独占私有根前提、真实远程执行禁用均不变。详见 `P0-6-LOCAL-ORPHAN-RECOVERY.md`。

## 2026-10-31：孤儿移动歧义与只读审阅

本地清理意图存在但输出缺失时，不再把缺失推定为删除成功；重试保守拒绝。新增只读观察夹具，记录固定目标的有限元数据、状态和既有审计摘要，支持哈希比对与重新采集；不读取移动目标、不写审计或状态、不授权清理。子进程暂停后目录移走并 SIGKILL 的测试验证歧义保留和对象未删除。SHA-256 非签名，数据库与文件系统没有共同快照，也不保证对抗恶意并发写者；真实远程执行继续禁用。详见 `P0-6-LOCAL-ORPHAN-RECOVERY.md`。

## 2026-10-31：孤儿审阅并发与信任边界

只读观察在文件前后检查之外增加两次 SQLite 快照比较，数据库详情仅内部比较不输出；未知状态和审计动作拒绝，权限错误与缺失区分且不输出路径。独立子进程暂停审阅期间，目录、标记和 WAL 数据库审计详情变化均做本地交错测试。反例验证数据库所有者去除触发器后可伪造审计，新观察哈希仍可通过，未公开 detail 的稳定篡改甚至不改变公开报告。仅提出保守阻塞、分离角色与独立信任根的待确认人工处置设计，未实现审批或远程执行。详见 `P0-6-LOCAL-ORPHAN-REVIEW-BOUNDARY.md`。

## 2026-10-31：孤儿审阅测试密钥签名

增加 local-only Ed25519 测试夹具，使用内存密钥对本地观察、测试运行/根/attempt 标签与验证方挑战签名，公钥由调用方独立提供，同一内存验证器挑战单次消费。测试覆盖篡改、上下文错配、伪造密钥、重复验证、进程状态重建与挑战重用反例、虚假输入及状态过期。签名不能证明观察真实或新鲜；没有持久抗重放、可信时间、密钥管理、人工审批或远程执行。详见 `P0-6-LOCAL-ORPHAN-SIGNATURE-FIXTURE.md`。

## 2026-10-31：本地审阅挑战持久化与并发消费

新增隔离 SQLite 挑战夹具，复用本地签名验证，将单次消费与测试审计放入同一事务；测试独立进程竞争、无效签名竞争、审计失败及提交前后 SIGKILL。恢复旧数据库快照可使旧签名再次通过，是明确的防回滚反例；不具备可信时间、独立信任锚或真实审批能力，远程执行保持禁用。详见 `P0-6-LOCAL-ORPHAN-CHALLENGE-FIXTURE.md`。

## 2026-10-31：本地挑战账本的独立测试锚点

新增独立监督器内存摘要与测试工作进程；受控消费在 SQLite 写锁内核对摘要，提交前先记录 pending，提交后再推进锚点，跨边界中断保守阻塞。测试覆盖工作进程重启、监督器丢失、并发、提交前后 SIGKILL、库回退、schema 修改以及锚点重置反例。该实验未接管旧 `consume`/`issue`，测试已证明旧路径可绕过；监督器/IPC 无可信隔离，新基线可被重新设置。没有真实信任锚、审批或远程执行。详见 `P0-6-LOCAL-ORPHAN-ANCHOR-FIXTURE.md`。

## 2026-10-31：本地挑战受控签发与 pending 观察

本地锚点夹具新增受控签发，与受控消费共用 SQLite 锁、监督器准备及提交后推进；受控签发/消费竞争和签发审计失败均有独立进程测试。pending 观察只比较当前摘要与 before/after，返回 blocked，不能解锁。测试展示提交后恢复旧库也能表现为 matches_before；旧 issue/consume、直接 SQL 和 bootstrap 仍可绕过或破坏实验边界，没有真实审批、可信锚点或远程执行。详见 `P0-6-LOCAL-ORPHAN-CONTROLLED-OPERATIONS.md`。

## 2026-10-31：本地账本门面与响应丢失

新增测试调用门面，仅暴露受控签发、消费和只读观察；没有 OS 权限隔离，旧代码及数据库访问仍可绕过。受控进程测试覆盖监督器处理 prepare/finalize 后回复丢失或工作进程被杀：prepare 丢失使 pending 阻塞，finalize 丢失可呈现 ready/匹配但调用方结果未知，签发重试仍可产生新挑战。只读证据不改变账本或解除 pending；未实现持久幂等查询、可信锚点、审批或远程执行。详见 `P0-6-LOCAL-ORPHAN-FACADE-RESPONSE-LOSS.md`。

## 2026-10-31：本地挑战请求幂等与结果丢失

测试账本增加请求 ID、操作/输入摘要与历史结果，和挑战变更及审计同事务，并纳入监督器摘要。相同请求可查询或重试已记录结果，内容或操作冲突拒绝；pending/锚点不匹配时查询也拒绝。多进程竞争、finalize 响应丢失、提交边界强杀及整库回退/重新 bootstrap 反例均在 local 夹具中验证。结果不是审批，旧接口可绕过，库与锚点一起回滚后同一 ID 仍可产生新结果；没有可信时间、独立防回滚或远程执行。详见 `P0-6-LOCAL-ORPHAN-IDEMPOTENCY-FIXTURE.md`。

## 2026-10-31：本地幂等账本关联完整性

测试数据库对同一挑战/操作增加请求唯一索引；幂等查询和执行在锚点匹配后检查外键、scope、请求摘要、消费状态和审计关系，消费历史查询重新核对签名绑定。测试覆盖预先损坏的基线、重复关联、历史签发后消费及监督器丢失；同时展示同 scope 记录交换并恶意重建基线后仍无法检测的反例。全表检查只用于隔离夹具，不能证明历史真实性或阻止数据库所有者篡改；无真实审批或远程执行。详见 `P0-6-LOCAL-ORPHAN-LEDGER-INTEGRITY.md`。
