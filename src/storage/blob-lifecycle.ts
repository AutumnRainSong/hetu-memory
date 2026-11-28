/** Purge 生命周期与 Blob 引用管理（R4 · A 组独占，契约 §2/§4/§5）
 *
 *  两阶段严格分离（架构裁决 #1/#2）：
 *  - 阶段一 `planPurge()`：必须在调用方已开启的事务内执行。Ledger 先行 → 删引用 →
 *    原子认领（ACTIVE→DELETING）→ 删节点/边/覆盖层/outbox。提交后该 blob 立即不可
 *    访问/不可写；物理文件此时**一定还在**。
 *  - 阶段二 `runCleanup()`：事务外。领取任务 → unlink → 状态机 DELETING→DELETED →
 *    任务 done。失败保留 DELETING + 任务 failed，由 `reconcileBlobs()` 持续补偿。
 *
 *  关键约束：
 *  - `blob_refs` 行数即引用数（不设 ref_count 冗余列）。
 *  - 引用归零与转 DELETING 由**单条 SQL** 原子完成（解决 TOCTOU 的唯一正确方式）。
 *  - 只有持有 `claim_token` 的 worker 能推进 DELETING→DELETED 与任务终态。
 */
import type { DatabaseSync } from './sqlite.ts';

export type Db = InstanceType<typeof DatabaseSync>;

/** 阶段一预留认领与阶段二执行认领共用的 worker 身份。
 *  同一身份预留的 claimed 任务可被立即续跑；其他 worker 必须等 5 分钟超时后接管。 */
export const PURGE_WORKER = 'purge-worker';

// ───────────────────────── A-2 · 登记引用 ─────────────────────────

export type RegisterRefResult = { ok: true } | { ok: false; error: 'BLOB_BUSY' };

export interface RegisterBlobRefArgs {
  ownerKey: string;
  blobRef: string;
  nodeId: string;
  revisionId: string;
  kind: 'main' | 'archive';
  contentHash: string;
  sizeBytes?: number | null;
}

/**
 * 登记一个 blob 引用（契约 §4.2）。若调用方已 BEGIN，则并入该事务（本函数不开事务）。
 *
 *  ① 查 `blob_objects.state`：`DELETING` → `BLOB_BUSY`（不入库、不复活）
 *  ② 确保对象存在且为 ACTIVE（`DELETED` 复活为 ACTIVE；`DELETING` 不复活）
 *  ③ 登记 `blob_refs`；UNIQUE 冲突静默忽略（幂等）
 */
export function registerBlobRef(db: Db, args: RegisterBlobRefArgs): RegisterRefResult {
  const row = db
    .prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?')
    .get(args.ownerKey, args.blobRef) as { state: string } | undefined;

  if (row?.state === 'DELETING') return { ok: false, error: 'BLOB_BUSY' };

  // DELETING 不复活（DO UPDATE 的 WHERE 挡住）
  db.prepare(
    `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash, size_bytes)
     VALUES(?,?,?,'ACTIVE',?,?)
     ON CONFLICT(owner_key, blob_ref) DO UPDATE
       SET state='ACTIVE',
           deleted_at=NULL,
           content_hash=excluded.content_hash,
           size_bytes=COALESCE(excluded.size_bytes, blob_objects.size_bytes)
       WHERE blob_objects.state IN ('ACTIVE','DELETED')`
  ).run(args.ownerKey, args.blobRef, args.kind, args.contentHash, args.sizeBytes ?? null);

  // 幂等：同一 (owner, ref, revision, kind) 只有一条
  db.prepare(
    `INSERT OR IGNORE INTO blob_refs(owner_key, blob_ref, node_id, revision_id, kind)
     VALUES(?,?,?,?,?)`
  ).run(args.ownerKey, args.blobRef, args.nodeId, args.revisionId, args.kind);

  return { ok: true };
}

