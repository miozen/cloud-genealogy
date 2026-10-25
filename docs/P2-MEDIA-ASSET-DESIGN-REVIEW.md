# P2 媒体资产与 R2 对象清单：设计审查

状态：已确认；第 29 项仅实现本地媒体资产数据模型与纯状态规则。上传接口、R2 凭据、远端资源和部署仍未授权。最后更新：2026-10-25。

## 1. 目的与范围

本切片的目的不是提前实现完整的相册、资讯或云祠，而是建立一套可授权、可审计、可备份恢复的图片/扫描件资产基础，使 P0-6 能以 D1 元数据为权威对象清单验证 R2 备份。

首切片范围建议仅包括：

- 私有 R2 中的图片和谱书扫描件；
- 不可变 `media_asset` 元数据和人物附件关联；
- 上传意图、完成校验、受权读取、退役与延迟清理；
- 本地 D1/R2 集成回归及备份包的媒体引用核验。

明确不包括：相册/资讯/评论/云祠 UI、视频上传或转码、OCR、公开桶、图片处理服务、删除已发布来源原件、remote 写入或部署。

## 2. 已确认事实与约束

- `docs/DATA_MODEL.md` 已列出 `media_asset`、`person_media`；实际迁移、媒体表和 R2 业务读写尚不存在。
- R2 binding 已在 `wrangler.jsonc` 声明，但当前 Worker 没有媒体路由；桶必须保持私有。
- 媒体、搜索与缩略图均须走服务端字段级授权；前端隐藏不能代替授权。
- 原始来源与已发布审计不可物理删除；媒体只有在解除引用并经过保留期后才可清理。
- P0 优先图片；视频仅允许后续由管理员受控上传或外链，不承诺无限容量。
- P0-6 当前不能验证真实媒体引用完整性，原因是缺少稳定媒体 ID、对象键、SHA-256、大小和 MIME 的权威记录。

Cloudflare 的当前约束也支持“元数据优先”：D1 单查询最多 100 个绑定参数；R2 Workers API 的写入是强一致的，`put()` 支持 SHA-256 校验和条件写入，R2 列表每次最多返回 1000 项。因此备份校验必须以 D1 的分页资产清单为准，不能用无边界的桶扫描替代引用核验。

参考：<https://developers.cloudflare.com/d1/platform/limits/>、<https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>、<https://developers.cloudflare.com/r2/objects/upload-objects/>。

## 3. 推荐的最小物理模型（待确认）

### `media_asset`

一行对应一个不可变 R2 对象版本，建议字段如下：

| 字段 | 规则与用途 |
|---|---|
| `id` | UUID 主键；所有业务引用均使用它，不使用对象键。 |
| `object_key` | 全局唯一、随机生成、无用户姓名/文件名；对象不覆盖。 |
| `sha256`、`byte_size`、`mime_type` | 上传意图声明并在完成时与 R2 元数据核验；是备份 manifest 的权威对象身份。 |
| `original_filename` | 仅保存经长度/字符限制后的展示名；不得用于对象键或响应头直传。 |
| `width`、`height` | 图片可选元数据；扫描件或未解析格式可为空。 |
| `visibility` | `PUBLIC`、`MEMBER`、`ADMIN`；实际读取仍需 Worker 授权及关联对象字段策略。 |
| `state` | `pending_upload`、`active`、`failed`、`retired`；仅 `active` 可被读取或建立新关联。 |
| `created_by_account_id`、时间字段 | 创建、完成、失败、退役及延迟清理时间，均可审计。 |
| `r2_etag` | 用于诊断和完成校验；不替代 SHA-256。 |

`object_key` 推荐固定为 `media/<uuid>`；新内容、替换内容或纠错一律创建新资产 ID 和新 key，不覆盖旧对象。

### 关联表

首切片只增加 `person_media`：`person_id`、`media_asset_id`、`role`（`portrait`、`document`、`other`）、`display_order`、可选说明、创建/退役审计字段。它使用真实外键，避免以“对象类型 + 任意字符串 ID”的通用关联表绕过完整性约束。

谱书页扫描、相册、资讯和云祠图片分别在其实体进入开发时增加专用关联表；都只能引用 `active` 资产。此策略比通用多态表更简单，也能让恢复演练精确统计每个资产的引用。

## 4. 推荐状态机与数据流（待确认）

```text
管理员创建上传意图
  → pending_upload + 随机 key + 预期 MIME/大小/SHA-256
  → 浏览器使用短时、单 key 的 PUT 授权直传私有 R2
  → 管理员/浏览器请求完成校验
  → Worker HEAD 校验 key、大小、MIME、SHA-256、状态与上传者
  → active + 审计 → 可关联到人物

失败/过期 → failed → 仅清理任务可删除无引用对象
解除全部引用 → retired + 保留期 → 清理任务删除 R2 对象及记录（写审计）
```

