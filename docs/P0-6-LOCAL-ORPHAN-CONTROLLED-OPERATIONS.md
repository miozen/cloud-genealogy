# P0-6 local-only 挑战账本受控操作与 pending 对账评审

状态：2026-10-31，仅本机测试夹具。没有人工审批、业务恢复接口或远程执行；不连接 Cloudflare、不读取真实凭据。以下比较与观察均不授权删除或证明观察真实。

## 写入路径盘点

| 测试入口或写面 | 当前行为与约束 |
|---|---|
| `createLocalChallengeFixture` | 创建私有根、SQLite schema、元数据和审计触发器；只用于测试初始建库，之后由监督器显式 bootstrap 基线。 |
| `guardedFixtureIssue` | 新增测试路径；在 SQLite 写锁内检查锚点，写入随机挑战和 `issued` 审计，准备监督器 pending 后提交并推进锚点。只有提交及推进均确认后才返回挑战。 |
| `guardedFixtureConsume` | 在同一协议下验签并写入消费状态及审计；签名无效时回滚，不修改锚点。 |
| 原 `ChallengeFixture.issue` / `consume` | 仍可直接调用，**不会**检查锚点。保留原有测试用途；它们可以绕过实验守护，后续受控操作只能检测到账本摘要已漂移。 |
| 直接 `.db` SQL、DDL、复制或替换 SQLite 文件 | 可被测试用户执行，不能被本原型阻止。指定修改可被摘要比较发现，但已发生的无锚点操作不能撤销。 |
| 监督器 `bootstrap` / `prepare` / `finalize` IPC | 独立测试进程内存状态由测试调用方控制；IPC 没有身份认证。bootstrap 可信性、重放和监督器自身失陷未解决。 |
| `inspectFixturePending` | 仅比较当前账本摘要与监督器 pending 的 before/after；获取 SQLite 写锁并最终回滚，不修改账本，也不清除 pending 或推进锚点。 |

受控签发和消费复用同一事务模板。测试用两个独立工作进程竞争签发与消费，确认 SQLite 写锁串行化、双方完成后锚点与账本一致；签发审计失败时事务回滚且不推进锚点。所有这些只覆盖测试进程通过对应函数执行的情况，不是对现有数据库写入的强制拦截。

## 保守对账

当监督器仍持有 `pending(before, after)` 时，对账只返回：

- `matches_before`：当前账本摘要等于准备前摘要。
- `matches_after`：当前账本摘要等于准备后摘要。
- `mismatch`：两者都不相等。
- 无监督器、无 pending 或通信失败：拒绝观察。

所有结果均为 `blocked`，远程执行不可用；重复观察不改变 pending，也不会自动撤销、重试、确认或重置基线。`matches_before` **不证明没有提交**：测试在消费已提交后恢复旧数据库快照，结果仍匹配 before。类似地，`matches_after` 也不是对历史、身份或文件系统真实状态的独立证明。没有可信不可回滚锚点、可信进程停止证明和受控审批前，不能仅凭这些分类解除阻塞。

测试覆盖受控签发与消费的提交前后 SIGKILL、完整提交后回退、pending 时未知直接写入、重复对账及无锚点拒绝；测试还保留无锚点消费和重新 bootstrap 造成重放的反例。监督器内存丢失、监督器/IPC 被伪造、数据库和锚点一起回滚、数据库所有者恶意写入、最终系统调用竞态均无法由本夹具解决。审计触发器及本地摘要不构成真实信任根；未测试掉电或 SQLite COMMIT 指令内部崩溃。

`npm run test:local-orphan-anchor` 执行本轮实验；challenge、signature、recovery 和 mock 备份回归仍应运行。

后续测试门面及 prepare/finalize 回复丢失实验见 `P0-6-LOCAL-ORPHAN-FACADE-RESPONSE-LOSS.md`。门面不是权限隔离，finalize 回复丢失后 ready 匹配也不证明调用方已经得到结果。
