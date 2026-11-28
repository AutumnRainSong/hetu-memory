# 河图 HeTu · R4 团队执行分工与实施计划（v2.0 开工版）

> **基线**：`ebcd1310e8aa0ac988bd0f6c9fdb1e50b220a148`
> **技术负责人 / 集成人**：Lead
> **状态**：✅ 产品负责人已批准开工（2026-11-27）
> **配套**：[R4-CONTRACTS.md](R4-CONTRACTS.md)（接口契约冻结版）· [R4-TASK-BOARD.md](R4-TASK-BOARD.md)（任务看板）

---

## 零、已冻结的架构裁决（不得重新开放讨论）

| # | 裁决 | 硬约束 |
|---|---|---|
| **1** | **Purge 两阶段** | 阶段一（DB 事务内）：逻辑删除 + Ledger + 引用处理 + 任务登记；提交后立即不可访问/不可写/不可 Revive。阶段二（事务外）：物理删除。物理删除**绝不**在阶段一提交前发生 |
| **2** | **引用事实 + 生命周期状态** | `blob_refs` 行数即引用数（**不设 ref_count 冗余列**）；状态机 `ACTIVE → DELETING → DELETED`；**归零与转 DELETING 同事务原子完成**；DELETING 禁新增引用；**只有成功认领的 Worker 能删除**；`unlink` 前再查引用数**不算**解决 TOCTOU，必须原子认领 |
| **3** | **Blob owner 物理隔离** | 同 owner 内不同 Agent/Project/Revision 按 Hash 复用；**不同 owner 同 Hash 必须不同物理文件**；Main 与 Archive 都遵守；`owner_id` **不得原样拼路径**，用稳定摘要 owner-key |
| **4** | **BlobStore 文件安全** | 目标文件 symlink 防护 + 父目录 symlink 防护 + root 真实路径校验 + 路径替换/TOCTOU 防护 + 临时文件原子写；`remove()` **仅 ENOENT 幂等**，权限/IO 错误必须真实上报 |
| **5** | **Minimize/Revive 并发** | 最终状态检查进最终事务；UPDATE 带预期状态 CAS 条件；**检查 affected rows**；跨 Provider 跨连接并发测试；失败孤儿文件处理；补齐 Revive/Purge/Supersede 交叉并发 |
| **6** | **Migration 004 Down（方案 A）** | 存在 `pending`/`claimed`/`failed` 任一未完成清理任务 → **拒绝回滚**并列出任务。**禁止**转存 `migration_reports` 后删表 |

---

## 一、组织分工（正式授权）

| 工作线 | 负责人 | 主要职责 | 优先级 |
|---|---|---|---|
| **A** | `agt-purge` | Purge 两阶段机制、Blob 引用管理、清理任务与重试 | P0 |
| **B** | `agt-blob` | BlobStore 安全、owner namespace、文件系统安全 | P0 |
| **C** | `agt-lifecycle` | Minimize / Revive 并发一致性 | P0 |
| **D** | `agt-api` | Storage / Maintenance API 运行时隔离 | P1 |
| **E** | `agt-migration` | Migration Dry Run、Preflight、悬空引用检查 | P1 |
| **F** | `agt-qa` | 独立测试、故障注入、全量回归 | P1 |
| **集成** | **Lead** | 契约冻结、**Provider 独占修改**、跨组集成、最终验收组织 | — |

- A–F 全部由 DeepSeek Flash 执行
- **F 组不得修改 `src/**` 业务实现代码**，但从开发阶段起即独立设计测试、准备夹具、持续验证
- **真人负责人（用户）保留最终安全审查与合并批准权**

### 1.1 分支

```
main                                    ← 本轮禁止合并
 └─ ebcd1310 (fix/review-r3)            ← R4 固定基线
     ├─ r4/a-purge
     ├─ r4/b-blobstore
     ├─ r4/c-lifecycle
     ├─ r4/d-api-isolation
     ├─ r4/e-preflight
     ├─ r4/f-qa
     └─ r4/integration                  ← Lead 独占
```

