# P0-6 preview 远程备份执行器：最小权限设计

状态：设计与 local-only 契约完成；未实现 remote 调用。最后更新：2026-10-26。

## 目标与严格边界

未来执行器只允许从已确认的 **preview** D1/R2 创建一个本机加密备份包；不部署 Worker、不修改 Secrets、不创建资源、不迁移数据库、不恢复数据，绝不接受 production。它必须先通过 `remote-backup-preflight.mjs`，且只有一次性 remote 授权存在时才可启用独立的实际执行器。

本阶段没有 `--remote`、Cloudflare SDK、token 读取或网络请求；任何工具输出均应包含 `remoteExecutionAvailable: false`。

## 输入与最小权限

不含秘密的计划必须包含：preview D1/R2 binding、两个不同确认标识、活动写冻结 ID、审批记录 ID、外部归档位置标识和 backup ID。计划不允许 token、secret、password、credential 或 access key 字段。

实际执行时分离两类临时凭据，且不入库、不写日志：

- D1 导出：仅限指定 preview account/database 的 D1 读取/导出能力；不得授予 D1 Edit、账户设置、Worker、Secrets 或 token 管理权限。
- R2 下载：仅限指定 preview bucket 的 S3 Object Read；不得授予写入、删除、bucket 管理或其他 bucket 权限。

Cloudflare 当前文档将 D1 Read 与 D1 Edit 区分，且 Edit 包含写能力；R2 S3 凭据可限制至特定 bucket。因此实际授权必须先由责任人核验控制台显示的精确权限名称与资源范围，不能依赖本文档的过期快照。

## 未来受控顺序

1. 本地验证预检结果、两人确认、活动写冻结和一次性 preview 授权。
2. 导出 preview D1 到权限受限临时目录；导出期间保持冻结。
3. 按导出的 `media_asset` 清单下载已引用 R2 对象，逐项计算 SHA-256。
4. 采集计数、生成 manifest、执行本地预检、加密归档到本机并登记恢复点。
5. 任何失败都删除临时明文、解除冻结并写外部操作记录；不生成“成功”备份。

执行器不得自动解除冻结、不得自动上传、不得以同机目录替代异地副本，也不得把本地成功描述为 remote 恢复演练。

## 本阶段验收

- 设计文件、预检和本机归档/恢复点目录均为 local-only；
- production、秘密字段和未经确认的目标被拒绝；
- 未发起任何 Cloudflare API、Wrangler remote、部署或远程读写。

## 下一阶段前置条件

责任人需要在安全审批记录中确认：两个恢复责任人、短时凭据的精确 scope、preview 可覆盖窗口、外部/异地保管位置与一次性执行授权。秘密不进入仓库、聊天或预检计划。