推荐使用浏览器直传 R2 的短时 presigned `PUT` URL，符合既有“不让 Worker 转发大文件”的决策。URL 是 bearer token，必须只允许指定 key、方法和必需请求头，默认有效期建议 5 分钟；同一 key 必须在完成前后拒绝重复覆盖。Cloudflare 说明 presigned URL 可允许 PUT 且可在 1 秒至 7 天有效；本项目不采用较长有效期。生成 URL 需要最小权限 R2 S3 凭据作为 Worker Secret，不能写入仓库、日志或返回给浏览器。

备选方案是由 Worker 流式接收小图片并调用 `MEDIA.put()`；优点是不新增 S3 签名凭据，缺点是违背既有“大文件不经 Worker”方向并受 Worker 请求/内存约束。推荐不采用它作为默认上传路径。

## 5. 授权、读取与配额

- 上传初始化、完成、退役、关联和清理均为服务端受权操作并写 `audit_log`；首切片只允许管理员上传和关联。
- 读取由 Worker 按资产可见性、关联对象和访问者角色判定；R2 不开放 public bucket 或裸 key URL。
- 下载响应只透传已校验的 `content-type` 和安全的 `content-disposition`；不信任客户端传入的 MIME、文件名或缓存头。
- 上传 MIME 首版建议限定 `image/jpeg`、`image/png`、`image/webp`；SVG、HTML、脚本、HEIC 和视频不进入本切片。
- 建议单文件上限 10 MiB、每次最多 10 个 pending 意图、每管理员每日限额和总存储阈值均由配置决定；具体数值须在启用前确认，不能假设免费额度永久不变。
- 缩略图、压缩和 EXIF 清理不在本切片承诺范围；原图显示前不应假设存在衍生图。

## 6. 与备份恢复的契约

完整备份从 `media_asset`（含 `active` 与仍处于保留期的 `retired` 资产）取得确定性清单，并逐项记录：`mediaAssetId`、`objectKey`、SHA-256、大小、MIME、state 和引用计数。恢复必须先导入已迁移的空 D1 目标、恢复资产元数据和对象、再逐项 `HEAD`/哈希/计数核验；D1 行存在而 R2 对象缺失，或反之，均为失败。

桶列举只能用于发现孤儿和运维清理，不是备份真相来源。清理 orphan 前必须生成仅管理员可读的预览、等待保留期并保留审计。这样 P0-6 才能从“合成对象字节比对”升级为“真实业务资产引用完整性验证”。

## 7. 验收与回归

实施后至少应在隔离 local D1/R2 覆盖：

1. 未授权用户不能创建、完成、读取、关联或退役资产；前端不存在的按钮不构成授权。
2. 随机 key 不含姓名或原文件名；同一 key 不能覆盖；过期或不属于当前上传者的意图不能完成。
3. MIME、大小、SHA-256 任一不匹配时保持非 `active`，不允许关联；失败对象进入可审计清理路径。
4. 私有读取严格按资产与人物可见性返回；不能通过猜测 object key 绕过 Worker。
5. 同一资产可被多个允许的关联引用；解除最后一个引用后也只能进入 `retired`，未到保留期不得删除。
6. 备份包 manifest 与 D1 清单、R2 对象逐项一致；缺对象、额外对象、哈希/大小/MIME 不符均中断恢复演练。
7. `npm run lint`、`npm run check`、`npm run build`、新增 local Worker/D1/R2 集成测试通过；remote、preview、production 操作仍需另行授权。

## 8. 需项目负责人确认

推荐确认以下最小方案后才编码：

1. **范围**：首切片只支持 JPEG/PNG/WebP 图片与扫描件；不支持视频、SVG、缩略图和内容相册。
2. **上传路径**：使用 5 分钟单对象 presigned PUT；接受为 Worker 配置最小权限 R2 S3 签名凭据，但不创建或写入该 Secret，直到另行授权。
3. **权限**：首切片只有管理员上传/关联/退役；读取遵循 `PUBLIC`/`MEMBER`/`ADMIN` 与关联人物的更严格规则。
4. **配额**：单文件 10 MiB；请确认每管理员每日上传次数、总存储预警阈值和是否需要首版硬拒绝阈值。
5. **保留期**：建议最后引用解除后保留 30 天，再由独立、可预览的管理员清理操作删除。
6. **原文件**：已确认不要求在上传前清除 EXIF/GPS；首切片保留原文件，展示层不得承诺 EXIF 已被移除。

确认后建议顺序：先迁移和纯权限/状态机测试，再实现 local R2 上传完成链路，最后把媒体清单接入 P0-6 local 恢复演练；任何 remote 测试或 Secret 配置继续单独确认。

## 9. 第 29 项实现状态

- `0016_media_asset_inventory.sql` 已实现 `media_asset` 与 `person_media`。资产状态、对象键、哈希、大小、MIME、可见性、保留期和人物关联均由 D1 约束；没有上传 API、R2 写入或远端配置。
- `worker/media/media-asset.ts` 是不依赖 D1/R2 的上传意图、完成校验和退役状态规则；覆盖随机对象键、5 分钟失效、10 MiB、MIME/哈希/文件名校验、R2 元数据不符转失败及最后引用解除后 30 天保留。
- 已实际通过 `npm run lint`、`npm run check`（25 个测试文件、61 项测试）、`npm run build` 与 `npm run test:local-core-model`。后者仅运行隔离 local Worker/D1；本项未调用 R2、preview 或 production。