规则：各组只推自己分支；Commit 消息带任务号（`[R4-A1]`）；禁止直推 `r4/integration` / `main`。

---

## 二、代码所有权（严格执行）

### 2.1 `src/storage/sqlite-provider.ts` 由 Lead 独占

**A、B、C、D 一律不得修改该文件。** 各组只交付：

1. 独立模块实现（新文件）
2. 函数 / 接口实现
3. 对应测试
4. **精确接入说明**（改哪一行、插在哪个位置、为什么）
5. 必要的 diff 建议（文本形式，不直接改文件）

Lead 统一完成 Provider 的跨组接线。

> ⚠️ 前版文档「`sqlite-provider.ts` 归 C 组」的表述**已作废**。

### 2.2 文件所有权矩阵

| 文件 | 独占 Owner |
|---|---|
| `src/storage/sqlite-provider.ts` | **Lead** |
| `src/storage/types.ts` | **Lead** |
| `src/storage/blob-store.ts` | **B** |
| `src/storage/blob-lifecycle.ts`（新） | **A** |
| `src/storage/migrations/005_blob_objects.ts`（新） | **A** |
| `src/storage/migrations/004_purge_blob_marks.ts` | **A** |
| `src/storage/lifecycle-cas.ts`（新） | **C** |
| `src/storage/spi.ts` | **D** |
| `src/storage/maintenance.ts` | **D** |
| `src/storage/factory.ts`（新） | **D** |
| `src/storage/preflight.ts`（新） | **E** |
| `src/storage/migrate.ts` | **E**（含注册 005） |
| `tests/storage/blob-*.spec.ts` | **B** |
| `tests/storage/blob-lifecycle*.spec.ts` | **A** |
| `tests/storage/lifecycle-*.spec.ts` | **C** |
| `tests/api/*.spec.ts` | **D** |
| `tests/migrations/preflight*.spec.ts` | **E** |
| `tests/qa-r4/**` | **F** |
| 既有 `tests/**`（178 项） | **Lead** |

跨组修改需求 → 先找 Lead 协调所有权与契约，**禁止互相覆盖代码**。

---

## 三、接口契约冻结（P0 已交付）

详见 **[R4-CONTRACTS.md](R4-CONTRACTS.md)**，包含 12 节：

1. Blob 对象数据模型与路径规则（owner-key 摘要）
2. Blob 生命周期状态机（ACTIVE/DELETING/DELETED 迁移合法性表）
3. 数据库模型（`blob_objects` / `blob_refs` / `blob_cleanup_tasks` + 唯一约束）
4. **原子删除认领**（唯一正确的 TOCTOU 解法）
5. Purge API 返回语义（`logicalDeleted` 与 `cleanup` 严格分离）
6. Minimize/Revive 最终 CAS 约束（纯函数契约）
7. Storage / Maintenance 运行时隔离（Facade + `in` 断言）
8. Preflight 契约（含 `danglingNodeEdges` / `danglingRevisionEdges`）
9. Migration 004 Down 策略（方案 A）
10. 代码所有权总表
11. 跨组依赖顺序
12. 验收门禁

---

## 四、任务拆解

### A 组 · Purge 与 Blob 引用管理（P0）

