# 河图 HeTu · R4 接口契约（P0 冻结版 v1.0）

> **状态**：已冻结，A–F 六组不得私改签名。需变更走「契约变更申请」由 Lead 裁决。
> **基线**：`ebcd1310e8aa0ac988bd0f6c9fdb1e50b220a148`
> **依据**：《R4 开工指令》§二 六条架构裁决（不得重新开放讨论）

---

## 1. Blob 对象数据模型（Blob Object Model）

一个 **Blob 对象** = 一个 owner 工作空间内、某个内容 Hash 对应的一份物理文件。
同一 owner 内，多个 Agent / Project / Revision 通过**引用**共享同一对象；跨 owner 永不共享。

### 1.1 路径规则（B 组实现，全员遵循）

```
owner-key   = sha256(<规范化 owner_id>)[0:32]      // 稳定摘要，不是原样拼接
main   ref  = workspaces/<owner-key>/blobs/<hash[0:2]>/<hash-hex>
archive ref = workspaces/<owner-key>/archive/<hash[0:2]>/<hash-hex>
```

**硬约束**：
- `owner_id` **绝不**原样进路径；必须先 `ownerKeyFor(ownerId)` 生成稳定摘要
- **Main 与 Archive 都是内容寻址**（都用 content hash 定位）→ 同一 owner 内跨 Revision 天然去重
- Archive 与 Main 共用同一套 `blob_refs` / `blob_objects` 生命周期，`kind` 字段区分
- 路径中 `hash-hex` 是不含 `sha256:` 前缀的 64 位十六进制

```ts
// src/storage/blob-store.ts —— B 组独占
export const ownerKeyFor = (ownerId: string): string =>
  createHash('sha256').update(ownerId.normalize('NFC')).digest('hex').slice(0, 32);

export class BlobStore {
  constructor(root: string);

  static mainRefFor(ownerId: string, hash: ContentHash): string;
  static archiveRefFor(ownerId: string, hash: ContentHash): string;

  resolve(ref: string): string;                    // 词法校验
  secureResolve(ref: string): Promise<string>;     // 含逐级 realpath（symlink 防护）
  writeAtomic(ref: string, content: Buffer | string): Promise<string>;  // tmp + rename
  read(ref: string): Promise<Buffer>;
  readVerified(ref: string, expectedHash: string): Promise<Buffer>;
  exists(ref: string): Promise<boolean>;
  /** ENOENT → 幂等成功；其余（EACCES/EIO/EPERM/…）→ 抛 BlobDeleteError */
  remove(ref: string): Promise<void>;
  unlinkIfExists(ref: string): Promise<'removed' | 'absent'>;  // 供清理 worker
}
export class BlobDeleteError extends Error { readonly code = 'BLOB_DELETE_FAILED'; }
```

---

## 2. Blob 生命周期状态机（B 组定状态，A 组实现流转）

```
                  ┌──────────────────────────────────────┐
                  │                                      │
   [不存在] ──write──▶ ACTIVE ──引用归零且被 Worker 认领──▶ DELETING ──unlink 成功──▶ DELETED
                        ▲                                    │
                        │                                    └──unlink 失败──▶ 回到 DELETING（保留任务，可重试）
                        │
                  新写入遇到 DELETING：
                  (a) 等待 → DELETED → 重新创建为 ACTIVE    ← 推荐
                  (b) 或复用 DELETED 记录原地复活为 ACTIVE  ← 等价机制，须证明安全
```

### 2.1 状态迁移合法性

| 从 | 到 | 触发 | 约束 |
|---|---|---|---|
| （无记录） | `ACTIVE` | 首次写入 / 重新创建 | INSERT，主键冲突则按现状处理 |
| `ACTIVE` | `DELETING` | **原子认领** | 仅当 `refCount === 0` 且 `state === 'ACTIVE'`，单条 SQL 完成 |
| `DELETING` | `DELETED` | unlink 成功 | 仅认领者可写（`claim_token` 匹配） |
| `DELETING` | `DELETING` | unlink 失败 | `retry_count+1`、记 `last_error`，保留任务 |
| `DELETED` | `ACTIVE` | 新内容写入同 Hash | 复用或重建；`refCount` 从 0 重新累加 |

**禁止**：`ACTIVE → DELETED` 直接跳转；`DELETING` 期间登记新引用。

---

## 3. 数据库模型（Migration 005，A 组交付）