/** 引用计数（行数即引用数） */
export function refCountFor(db: Db, ownerKey: string, blobRef: string): number {
  const r = db
    .prepare('SELECT COUNT(*) AS c FROM blob_refs WHERE owner_key=? AND blob_ref=?')
    .get(ownerKey, blobRef) as { c: number };
  return Number(r.c);
}

// ───────────────────── A-3 · 原子删除认领（契约 §4.1） ─────────────────────

export type ClaimResult =
  | { ok: true; seq: number; claimToken: string }
  | { ok: false; reason: 'HAS_REFS' | 'NOT_ACTIVE' };

export interface ClaimArgs {
  ownerKey: string;
  blobRef: string;
  kind: 'main' | 'archive';
  worker: string;
}

/**
 * 原子认领：`UPDATE … WHERE … AND NOT EXISTS(subquery)` 单语句完成
 * 「读引用数 + 改状态」，并把 `changes===1` 作为唯一成功判据。
 * 成功后**在同一事务内**插入 `claimed` 任务行。
 */
export function claimForDeletion(db: Db, c: ClaimArgs): ClaimResult {
  const res = db
    .prepare(
      `UPDATE blob_objects SET state='DELETING'
        WHERE owner_key=? AND blob_ref=? AND state='ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM blob_refs WHERE owner_key=? AND blob_ref=?
          )`
    )
    .run(c.ownerKey, c.blobRef, c.ownerKey, c.blobRef);

  if (Number(res.changes) !== 1) {
    // 二次查询只为区分错误原因，不参与判定（判定已由上面单条 SQL 完成）
    const row = db
      .prepare(
        `SELECT state,
                (SELECT COUNT(*) FROM blob_refs WHERE owner_key=? AND blob_ref=?) AS refs
           FROM blob_objects WHERE owner_key=? AND blob_ref=?`
      )
      .get(c.ownerKey, c.blobRef, c.ownerKey, c.blobRef) as
      | { state: string; refs: number }
      | undefined;
    if (row && Number(row.refs) > 0) return { ok: false, reason: 'HAS_REFS' };
    return { ok: false, reason: 'NOT_ACTIVE' };
  }

  const claimToken = `tok-${c.worker}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ins = db
    .prepare(
      `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status, claim_token,
        claimed_by, claimed_at, created_at, updated_at)
       VALUES(?,?,?, 'claimed', ?, ?, datetime('now'), datetime('now'), datetime('now'))`
    )
    .run(c.ownerKey, c.blobRef, c.kind, claimToken, c.worker);

  return { ok: true, seq: Number(ins.lastInsertRowid), claimToken };
}

// ───────────────── A-4 · 阶段一：Purge 逻辑删除（事务内） ─────────────────

export interface PlanPurgeArgs {
  ownerKey: string;
  nodeId: string;
  /** 该 node **全部** revision（含历史版本）的引用事实 */
  revisions: {
    revisionId: string;
    contentHash: string;
    contentRef: string | null;
    minimizedBlobRef: string | null;
  }[];
  /** 操作者身份（写 purge_ledger.operator，须为 auth.agentId） */
  operator: string;
  /** 擦除原因分类（写 purge_ledger.reason_category） */
  reason: string;
  /** 预留认领的 worker 身份；默认 PURGE_WORKER，阶段二用同一身份续跑 */
  worker?: string;
}

export interface PurgePlan {
  ownerKey: string;
  nodeId: string;
  operator: string;
  /** 认领成功、已入队待物理删除的 blob */
  scheduled: { ref: string; kind: 'main' | 'archive' }[];
  /** 因仍有其他引用而保留、未入队的 blob（契约 §5 必须在输出里体现） */
  retained: { ref: string; refCount: number }[];
}

/**
 * 阶段一（**必须在调用方事务内**）：
 *  1. 每个 revision 的 content_hash 写入 `purge_ledger`（operator = auth.agentId）
 *  2. 收集全部 revision 的 content_ref / minimized_blob_ref（去重）
 *  3. 删除该 node 的 `blob_refs`
 *  4. 逐个 `claimForDeletion()`：成功 → scheduled；HAS_REFS → retained（带 refCount）
 *  5. 删除节点行、两类边、sensitivity_overlay、outbox
 */
export function planPurge(db: Db, a: PlanPurgeArgs): PurgePlan {
  const worker = a.worker ?? PURGE_WORKER;

  // 1) Ledger 先行（持久化擦除意图；防复活拦截键 content_hash）
  const ledger = db.prepare(
    `INSERT INTO purge_ledger(node_id, content_hash, operator, reason_category) VALUES(?,?,?,?)`
  );
  for (const r of a.revisions) ledger.run(a.nodeId, r.contentHash, a.operator, a.reason);

  // 2) 候选 blob（ref → kind，去重）
  const candidates = new Map<string, 'main' | 'archive'>();
  for (const r of a.revisions) {
    if (r.contentRef) candidates.set(r.contentRef, 'main');
    if (r.minimizedBlobRef) candidates.set(r.minimizedBlobRef, 'archive');
  }

  // 3) 删引用（引用归零；其他 node 的引用不动）
  const delRef = db.prepare(
    'DELETE FROM blob_refs WHERE owner_key=? AND node_id=? AND revision_id=?'
  );
  for (const r of a.revisions) delRef.run(a.ownerKey, a.nodeId, r.revisionId);

  // 4) 原子认领
  const scheduled: PurgePlan['scheduled'] = [];
  const retained: PurgePlan['retained'] = [];
  for (const [ref, kind] of candidates) {
    const claim = claimForDeletion(db, { ownerKey: a.ownerKey, blobRef: ref, kind, worker });
    if (claim.ok) {
      scheduled.push({ ref, kind });
    } else {
      retained.push({ ref, refCount: refCountFor(db, a.ownerKey, ref) });
    }
  }

  // 5) 删节点 / 两类边 / 覆盖层 / outbox（逻辑删除提交点）
  db.prepare('DELETE FROM edges WHERE type <> ? AND ("from"=? OR "to"=?)').run(
    'supersedes',
    a.nodeId,
    a.nodeId
  );
  const delSuper = db.prepare('DELETE FROM edges WHERE type=? AND ("from"=? OR "to"=?)');
  for (const r of a.revisions) delSuper.run('supersedes', r.revisionId, r.revisionId);
  db.prepare('DELETE FROM sensitivity_overlay WHERE node_id=?').run(a.nodeId);
  db.prepare('DELETE FROM outbox WHERE entity_id=?').run(a.nodeId);
  db.prepare('DELETE FROM nodes WHERE node_id=?').run(a.nodeId);

  return { ownerKey: a.ownerKey, nodeId: a.nodeId, operator: a.operator, scheduled, retained };
}

// ───────────────── A-5 · 阶段二：物理清理（事务外） ─────────────────

export interface WorkerLike {
  unlinkIfExists?(ref: string): Promise<'removed' | 'absent'>;
  remove(ref: string): Promise<void>;
}

export interface RunCleanupResult {
  attempted: number;
  removed: number;
  failed: { seq: number; ref: string; error: string }[];
}

export interface CleanupOptions {
  limit?: number;
  batchKey?: string;
  worker?: string;
}

/**
 * 阶段二：领取任务 → unlink → 推进状态机（**必须在事务外**）。
 *
 *  领取范围：`pending` / `failed` / 超时未续的 `claimed`（>5 分钟）/
 *  本 worker 自己预留的 `claimed`（阶段一预留后立即续跑）。
 *  成功：`blob_objects` → DELETED + `deleted_at`；任务 → done（带 claim_token）。
 *  失败：任务 → failed、`retry_count+1`、写 `last_error`；对象**保持 DELETING**。
 */
export async function runCleanup(
  db: Db,
  blobs: WorkerLike,
  opts: CleanupOptions = {}
): Promise<RunCleanupResult> {
  const limit = opts.limit ?? 25;
  const worker = opts.worker ?? opts.batchKey ?? PURGE_WORKER;
  const claimToken = `run-${worker}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const tasks = db
    .prepare(
      `UPDATE blob_cleanup_tasks
          SET status='claimed', claim_token=?, claimed_by=?, claimed_at=datetime('now')
        WHERE seq IN (
          SELECT seq FROM blob_cleanup_tasks
           WHERE status IN ('pending','failed')
              OR (status='claimed'
                  AND (claimed_at IS NULL
                       OR claimed_at < datetime('now','-5 minutes')
                       OR claimed_by = ?))
           ORDER BY seq
           LIMIT ?
        )
        RETURNING seq, owner_key, blob_ref, kind`
    )
    .all(claimToken, worker, worker, limit) as {
    seq: number;
    owner_key: string;
    blob_ref: string;
    kind: 'main' | 'archive';
  }[];

  const result: RunCleanupResult = { attempted: tasks.length, removed: 0, failed: [] };

  for (const t of tasks) {
    try {
      if (blobs.unlinkIfExists) {
        // B 组实现：ENOENT → 'absent'（幂等成功），其余错误必须真实上报
        await blobs.unlinkIfExists(t.blob_ref);
      } else {
        await blobs.remove(t.blob_ref);
      }
      db.prepare(
        `UPDATE blob_objects SET state='DELETED', deleted_at=datetime('now')
          WHERE owner_key=? AND blob_ref=? AND state='DELETING'`
      ).run(t.owner_key, t.blob_ref);
      db.prepare(
        `UPDATE blob_cleanup_tasks SET status='done', updated_at=datetime('now')
          WHERE seq=? AND claim_token=?`
      ).run(t.seq, claimToken);
      result.removed += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.prepare(
        `UPDATE blob_cleanup_tasks
            SET status='failed', retry_count=retry_count+1, last_error=?,
                updated_at=datetime('now')
          WHERE seq=? AND claim_token=?`
      ).run(msg, t.seq, claimToken);
      result.failed.push({ seq: t.seq, ref: t.blob_ref, error: msg });
    }
  }

  return result;
}

