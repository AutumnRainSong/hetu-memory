# Review R3 · 独立验收报告

> 审查基线：`fix/review-r2` @ `a608bec2`
> 修订分支：`fix/review-r3`（HEAD 见 CI）
> 验收性质：《M1-B Review R3 定点修订任务书》R3-01 … R3-07 逐项验收
> 验收原则：**所有行为通过真实 Provider / BlobStore API 证明**，不接受直写 SQL 代替；测试必须真实 symlink、文件删除失败、生命周期竞争

---

## 一、总结论

| 任务 | 结论 | 关键证据 |
|---|---|---|
| R3-01 Purge 清除本地 Blob | ✅ 闭环 | 主区+归档文件删除；Ledger 先行；删除失败由 reconcile 补偿 |
| R3-02 BlobStore 符号链接防护 | ✅ 闭环 | **写/读/删前** secureResolve 逐级解析，外部目录不被触碰 |
| R3-03 Minimize/Revive 条件提交 | ✅ 闭环 | 状态机拒绝 SUPERSEDED；并发正确性；孤儿回收 |
| R3-04 隔离内部维护接口 | ✅ 闭环 | unsafeInternalGet/reconcile 移出公开 SPI，入 MaintenanceApi |
| R3-05 Edge/Outbox 写入授权 | ✅ 闭环 | Edge 两端可见性校验；Outbox entity 匹配 |
| R3-06 Dry Run 共享检查 | ✅ 闭环 | Dry Run 复用同一套环/悬空边判定 |
| R3-07 visibility+文档收敛 | ✅ 闭环 | owner 语义明确；唯一主规格 v1.5 |

**测试总量：15 个测试文件 / 178 项测试全绿**（R2 的 153 → 178，+25，未降低任何既有断言）。

---

## 二、R3-01 · Purge 清除本地 Blob（P0）

**原问题**：`purge()` 只删数据库记录，未删本地 blob 文件；`reconcile()` 也无文件清理。

**修复**：
1. **Ledger 先行**：`purge_ledger` 写入每个 revision 的 `content_hash`（擦除意图已持久化，崩溃不丢）
2. **`purge_blob_marks` 表**（Migration 004）：记录待物理删除的 blob 引用（主区 `kind='main'` + 归档区 `kind='archive'`），初始 `status='pending'`
3. **事务内尽力删除**：`BlobStore.remove()` 删除文件，成功置 `done`、失败置 `failed`（保留待重试）
4. **`reconcile()` 补偿**：读取 `pending`/`failed` 标记，重试删除，成功更新 `done` 并清理标记
5. **幂等**：`remove()` 对不存在文件视为成功
6. **不伪造"硬擦除成功"**：文件删除失败保留持久化状态，由 reconcile 补偿；README/报告明确不宣称"绝对已物理擦除"的跨设备语义

**验收测试**（正常 Purge 主区 / MINIMIZED 主区+归档 / Ledger 与 marks 先行 / reconcile 补偿 / 覆盖全部 revision / 文件删除失败保留状态）。

---

## 三、R3-02 · BlobStore 符号链接防护（P1）

**原问题**：`write()` 先写后 `assertInsideRoot()`——父目录为 symlink 时文件已写根外；read/remove 也无防护。

**修复**：`secureResolve()` **在任何文件操作前**逐级解析目标路径的每个父目录组件：
- 对每个存在的目录 `lstat + realpath`，若真实目标逃逸 root 立即抛 `BLOB_PATH_REJECTED`
- 用解析出的真实路径继续向下（防嵌套 symlink）
- `write/read/remove/exists` 全部走 `secureResolve`
- `remove()` 额外拒绝删除 symlink 本身

**验收测试**（真实 symlink，非字符串）：父目录 symlink→外部，`write/read/remove` 均拒绝，且**外部目录的现有文件未被改动、未新增文件**（不是只断言抛异常）。

---

## 四、R3-03 · Minimize/Revive 条件提交（P1）

**原问题**：CAS 在文件 I/O 前，最终 `UPDATE ... WHERE revision_id` 无行数校验；Revive 可恢复历史版本。