```sql
-- ① Blob 对象：每个 (owner, ref) 一行，承载生命周期状态
CREATE TABLE blob_objects (
  owner_key    TEXT NOT NULL,
  blob_ref     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('main','archive')),
  state        TEXT NOT NULL CHECK (state IN ('ACTIVE','DELETING','DELETED')),
  content_hash TEXT NOT NULL,
  size_bytes   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at   TEXT,
  PRIMARY KEY (owner_key, blob_ref)
);
CREATE INDEX idx_blob_objects_state ON blob_objects(state) WHERE state <> 'ACTIVE';

-- ② Blob 引用事实（唯一事实来源；行数 = 引用数，不设 ref_count 冗余列）
CREATE TABLE blob_refs (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key   TEXT NOT NULL,
  blob_ref    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('main','archive')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- 同一 revision 对同一 blob 的同一用途只能登记一次
  UNIQUE (owner_key, blob_ref, revision_id, kind)
);
CREATE INDEX idx_blob_refs_count ON blob_refs(owner_key, blob_ref);

-- ③ 清理任务队列（持久化、可认领、可重试、不可被 migration_reports 替代）
CREATE TABLE blob_cleanup_tasks (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key   TEXT NOT NULL,
  blob_ref    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('main','archive')),
  status      TEXT NOT NULL CHECK (status IN ('pending','claimed','failed','done')),
  claim_token TEXT,
  claimed_by  TEXT,
  claimed_at  TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_cleanup_active
  ON blob_cleanup_tasks(owner_key, blob_ref)
  WHERE status IN ('pending','claimed','failed');
CREATE INDEX idx_cleanup_pickup ON blob_cleanup_tasks(status, seq);
```

**`blob_refs` 唯一约束的理由**：`(owner_key, blob_ref, revision_id, kind)` —— 同一 revision 对同一 blob 的同一用途重复登记无意义，唯一约束可防重复计数导致"引用永不归零、文件永不删除"。

---

## 4. 原子删除认领（裁决 §2.2 —— 解决 TOCTOU 的唯一正确方式）

> **明确**：只在 `unlink` 前再次查询 `refCount === 0` **不能解决** TOCTOU。必须原子认领。

### 4.1 认领（阶段一，在 Purge 的**同一事务内**）

```sql
-- 对每个候选 blob 执行；changes === 1 表示认领成功
UPDATE blob_objects
   SET state = 'DELETING'
 WHERE owner_key = :owner_key
   AND blob_ref  = :blob_ref
   AND state     = 'ACTIVE'
   AND NOT EXISTS (
         SELECT 1 FROM blob_refs
          WHERE owner_key = :owner_key AND blob_ref = :blob_ref
       );
-- 随后（仍在同一事务内）登记清理任务
INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status, claimed_by, claimed_at, claim_token)
VALUES(:owner_key, :blob_ref, :kind, 'claimed', :worker, datetime('now'), :claim_token);
```

**为什么这样原子**：`UPDATE … WHERE … AND NOT EXISTS(…)` 在 SQLite 单条语句内完成"读引用数 + 改状态"，中间插入新引用的并发事务要么在本次之前提交（此时 `NOT EXISTS` 为假→认领失败，正确）要么在其之后排队（此时 `state='DELETING'` 会阻止其登记）。

### 4.2 新引用登记（阶段一同一事务）

```sql
-- ① 若对象处于 DELETING → 拒绝（由调用方重试或等待）
INSERT INTO blob_refs(owner_key, blob_ref, node_id, revision_id, kind) VALUES(...);
-- ② 确保对象存在且为 ACTIVE
INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
VALUES(:owner_key, :blob_ref, :kind, 'ACTIVE', :hash)
ON CONFLICT(owner_key, blob_ref) DO UPDATE
  SET state = 'ACTIVE', deleted_at = NULL
  WHERE blob_objects.state IN ('ACTIVE', 'DELETED');   -- DELETING 不复活
```

登记前**必须**先查 `blob_objects.state`：
- `ACTIVE` → 正常登记
- `DELETING` → 返回 `BLOB_BUSY`，调用方**等待并重试**（默认 3 次 × 50ms），超过则失败
- `DELETED` → 复活为 `ACTIVE`（文件由调用方 `writeAtomic` 重写）后登记

### 4.3 物理删除（阶段二，事务外，仅认领者可执行）

