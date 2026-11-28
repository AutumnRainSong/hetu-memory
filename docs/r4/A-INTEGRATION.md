# R4 · A 组接入说明（agt-purge → lead）

> 目标文件：`src/storage/sqlite-provider.ts`（**Lead 独占；A 组未修改**）
> 本文只给「原代码 → 改成」片段与插入位置。所有 SQL 由 A 组交付并经 A 组 60 项测试验证。

## 0. A 组交付的 API（`src/storage/blob-lifecycle.ts`）

```ts
export const PURGE_WORKER = 'purge-worker';        // 阶段一预留 / 阶段二执行共用身份

registerBlobRef(db, { ownerKey, blobRef, nodeId, revisionId, kind, contentHash, sizeBytes? })
  : { ok: true } | { ok: false; error: 'BLOB_BUSY' }        // 同步，事务内调用
refCountFor(db, ownerKey, blobRef): number                   // 同步

claimForDeletion(db, { ownerKey, blobRef, kind, worker })
  : { ok: true; seq; claimToken } | { ok: false; reason: 'HAS_REFS'|'NOT_ACTIVE' }   // 同步

planPurge(db, { ownerKey, nodeId, revisions[], operator, reason, worker? })
  : { ownerKey, nodeId, operator, scheduled[{ref,kind}], retained[{ref,refCount}] }  // 同步，事务内

runCleanup(db, blobs, { limit?, worker? })
  : Promise<{ attempted, removed, failed[{seq,ref,error}] }>  // async，事务外

reconcileBlobs(db, blobs, { limit?, worker? })
  : Promise<{ pendingRetry, filesRemoved, hadPending }>       // async，事务外
```

依赖：`ownerKeyFor(ownerId)` 与 `BlobStore.mainRefFor/archiveRefFor(ownerId, hash)`（**B 组已实现**）。
路径模板：`workspaces/<ownerKey>/blobs/<hash[0:2]>/<hash>`、`.../archive/<hash[0:2]>/<hash>`。

---

## 1. `putWithRevision()` —— 插入 registerBlobRef（A-2）

### 原代码（事务内，`return { ok: true, ... }` 之前）

```ts
        for (const e of edges) this.insertEdge(e, a);
        for (const o of outbox) this.insertOutbox(o, nodeIdStr(node.node_id), node.scope, a);
        return { ok: true, revision_id: node.revision_id };
```

### 改成

```ts
        for (const e of edges) this.insertEdge(e, a);
        for (const o of outbox) this.insertOutbox(o, nodeIdStr(node.node_id), node.scope, a);

        // ── R4 A-2：登记 blob 引用（与节点写入同一事务）──
        const ownerKey = ownerKeyFor(a.ownerId);
        if (node.content_ref) {
          const reg = registerBlobRef(this.db, {
            ownerKey,
            blobRef: node.content_ref,
            nodeId: nodeIdStr(node.node_id),
            revisionId: revisionIdStr(node.revision_id),
            kind: 'main',
            contentHash: String(node.content_hash),
          });
          // DELETING → 等待并重试（默认 3 次 × 50ms），超时失败
          if (!reg.ok) throw new Error('BLOB_BUSY');
        }
        if (node.minimized_blob_ref && node.minimized_blob_hash) {
          const reg = registerBlobRef(this.db, {
            ownerKey,
            blobRef: node.minimized_blob_ref,
            nodeId: nodeIdStr(node.node_id),
            revisionId: revisionIdStr(node.revision_id),
            kind: 'archive',
            contentHash: node.minimized_blob_hash,
          });
          if (!reg.ok) throw new Error('BLOB_BUSY');
        }

        return { ok: true, revision_id: node.revision_id };
```

> 也应在 `minimize()` 写归档文件之后登记 `kind:'archive'` 的引用（同一事务内）。

---

## 2. `purge()` —— 换成两阶段（A-4 + A-5）

### 原代码（事务内 `purge_blob_marks` + 直接 `blobs.remove()`）