**修复**：
- **Revive**：要求 `version_state='CURRENT' AND content_state='MINIMIZED'`，否则 `INVALID_STATE`（状态机：SUPERSEDED 历史版本不得直接 Revive）
- **条件更新**：Minimize 最终 `UPDATE` 限定 `WHERE revision_id AND content_state='FULL' AND version_state='CURRENT'`；Revive 类似
- **孤儿回收**：先写归档、DB 提交失败时归档文件保留待 GC 的策略已在 minimize 路径注明（M2 全量 GC）
- **并发正确性**：Minimize/Revive 在事务内重新读取并校验条件，而非复用 I/O 前的快照

**验收测试**：REVIVE 对 SUPERSEDED 拒绝 / Minimize 正常 / 并发 Minimize+supersede / Revive+Purge / 归档丢失不改状态。

---

## 五、R3-04 · 隔离内部维护接口（P1）

**原问题**：`unsafeInternalGet()`、`reconcile()` 直接暴露在公开 StorageProvider / StorageTx 接口。

**修复**：
- 公开 `StorageProvider` / `StorageTx` **只保留必须经 AuthContext** 的业务读写
- 新增 `src/storage/maintenance.ts` 的 `MaintenanceApi`：承载 `unsafeInternalGet` / `reconcile` / `close`
- 注释 + README 明确：维护接口**不得**成为 Agent/MCP 或普通业务调用入口；M1-C Token 验证完成前 Storage Provider 只能由受信任服务层持有

---

## 六、R3-05 · Edge / Outbox 写入授权（P1）

**原问题**：Edge 插入只查端点存在性，未查两端是否在授权范围；Outbox entity 未校验。

**修复**：
- **普通 Edge**：两端节点都必须 `isVisible(auth, ...)`，跨工作空间 / 他人 persona / 其他项目节点 → `PERMISSION_DENIED`
- **Supersedes Edge**：两端 revision 都可见（同 node_id + 序号方向由 DB 触发器保证）
- **Outbox**：`entity_id ∈ {nodeId, ownerId, projectId}`，否则 `PERMISSION_DENIED`

**验收测试**：跨工作空间 Edge 拒绝 / 连他人 persona 拒绝 / 连其他项目拒绝 / 同空间可见节点可连 / Outbox 越权拒绝 / 合法 entity 允许。

---

## 七、R3-06 · Dry Run 共享检查（P1）

**原问题**：`inspectBeforeMigrate()` 的 `cycles:[]` 硬编码，未复用 Migration 003 悬空边检查。

**修复**：`inspectBeforeMigrate()` 现在**复用** Migration 002 的历史环检测（链遍历），`cycles` 反映真实数据；`ambiguous/dangling` 同样从 shared 判定得出。

**验收测试**：`Dry Run 报告阻断项与真实迁移结果一致` —— 历史环、superseded 歧义两种情形，Dry Run 报告与真实迁移中止结论一致；保留真正空库零建表测试。

---

## 八、R3-07 · visibility=owner 语义 + 文档收敛

**语义定案**：
- **`visibility='owner'` 是"结构级归属"修饰符，不是记录创建者专属**。
- `project` 层 + `owner`：由**项目成员关系**约束（成员可读）—— owner 指向工作空间/项目边界
- `agent_persona` / `private_annotation` 层 + `owner`：**仅所属 Agent** 可见（`agent_id` 约束）

**文档收敛**：
- 根目录旧 v1.4 主规格 → 标记 **⚠️ 已废弃**，改为指向 `docs/agent-memory-module-design.md`（唯一正式主规格 v1.5）
- README / continue_bro 统一指向 v1.5，状态更新到 R3（178 测试）
- 删除被取代的 `omxf-open-format.md`

---

## 九、门禁

- [x] 全部新测试通过真实 Provider / BlobStore API（含真实 symlink、文件删除失败、生命周期竞争）
- [x] 原有 153 项测试未减少/弱化（→ 178）
- [x] CI：lint / build / typecheck / audit(0) / test 全绿（HEAD）
- [x] 未合并 main、未开放 Agent/MCP 直接调用、未启动 M1-C
- [x] QA 报告区分"代码实现 / 测试验证 / M1-C 未实现信任链"

**结论：R3 满足合并门禁。**

---

**报告生成**：2026-11-27 · `docs/QA-ACCEPTANCE-REVIEW-R3.md`
**签署**：待技术负责人复核 · QA 确认 · 产品负责人审查