```ts
// 1) 领取任务：UPDATE ... SET status='claimed', claim_token=? WHERE seq=? AND status IN ('pending','failed')
// 2) 执行 blobs.unlinkIfExists(ref)
// 3) 成功: UPDATE blob_objects SET state='DELETED', deleted_at=now WHERE ... AND state='DELETING';
//         UPDATE blob_cleanup_tasks SET status='done' WHERE seq=? AND claim_token=?
//    失败: 若 ENOENT → 视作成功；否则 UPDATE blob_cleanup_tasks
//          SET status='failed', retry_count=retry_count+1, last_error=? WHERE seq=? AND claim_token=?
//          （blob_objects 保持 DELETING，等待下次重试）
```

---

## 5. Purge API 返回语义（裁决 §2.1 —— 必须区分两个阶段）

```ts
export interface PurgeOutcome {
  /** 阶段一：逻辑删除是否已提交（提交后立即不可访问/不可写/不可 Revive） */
  logicalDeleted: true;
  /** 阶段二：物理清理状态 —— 绝不用 true 表示"已全部物理删除" */
  cleanup: {
    status: 'scheduled' | 'completed' | 'partial';
    scheduled: number;      // 入队多少
    retained: { ref: string; refCount: number }[];  // 因仍有引用而保留，未入队
    completedNow: number;   // 本次立即删除成功数
    failed: { ref: string; error: string }[];
    /** 未完成部分由 reconcile 持续补偿 */
    pendingRetry: number;
  };
}
```

**禁止表述**：
- ❌ "Purge 成功 = 硬擦除完成"
- ✅ "逻辑删除已提交；物理清理 X/Y 完成，剩余 N 项待重试（reconcile 持续补偿）"
- 共享 Blob 被保留时**必须**出现在 `retained` 里并给出 `refCount`

---

## 6. Minimize / Revive 最终 CAS 约束（C 组交付纯函数，Lead 接入）

```ts
// src/storage/lifecycle-cas.ts —— C 组独占（新增文件）
export interface CasUpdateSpec { sql: string; params: unknown[]; }

export const buildMinimizeUpdate = (args: {
  revisionId: string; archiveRef: string; archiveHash: string; stubSummary: string;
}): CasUpdateSpec;
// → UPDATE nodes SET content_state='MINIMIZED', stub_summary=COALESCE(stub_summary,?), minimized_blob_ref=?, minimized_blob_hash=?
//    WHERE revision_id=? AND version_state='CURRENT' AND content_state='FULL'

export const buildReviveUpdate = (args: {
  revisionId: string; expectedRef: string; expectedHash: string; mainRef: string;
}): CasUpdateSpec;
// → UPDATE nodes SET content_state='FULL', content_ref=COALESCE(content_ref,?), minimized_blob_ref=NULL, minimized_blob_hash=NULL
//    WHERE revision_id=? AND version_state='CURRENT' AND content_state='MINIMIZED'
//      AND minimized_blob_ref=? AND minimized_blob_hash=?

/** 断言单行被更新；否则返回 STATE_CONFLICT（不得报告成功） */
export const assertSingleRow = (changes: number): { ok: true } | { ok: false; error: 'STATE_CONFLICT' };
```

**每条 UPDATE 必须命中这些 CAS 条件**（用 `AND` 连接，缺一不可）：

| 操作 | 必需 CAS 条件 |
|---|---|
| Minimize | `revision_id` + `version_state='CURRENT'` + `content_state='FULL'` |
| Revive | `revision_id` + `version_state='CURRENT'` + `content_state='MINIMIZED'` + `minimized_blob_ref` + `minimized_blob_hash` |

**`changes !== 1` → 返回 `{ ok: false, error: 'STATE_CONFLICT' }`，并清理已生成的孤儿文件（登记清理任务）。**

---

## 7. Storage / Maintenance 运行时隔离（D 组）

```ts
// src/storage/factory.ts —— D 组独占（新增）
export interface StorageHandles {
  readonly service: StorageProvider;      // 业务面：全部方法需 AuthContext
  readonly maintenance: MaintenanceApi;   // 维护面：仅受信任服务层/运维
}
export function createStorage(provider: SqliteStorageProvider): StorageHandles;
```

| 面 | 方法 |
|---|---|
| **service**（`StorageProvider`） | `get` / `put` / `query` / `graphTraverse` / `vectorSearch` |
| **maintenance**（`MaintenanceApi`） | `unsafeInternalGet` / `reconcile` / `close` / `blobRef` / `dangerousRawForTests` |

**运行时必须成立**（`'x' in obj` 断言，非仅类型）：
- `service` 上**不存在** `unsafeInternalGet` / `reconcile` / `close` / `raw` / `blobRef`
- `maintenance` 上**不存在** `get` / `put` / `query`
- `createStorage` 返回的对象是**冻结的 Facade**，不暴露底层 provider 实例

---