## 10. 第 30 项实现状态

- 新增管理员上传意图 API、完成校验 API 和 `/api/media-assets/:assetId` 私有读取 API。创建和完成均写审计；完成仅接受当前上传者的 `pending_upload` 意图，并以 R2 `head` 的大小、MIME 和 SHA-256 对照 D1 意图。
- 本项不签发真实 presigned URL，也不配置 R2 S3 Secret；因此它不宣称已具备浏览器直传成功路径。完成校验会安全地将缺对象、过期或元数据不匹配的意图标记为 `failed`。
- `npm run test:local-auth` 已在隔离 local Worker/D1/R2 实际验证：管理员创建意图、缺失 R2 对象被拒绝且不可读取、成员资产的匿名读取被拒绝、管理员经 Worker 读取 local R2 对象成功。未使用 `--remote`。

## 11. 第 31 项实现状态

- 新增独立的 R2 S3 Signature Version 4 presigned `PUT` URL 生成器：固定默认 5 分钟有效期，仅允许 `media/` 下的单一对象键，并把 `content-type` 与 `x-amz-checksum-sha256` 作为必需签名请求头。它不发起网络请求、不读写 R2，也不接入 HTTP API。
- 输入中的 access key 与 secret key 只在内存中参与签名；模块不会记录、返回或写入它们。实际启用仍须由负责人单独创建并以 Worker Secret 注入仅限目标 bucket 的 R2 S3 凭据，同时配置 bucket CORS；不得把秘密提交、粘贴到对话或写入文档。
- 单元测试以固定时间和示例凭据验证 URL 可重复、对象/过期/签名头被约束，并验证不安全路径、校验和和有效期在签名前被拒绝。尚未用真实凭据或 remote R2 验证。

## 12. 第 32 项实现状态

- 管理员创建上传意图 API 已接入签名器。仅当运行环境同时提供 R2 account ID、bucket、access key ID 与 secret access key 时，才会先生成上传 URL、再原子写入 `pending_upload` 资产和审计记录；响应只含 URL、到期时间与浏览器必须带上的签名请求头，绝不含访问密钥。
- 缺少任一配置或配置不合法时，API 返回 `503 media_direct_upload_unavailable`，且不会写入待上传资产，避免生成无法使用或无法完成的意图。四项配置仍不写入 `wrangler.jsonc`；实际环境的 access/secret 必须以 Worker Secret 提供。
- `test:local-auth` 只对一次性隔离 local Worker 注入无效示例签名配置，验证受权意图响应含受限 URL 和必需请求头；它没有访问 S3 API、没有上传对象，随后仍验证缺对象完成被拒绝。

## 13. 第 33 项实现状态

- 管理员页面新增最小图片上传入口：先读取受权的直传可用性；未配置时按钮禁用并明确提示，不创建意图。已配置时仅接受 JPEG/PNG/WebP，调用同源 API 创建意图，再用 presigned URL 的必需签名头直接 `PUT`，最后调用同源完成校验。
- 浏览器直传不复用同源 API 的 Cookie/CSRF 请求封装；R2 `PUT` 仅含签名器要求的 MIME 和 checksum 头。客户端错误不会把资产描述为已激活，最终状态仍以完成 API 的 R2 `HEAD` 校验为准。
- 增加可注入 fetch 的单元测试，验证未配置时不会发出 R2 请求；local Worker 集成测试验证管理员能读取可用性。尚未对真实 R2 直传、CORS 或 remote Worker 进行验证。

## 14. 第 34 项实现状态

- 新增管理员已激活媒体清单和人物专用关联 API。关联只接受 `active` 资产和既存人物，重复活动关联返回冲突；每次关联写入 `person_media` 与审计记录，不复制、覆盖或删除 R2 对象。
- 媒体读取现在将资产自身可见性与全部活动人物关联的可见性取更严格者。因此公开资产一旦关联到仅管理员人物，也不能再被匿名或普通成员读取；未关联资产仍遵循资产自身可见性。
- 管理台可列出最多 100 个已激活资产、查看其受权读取链接并选择人物、用途、可选说明进行关联。尚未实现解除关联、排序修改、缩略图、内容/谱书页/云祠关联或远端直传验证。

## 15. 第 35 项实现状态

- 人物媒体关联现可由管理员读取、调整 `display_order` 与退休；排序和退休均记录审计。退休仅标记关联行，不物理删除它或 R2 对象。
- 退休最后一条活动人物关联时，资产在同一 D1 批处理内转为 `retired`，写入 30 天 `cleanup_after` 和独立媒体退休审计；仍被其他人物关联的资产保持 `active`。本切片没有清理任务，故保留期结束也不会自动删除任何对象。
- 管理台可选择人物查看其活动关联、更新排序或解除关联。尚未实现恢复已退休关联/资产、批量排序、缩略图、内容/谱书页/云祠关联或远端直传验证。