| ID | 任务 | 交付文件 | 测试 |
|---|---|---|---|
| A-1 | Migration 005：`blob_objects` / `blob_refs` / `blob_cleanup_tasks` | `migrations/005_blob_objects.ts` | `tests/storage/blob-schema.spec.ts` |
| A-2 | `registerBlobRef()`（登记引用 + 对象存在性 + DELETING 拒绝） | `blob-lifecycle.ts` | `tests/storage/blob-register.spec.ts` |
| A-3 | `claimForDeletion()`（**原子认领**：UPDATE…WHERE…NOT EXISTS + 插任务） | `blob-lifecycle.ts` | `tests/storage/blob-claim.spec.ts` |
| A-4 | `planPurge()`（阶段一：Ledger + 删 refs + 认领 + 删节点/边/覆盖层/outbox） | `blob-lifecycle.ts` | `tests/storage/purge-plan.spec.ts` |
| A-5 | `runCleanup()`（阶段二：领取 + unlink + 状态机推进 + 重试） | `blob-lifecycle.ts` | `tests/storage/purge-cleanup.spec.ts` |
| A-6 | `reconcileBlobs()`（补偿 pending/claimed 超时/failed） | `blob-lifecycle.ts` | `tests/storage/purge-reconcile.spec.ts` |
| A-7 | Migration 004 Down 方案 A（未完成任务 → 拒绝回滚） | `migrations/004_*.ts` | `tests/migrations/004-rollback.spec.ts` |
| A-8 | 共享 Blob 保护（引用>0 不认领） | `blob-lifecycle.ts` | `tests/storage/purge-shared.spec.ts` |
| A-9 | 跨 owner 隔离（同 Hash 两 owner 各自独立） | `blob-lifecycle.ts` | `tests/storage/purge-cross-owner.spec.ts` |
| A-10 | Provider 接入说明（不改文件） | `docs/r4/A-INTEGRATION.md` | — |

### B 组 · BlobStore 安全与隔离（P0）

| ID | 任务 | 交付文件 | 测试 |
|---|---|---|---|
| B-1 | `ownerKeyFor()` + `mainRefFor(ownerId,hash)` + `archiveRefFor(ownerId,hash)`（**Archive 也内容寻址**） | `blob-store.ts` | `tests/storage/blob-namespace.spec.ts` |
| B-2 | 目标文件为 symlink → write/remove 拒绝 | `blob-store.ts` | `tests/storage/blob-symlink-target.spec.ts` |
| B-3 | 父目录 symlink 防护 | `blob-store.ts` | `tests/storage/blob-symlink-parent.spec.ts` |
| B-4 | Root 真实路径校验（构造时 realpath 落盘） | `blob-store.ts` | `tests/storage/blob-root-realpath.spec.ts` |
| B-5 | `writeAtomic()` 临时文件 + rename；rename 前再次 secureResolve | `blob-store.ts` | `tests/storage/blob-atomic.spec.ts` |
| B-6 | `remove()` 仅 ENOENT 幂等；其余抛 `BlobDeleteError` | `blob-store.ts` | `tests/storage/blob-remove-errors.spec.ts` |
| B-7 | 跨 owner 物理隔离（同 Hash 两文件、删一不影响另一） | `blob-store.ts` | `tests/storage/blob-isolation.spec.ts` |
| B-8 | 路径替换竞态独立并发测试 | `blob-store.ts` | `tests/storage/blob-toctou.spec.ts` |

### C 组 · Minimize / Revive 并发（P0）

| ID | 任务 | 交付文件 | 测试 |
|---|---|---|---|
| C-1 | `buildMinimizeUpdate()` CAS 纯函数 | `lifecycle-cas.ts` | `tests/storage/lifecycle-cas-unit.spec.ts` |
| C-2 | `buildReviveUpdate()` CAS 纯函数（含 ref/hash 条件） | `lifecycle-cas.ts` | 同上 |
| C-3 | `assertSingleRow()` 辅助 | `lifecycle-cas.ts` | 同上 |
| C-4 | 失败孤儿文件登记（接 A 组 `registerBlobRef`/清理任务） | `lifecycle-cas.ts` | `tests/storage/lifecycle-orphan.spec.ts` |
| C-5 | 跨 Provider / 跨连接并发测试（Minimize×2、Revive×2） | — | `tests/storage/lifecycle-concurrent.spec.ts` |
| C-6 | Revive×Purge、Minimize×Supersede 交叉并发 | — | `tests/storage/lifecycle-cross.spec.ts` |
| C-7 | Provider 接入说明 | `docs/r4/C-INTEGRATION.md` | — |

### D 组 · API 运行时隔离（P1）