## 8. Preflight 契约（E 组）

```ts
// src/storage/preflight.ts —— E 组独占（新增）
export interface PreflightReport {
  kind: 'PREFLIGHT_REPORT';
  isFreshDatabase: boolean;
  appliedVersions: number[];
  pendingVersions: number[];
  nodeCount: number;
  unmappedRevisions: string[];
  supersededConvertible: string[];
  supersededAmbiguous: string[];
  supersededDangling: string[];
  danglingNodeEdges:      { type: string; from: string; to: string }[];
  danglingRevisionEdges:  { type: string; from: string; to: string }[];
  cleanupTasksIncomplete: number;    // R4 新增：未完成的 blob 清理任务（影响 004 回滚判定）
  cycles: string[];
  blocking: boolean;
  text: string;
}
/** 严格只读：不建表、不写库。dryRun 与真实迁移共用本函数。 */
export function preflight(db: Db, opts: MigrationOptions): PreflightReport;
```

**`blocking` 判定规则**（任一为真即 `blocking: true`）：
`unmappedRevisions.length && !acceptDefaultScopeMapping` ∨ `supersededAmbiguous.length` ∨ `supersededDangling.length` ∨ `cycles.length` ∨ `danglingNodeEdges.length` ∨ `danglingRevisionEdges.length` ∨ `(nodeCount > 0 && !legacyOwnerId)`

---

## 9. Migration 004 Down 策略（裁决 §2.6 方案 A）

```ts
// 004.down(db) —— A 组实现
// 1) 检查 blob_cleanup_tasks 是否存在 status IN ('pending','claimed','failed')
// 2) 若存在 → 抛错 MIGRATION_ABORTED，列出未完成任务（最多 50 条）
// 3) 全部为 done（或表不存在）→ 才执行 DROP TABLE
```

**禁止**：把任务转存到 `migration_reports` 后删表；`migration_reports` 不是清理任务队列。

---

## 10. 代码所有权总表（Lead 独占 `sqlite-provider.ts`）

| 文件 | 独占 Owner | 备注 |
|---|---|---|
| `src/storage/sqlite-provider.ts` | **Lead** | **A/B/C/D 一律不得修改**，只交接入说明 |
| `src/storage/types.ts` | **Lead** | 需新类型向 Lead 申请 |
| `src/storage/blob-store.ts` | **B** | 路径/安全/owner-key |
| `src/storage/blob-lifecycle.ts` | **A** | 认领/登记/清理（新） |
| `src/storage/migrations/005_*.ts` | **A** | 三张新表 |
| `src/storage/migrations/004_*.ts` | **A** | 回滚安全 |
| `src/storage/lifecycle-cas.ts` | **C** | CAS 纯函数（新） |
| `src/storage/spi.ts` | **D** | |
| `src/storage/maintenance.ts` | **D** | |
| `src/storage/factory.ts` | **D** | Facade（新） |
| `src/storage/preflight.ts` | **E** | （新） |
| `src/storage/migrate.ts` | **E** | 含注册 005 |
| `tests/storage/blob-*.spec.ts` | **B** | |
| `tests/storage/blob-lifecycle*.spec.ts` | **A** | |
| `tests/storage/lifecycle-*.spec.ts` | **C** | |
| `tests/api/*.spec.ts` | **D** | |
| `tests/migrations/preflight*.spec.ts` | **E** | |
| `tests/qa-r4/**` | **F** | 只加测试，不改 `src/**` |
| 既有 `tests/**`（178 项） | **Lead** | 仅允许等价改写，须 Lead 批准 |

---

## 11. 跨组依赖与交付顺序

```
B（blob-store: 路径/owner-key/安全）
   └─▶ A（blob-lifecycle: 用 B 的 ref 生成器 + 认领 SQL）
          └─▶ C（lifecycle-cas: 需 A 的 blob_refs 登记接口做孤儿清理）
                 └─▶ Lead 集成（provider 接线）
D（api 隔离）──▶ Lead 集成（provider 移除 raw/blobRef）
E（preflight + 注册 005）──▶ Lead 集成
F（全程并行写测试，P4 独立验收）
```

**关键**：A 的 Migration 005 文件由 A 交付，但**注册到 `MIGRATIONS` 数组由 E 完成**（E owns `migrate.ts`）。

---

## 12. 验收门禁（每阶段同一 HEAD）

```
npm run lint && npm run build && npm run typecheck && npm test
npm audit --audit-level=high
```

原有 **178 项测试必须全部保留**，断言不得弱化（Lead 逐条 diff 校验）。
