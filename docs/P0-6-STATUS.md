# P0-6 状态：备份与恢复

状态：离线包与 local 恢复基线已完成；remote 备份、加密保管与测试环境演练尚未开始。最后更新：2026-10-25。

## 已完成

- 基于实际 migrations、Worker/R2 使用情况、Wrangler 环境配置和现有本地验证脚本完成备份恢复审查。
- 复核当前 Cloudflare 官方 D1 导入导出、R2 S3 API 与 Workers 限制文档，并在 [设计审查](/home/mio/projects/cloud-genealogy/docs/P0-6-BACKUP-RECOVERY-DESIGN-REVIEW.md) 中固化限制与推荐方案。
- 确认本切片前没有既有 backup/restore 工具；当前仍没有 `backup_record` 物理表、媒体元数据表、R2 业务写入代码或 CI 工作流，因此没有宣称未发生的 remote 备份、恢复或演练。
- 新增 `scripts/backup-package.mjs`：只处理已落在本地目录的离线包，生成带 D1 SQL、R2 对象、迁移基线、计数与 SHA-256 的 `manifest.json`，并在任何导入前执行只读预检。它不含 remote 命令、凭据读取、加密或恢复写入。
- 新增 `npm run test:local-backup-recovery`：在一次性临时目录中使用 Wrangler local D1/R2 完成导出、对象取回、manifest 生成/预检、全新目标恢复和对象内容比对；篡改对象后预检会失败，恢复命令不会执行。

## 当前风险与未完成项

- 本地基线采用管理员受控命令、至少保留三个成功点、恢复到新资源而非覆盖的推荐默认值；真正 remote 执行仍须在加密与密钥保管责任、保留节奏、写冻结体验及资源切换细节确认后另行授权。
- 生产资源仍未创建/使用；production D1 ID 为占位值。任何远程 D1/R2 导出、测试恢复、资源创建、Secret 写入或部署都需要独立明确授权。
- D1 与 R2 不具备跨服务原子快照；媒体上线前必须实现可审计写冻结及以媒体元数据为准的对象清单，不能依赖全桶盲扫。
- 当前只完成 local D1/R2 夹具演练；尚无 remote 测试环境演练、真实媒体元数据引用校验、加密包恢复或灾难切换测试。

## 本切片验证

| 检查 | 结果 |
|---|---|
| 本地源码、迁移、运行配置与脚本审计 | 已执行；确认没有既有备份/恢复实现或 CI 工作流。 |
| Cloudflare 官方文档复核 | 已执行；D1 SQL 导出/导入、R2 S3 访问及 Workers 限制与设计一致。 |
| `npm run test:local-backup-recovery` | 通过：仅临时 local D1/R2，验证导出、只读预检、隔离恢复、对象内容比对及篡改拦截。 |
| `npm run lint`、`npm run check`、`npm run build` | 通过：23 个测试文件、53 项测试；生产构建完成。 |
| remote D1/R2、部署或恢复写入 | 未执行。 |

## 下一步（需确认后）

下一切片应先补齐包内业务计数与未来媒体元数据的真实采集入口，并设计加密/密钥恢复演练；仍不连接 remote。完成后，才单独申请测试环境恢复演练授权。
