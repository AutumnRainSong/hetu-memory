/** lifecycle-cas.ts —— C 组独占：Minimize / Revive 最终 CAS 纯函数（R4，P0）。
 *
 *  契约（docs/R4-CONTRACTS.md §6）：
 *  - Minimize 最终 UPDATE 必须带 CAS 条件 revision_id + version_state='CURRENT' + content_state='FULL'
 *  - Revive   最终 UPDATE 必须带 CAS 条件 revision_id + version_state='CURRENT' + content_state='MINIMIZED'
 *             + minimized_blob_ref + minimized_blob_hash（缺一不可）
 *  - changes !== 1  绝不得报告成功，必须返回 STATE_CONFLICT
 *
 *  本模块为 C 组独占纯函数；由 Lead 接入 sqlite-provider.ts。
 *
 *  R4-INTEGRATION（Lead 修复）：
 *  - Minimize 在写入归档文件后，**必须先对该 owner namespace 登记 archive 引用**
 *    （registerBlobRef，确保 blob_objects 处于 ACTIVE），否则 purge 的原子认领
 *    找不到该对象 → claim 返回 NOT_ACTIVE → 归档文件永不物理删除（泄漏）。
 *  - 本文件额外导出 `registerArchiveForMinimize` 供 Lead 在 minimize 事务内调用。
 */
import type { Db } from './blob-lifecycle.ts';
import { registerBlobRef } from './blob-lifecycle.ts';

export interface CasUpdateSpec {
  sql: string;
  params: unknown[];
}

/**
 * C-1 · Minimize 最终 CAS UPDATE。
 * 命中且仅当：该 revision 仍是 CURRENT 且仍是 FULL。此时把状态翻转为 MINIMIZED。
 * stub_summary 用 COALESCE 保留已有摘要；归档引用/哈希由调用方在文件 I/O 成功后提供。
 */
export const buildMinimizeUpdate = (args: {
  revisionId: string;
  archiveRef: string;
  archiveHash: string;
  stubSummary: string;
}): CasUpdateSpec => ({
  sql: `UPDATE nodes
SET content_state='MINIMIZED',
    stub_summary=COALESCE(stub_summary, ?),
    minimized_blob_ref=?,
    minimized_blob_hash=?
WHERE revision_id=? AND version_state='CURRENT' AND content_state='FULL'`,
  params: [args.stubSummary, args.archiveRef, args.archiveHash, args.revisionId],
});

/**
 * C-2 · Revive 最终 CAS UPDATE。
 * 命中且仅当：该 revision 仍是 CURRENT、仍是 MINIMIZED，且归档引用/哈希与调用方读到的完全一致
 * （防止归档被 Purge/替换后仍复活）。成功后清空 minimized_* 字段、恢复主区引用。
 */
export const buildReviveUpdate = (args: {
  revisionId: string;
  expectedRef: string;
  expectedHash: string;
  mainRef: string;
}): CasUpdateSpec => ({
  sql: `UPDATE nodes
SET content_state='FULL',
    content_ref=COALESCE(content_ref, ?),
    minimized_blob_ref=NULL,
    minimized_blob_hash=NULL
WHERE revision_id=? AND version_state='CURRENT' AND content_state='MINIMIZED'
  AND minimized_blob_ref=? AND minimized_blob_hash=?`,
  params: [args.mainRef, args.revisionId, args.expectedRef, args.expectedHash],
});

/**
 * C-3 · 断言恰好命中一行；否则返回 STATE_CONFLICT（绝不在实际未更新时报告成功）。
 */
export const assertSingleRow = (
  changes: number | bigint
): { ok: true } | { ok: false; error: 'STATE_CONFLICT' } =>
  Number(changes) === 1 ? { ok: true } : { ok: false, error: 'STATE_CONFLICT' };

/**
 * C-4 · 失败孤儿文件登记：把「DB 提交失败后已写入磁盘、但未被引用」的归档文件
 * 登记进 blob_cleanup_tasks 队列，由 A 组 cleanup worker 补偿删除。（幂等）
 */
export const recordOrphanForCleanup = (
  db: { prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint } } },
  args: { ownerKey: string; blobRef: string; kind: 'main' | 'archive' }
): { ok: true; enqueued: boolean } => {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status)
       VALUES(?, ?, ?, 'pending')`
    )
    .run(args.ownerKey, args.blobRef, args.kind);
  return { ok: true, enqueued: Number(res.changes) === 1 };
};

/**
 * Minimize 补登记（Lead 集成）：
 * 把新写入的 archive 对象登记为 ACTIVE + 一条引用；主区 blob 在 put 时已登记。
 * 若不登记，purge 原子认领找不到该 archive 对象 → 永久泄漏。
 */
export const registerArchiveForMinimize = (
  db: Db,
  args: {
    ownerKey: string;
    archiveRef: string;
    archiveHash: string;
    nodeId: string;
    revisionId: string;
  }
)
: { ok: boolean; error?: 'BLOB_BUSY' } => {
  const res = registerBlobRef(db, {
    ownerKey: args.ownerKey,
    blobRef: args.archiveRef,
    nodeId: args.nodeId,
    revisionId: args.revisionId,
    kind: 'archive',
    contentHash: args.archiveHash,
  });
  return res.ok ? { ok: true } : { ok: false, error: 'BLOB_BUSY' };
};