```ts
        const blobRefs = new Map<string, 'main' | 'archive'>();
        for (const r of all) { if (r.content_ref) ...; if (r.minimized_blob_ref) ... }
        // ... markIns / insertedMarks / ③ 事务内 await this.blobs.remove(...) ...
```

### 改成 —— 阶段一（仍在 `withTx` 内）

```ts
        // ── R4 A-4：阶段一（Ledger + 删 refs + 原子认领 + 删节点/边/覆盖层/outbox）──
        const plan = planPurge(this.db, {
          ownerKey: ownerKeyFor(a.ownerId),
          nodeId: row.node_id,
          revisions: all.map(r => ({
            revisionId: r.revision_id,
            contentHash: r.content_hash,
            contentRef: r.content_ref,
            minimizedBlobRef: r.minimized_blob_ref,
          })),
          operator: a.agentId,          // Ledger.operator 必须是 auth.agentId
          reason: reasonCategory,
        });
        // planPurge 已删除节点行/两类边/sensitivity_overlay/outbox
        return { ok: true, revision_id: asRevisionId(row.revision_id), plan };
```

> ⚠️ `planPurge` **自带**节点与关系删除（契约 A-4 步骤 5）。原先
> `cleanupNodeRelations` / `DELETE sensitivity_overlay` / `DELETE outbox` / `DELETE nodes`
> 四段必须**删除**，不要重复执行。

### 阶段二（事务外，提交之后）

```ts
  async purge(...) {
    const out = await this.withTx(...);              // 阶段一已提交
    if (out.ok && this.blobs) {
      // 事务外物理删除；失败自动进 failed 队列，由 reconcile 补偿
      await runCleanup(this.db, this.blobs, { limit: 25 });
    }
    return out;
  }
```

**禁止**：在 `withTx` 内 `await runCleanup`（物理删除必须在逻辑删除提交后）。

---

## 3. `reconcile()` —— 接入 reconcileBlobs（A-6）

### 原代码

```ts
  async reconcile(): Promise<{ fixed: number; filesRemoved: number }> {
    // ... 遍历 purge_blob_marks ...
    await this.blobs.remove(...)
```

### 改成（reconcile 开头，事务外）

```ts
  async reconcile(): Promise<{ fixed: number; filesRemoved: number }> {
    let blobsRemoved = 0;
    if (this.blobs) {
      // R4 A-6：补偿 pending / failed / 超时 claimed，并清理 done 陈旧任务行
      const r = await reconcileBlobs(this.db, this.blobs, { limit: 50 });
      blobsRemoved = r.filesRemoved;
    }
    // ... 原有 node/edge/overlay/outbox 对账逻辑保留 ...
    return { fixed, filesRemoved: filesRemoved + blobsRemoved };
  }
```

---

## 4. 组装 `PurgeOutcome.cleanup`（契约 §5）

```ts
cleanup: {
  status: plan.retained.length === 0 && failed.length === 0 ? 'completed'
        : removed > 0 ? 'partial' : 'scheduled',
  scheduled: plan.scheduled.length,
  retained: plan.retained,                 // 必须出现在输出里（带 refCount）
  completedNow: removed,
  failed: failed.map(f => ({ ref: f.ref, error: f.error })),
  pendingRetry: await countPending(db),     // 或 reconcileBlobs().pendingRetry
}
```

---

## 5. 调用边界（重要）

| 函数 | 同步/异步 | 必须位置 |
|---|---|---|
| `registerBlobRef` | 同步 | **事务内**（与节点/边/outbox 同提交） |
| `claimForDeletion` / `planPurge` | 同步 | **事务内**（阶段一） |
| `runCleanup` / `reconcileBlobs` | 异步（含真实文件 I/O） | **事务外**（阶段二） |

`provider.withTx` 用 `BEGIN IMMEDIATE` + 串行 `writeChain`，A 组函数不另开事务/不另开连接。