/** 集成层便捷入口（语义同 runCleanup） */
export async function requestRunCleanup(
  db: Db,
  blobs: WorkerLike,
  opts: CleanupOptions = {}
): Promise<RunCleanupResult> {
  return runCleanup(db, blobs, opts);
}

// ───────────────── A-6 · 补偿（reconcile） ─────────────────

export interface ReconcileResult {
  /** 本次仍失败、需继续重试的任务数（契约 §5 cleanup.pendingRetry 的来源） */
  pendingRetry: number;
  filesRemoved: number;
  /** 开工前是否存在未完成任务（供 preflight/004 回滚判定参考） */
  hadPending: boolean;
}

/**
 * 补偿：重跑 `runCleanup()`（覆盖 pending/failed/超时 claimed），
 * 并额外清理 `status='done'` 的陈旧任务行。
 */
export async function reconcileBlobs(
  db: Db,
  blobs: WorkerLike,
  opts: CleanupOptions = {}
): Promise<ReconcileResult> {
  const before = db
    .prepare(
      `SELECT COUNT(*) AS c FROM blob_cleanup_tasks
        WHERE status IN ('pending','claimed','failed')`
    )
    .get() as { c: number };
  const hadPending = Number(before.c) > 0;

  const res = await runCleanup(db, blobs, opts);

  // 清理已完成的陈旧任务行（done 不再占用部分唯一索引）
  db.prepare(`DELETE FROM blob_cleanup_tasks WHERE status='done'`).run();

  return { pendingRetry: res.failed.length, filesRemoved: res.removed, hadPending };
}