| ID | 任务 | 交付文件 | 测试 |
|---|---|---|---|
| D-1 | `MaintenanceApi` 接口（`unsafeInternalGet`/`reconcile`/`close`/`blobRef`/`dangerousRawForTests`） | `maintenance.ts` | `tests/api/maintenance-shape.spec.ts` |
| D-2 | `StorageProvider` 剥离维护方法 | `spi.ts` | `tests/api/service-shape.spec.ts` |
| D-3 | `createStorage()` Facade（冻结对象，不暴露底层实例） | `factory.ts` | `tests/api/factory.spec.ts` |
| D-4 | 运行时断言（`in` 检查：service 无维护方法、maintenance 无业务方法） | — | `tests/api/isolation.spec.ts` |
| D-5 | Provider 接入说明（移除 `get raw`、`blobRef` 迁维护面） | `docs/r4/D-INTEGRATION.md` | — |
| D-6 | 持有边界文档（M1-C 前仅受信任服务层） | `docs/r4/D-BOUNDARY.md` | — |

### E 组 · Preflight（P1）

| ID | 任务 | 交付文件 | 测试 |
|---|---|---|---|
| E-1 | `preflight()` 纯只读函数骨架 | `preflight.ts` | `tests/migrations/preflight-basic.spec.ts` |
| E-2 | 普通 edge 悬空检查（node_id 端点） | `preflight.ts` | `tests/migrations/preflight-edges.spec.ts` |
| E-3 | supersedes edge 悬空检查（revision_id 端点） | `preflight.ts` | 同上 |
| E-4 | 环 / 歧义 / 未映射 全覆盖 + `blocking` 判定 | `preflight.ts` | `tests/migrations/preflight-blocking.spec.ts` |
| E-5 | `runMigrations` / `rollbackTo` 改用 `preflight()` | `migrate.ts` | `tests/migrations/preflight-wiring.spec.ts` |
| E-6 | 注册 Migration 005 到 `MIGRATIONS` 数组 | `migrate.ts` | 同上 |
| E-7 | 「`blocking` 与真实迁移中止一一对应」测试 | — | `tests/migrations/preflight-consistency.spec.ts` |

### F 组 · 独立 QA（P1）

> 只允许改 `tests/qa-r4/**` 与 `docs/QA-ACCEPTANCE-REVIEW-R4.md`

| ID | 场景 | 测试文件 |
|---|---|---|
| F-1 | 同 owner 不同 Agent/Project/Revision 复用同一 Blob | `tests/qa-r4/reuse-same-owner.spec.ts` |
| F-2 | 两 owner 同 Hash → 物理文件完全隔离 | `tests/qa-r4/cross-owner-isolation.spec.ts` |
| F-3 | Main 与 Archive 引用登记/清理一致性 | `tests/qa-r4/main-archive-consistency.spec.ts` |
| F-4 | 引用归零后另一连接尝试登记新引用 | `tests/qa-r4/refzero-newref-race.spec.ts` |
| F-5 | Blob 进入 DELETING 后另一 Agent 写相同内容 | `tests/qa-r4/deleting-write-race.spec.ts` |
| F-6 | 删除中进程中断 → 重启 reconcile 恢复 | `tests/qa-r4/crash-recovery.spec.ts` |
| F-7 | unlink 权限/IO 错误 → 任务保留并重试 | `tests/qa-r4/unlink-failure.spec.ts` |
| F-8 | 共享引用未归零 → Purge 不删物理文件 | `tests/qa-r4/shared-ref-protection.spec.ts` |
| F-9 | Migration 004 有 pending/failed 任务时回滚 → 任务完整保留 | `tests/qa-r4/migration-004-rollback.spec.ts` |
| F-10 | 目标 symlink / 父目录 symlink / 路径替换竞态 | `tests/qa-r4/symlink-race.spec.ts` |
| F-11 | 不同 Provider 并发 Minimize/Revive | `tests/qa-r4/concurrent-providers.spec.ts` |
| F-12 | Minimize/Revive/Supersede/Purge 交叉并发 | `tests/qa-r4/lifecycle-cross.spec.ts` |
| F-13 | 新记忆与 Purge 同时发生 | `tests/qa-r4/write-vs-purge.spec.ts` |
| F-14 | Dry Run 零写入 + 两类边悬空检查 | `tests/qa-r4/preflight-zero-write.spec.ts` |
| F-15 | Maintenance API 不可被业务调用方绕过 | `tests/qa-r4/api-isolation-runtime.spec.ts` |
| F-16 | 178 项回归零弱化 | `tests/qa-r4/regression-inventory.spec.ts` |
| F-17 | 独立 QA 报告 | `docs/QA-ACCEPTANCE-REVIEW-R4.md` |