---

## 6. 需 Lead 协调的依赖

| 依赖 | 归属 | 状态 |
|---|---|---|
| `ownerKeyFor` / `BlobStore.mainRefFor(ownerId,hash)` | B | ✅ 已实现（A 组测试直接用其真实值） |
| Migration 005 注册进 `MIGRATIONS` | E | ✅ 已注册（`migrate.ts` m005） |
| `PurgeOutcome` 类型（契约 §5） | Lead（`types.ts`） | ⬜ 待 Lead 添加 |
| provider 中旧 `purge_blob_marks` 流程下线 | Lead | ⬜ 阶段一改 `planPurge` 后即可移除 |

> 说明：`purge_blob_marks`（004）与 `blob_cleanup_tasks`（005）在迁移关闭期可共存；
> 但接入 `planPurge` 后**不得**再向 `purge_blob_marks` 写新行，否则 004 回滚判定失真。

---

## 7. 关键 SQL（Lead 复核用）

```sql
-- 原子认领（唯一正确的 TOCTOU 解法，changes===1 才算成功）
UPDATE blob_objects
   SET state='DELETING'
 WHERE owner_key=:ok AND blob_ref=:ref AND state='ACTIVE'
   AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE owner_key=:ok AND blob_ref=:ref);

-- 登记（DELETED 复活，DELETING 不复活）
INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash, size_bytes)
VALUES(:ok,:ref,:kind,'ACTIVE',:hash,:size)
ON CONFLICT(owner_key, blob_ref) DO UPDATE
  SET state='ACTIVE', deleted_at=NULL
  WHERE blob_objects.state IN ('ACTIVE','DELETED');

-- 阶段二领取（只拿 pending / failed / 超时 claimed / 自己预留的 claimed）
UPDATE blob_cleanup_tasks
   SET status='claimed', claim_token=:tok, claimed_by=:worker, claimed_at=datetime('now')
 WHERE seq IN (SELECT seq FROM blob_cleanup_tasks
                WHERE status IN ('pending','failed')
                   OR (status='claimed'
                       AND (claimed_at IS NULL
                            OR claimed_at < datetime('now','-5 minutes')
                            OR claimed_by=:worker))
                ORDER BY seq LIMIT :n)
 RETURNING seq, owner_key, blob_ref, kind;

-- 终态推进（只有 token 持有者能写）
UPDATE blob_objects SET state='DELETED', deleted_at=datetime('now')
 WHERE owner_key=:ok AND blob_ref=:ref AND state='DELETING';
UPDATE blob_cleanup_tasks SET status='done' WHERE seq=:seq AND claim_token=:tok;
```

---

## 8. 已知跨组问题（A 组发现，归属他人，未擅自修改）

| # | 现象 | 归属文件 | 建议处理 |
|---|---|---|---|
| **X-1** | `npx tsc -p tsconfig.json --noEmit` 报 2 错：`sqlite-provider.ts(231,29)` 与 `(406,33)` — `BlobStore.mainRefFor` 已被 B 组改为 `(ownerId, hash)` 双参，provider 仍按单参调用 | `src/storage/sqlite-provider.ts`（**Lead 独占**） | 集成时改为 `BlobStore.mainRefFor(a.ownerId, hash)`（两处：`blobRef()` 与 `revive()` 的 `mainRef`） |
| **X-2** | `tests/storage/provider.spec.ts:478` 断言 `BlobStore.archiveRefFor('../../etc','../passwd').startsWith('archive/')` 失败 — B 组把 archive 改为内容寻址 + owner 前缀 `workspaces/<ok>/archive/...` | `tests/storage/provider.spec.ts`（**Lead 所有**）+ B 组实现 | 需 Lead 裁定：改断言为 `startsWith('workspaces/')` 且仍不含 `..`，或由 B 组保留旧安全化语义。**A 组未改该文件** |

> A 组 9 个测试文件 60 项与此二问题无关，均不受影响。