每个测试必须注明：**前置条件 / 并发方式 / 预期 / 实际 / 失败时数据状态 / 文件与用例名**。

---

## 五、阶段与里程碑

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **P0** | 契约冻结 ✅ + 建 6 分支 + 派发 A–F | 本文档 + CONTRACTS 定稿 |
| **P1** | A/B/C/D/E 并行开发；F 同步写测试 | 各组新增测试全绿 + 178 项不退化 |
| **P2** | **集成 A+B+C**（Lead 打 provider 补丁） | Blob 生命周期 + 引用 + 并发一致性全绿 |
| **P3** | **集成 D+E** | API 运行时隔离 + preflight 一致性全绿 |
| **P4** | **F 独立全量验收**（同一最终 HEAD） | F 报告通过 + 178 项零弱化 |
| **P5** | 合并申请（真人审查批准） | 全部阻断项关闭 |

**持续集成要求**：从第一天起，Lead 每日把各组最新分支合入 `r4/integration` 并跑门禁，及时暴露跨组冲突——不留到最后。

---

## 六、验收标准

### 6.1 各组

- **A**：两阶段严格分离；引用>0 绝不删；原子认领有测试；失败可追踪可重试；004 回滚拒绝而非转存
- **B**：目标/父目录 symlink 双防护（外部文件内容+存在性双断言）；root realpath；原子写；`remove` 不吞非 ENOENT；同 owner 去重 / 跨 owner 隔离
- **C**：CAS 条件 UPDATE + `changes===1`；跨连接并发单向成功；孤儿登记；SUPERSEDED 不得 Revive
- **D**：运行时 `in` 断言 service 无维护方法；`maintenance` 无业务方法；Facade 冻结
- **E**：单一 `preflight()` 共用；两类边悬空；零写入；`blocking` 与真实中止一一对应
- **F**：不改 `src/**`；178 项零弱化；交叉+故障注入有真实用例；报告三分法

### 6.2 全局（提交合并申请前）

- [ ] lint / build / typecheck / Branded IDs 契约 / Migration / 单元 / 集成 / E2E / audit(0) 全绿，**同一 HEAD**
- [ ] 原 178 项测试全保留、断言未弱化（Lead 逐条 diff）
- [ ] 新增并发 + 故障注入测试全绿
- [ ] F 独立 QA 报告（含测试文件、场景、命令、结果、最终 SHA）
- [ ] 未合并 main、未启动 M1-C 编码、未接入 Agent/MCP

---

## 七、项目边界（禁止事项）

- ❌ 合并 main
- ❌ 启动 M1-C 实际业务开发（可写设计文档）
- ❌ 提前接入 Agent / MCP 直接访问
- ❌ 为让 CI 变绿而删除测试或弱化断言
- ❌ 将未解决 P0 标记为完成
- ❌ A/B/C/D 修改 `sqlite-provider.ts`

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| A/B 契约漂移 | CONTRACTS.md 冻结 + 逐 commit 审 |
| `sqlite-provider.ts` 多处接入 | **Lead 独占**，各组只交说明 |
| 原子认领 SQL 写错导致误删 | A-3 必须有"引用未归零 → 认领失败"的失败用例 |
| 并发测试在 Windows 不稳定 | 文件库 + `busy_timeout`；断言"恰好一个成功"而非顺序 |
| 178 项回归被弱化 | Lead 逐条 diff + F 组独立复核 |
| deepseek-flash 产出需复核 | 每组附测试执行输出，Lead 本地复跑 |
| TOCTOU 只做"再查一次" | 契约 §4 明确：必须原子认领，F-10 独立验证 |
