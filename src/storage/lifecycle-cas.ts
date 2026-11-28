/** lifecycle-cas.ts —— C 组独占：Minimize / Revive 最终 CAS 纯函数（R4，P0）。
 *
 *  契约（docs/R4-CONTRACTS.md §6）：
 *  - Minimize 最终 UPDATE 必须带 CAS 条件 revision_id + version_state='CURRENT' + content_state='FULL'
 *  - Revive   最终 UPDATE 必须带 CAS 条件 revision_id + version_state='CURRENT' + content_state='MINIMIZED'
 *             + minimized_blob_ref + minimized_blob_hash（缺一不可）
 *  - changes !== 1  绝不得报告成功，必须返回 STATE_CONFLICT
 *
 *  这些函数是**纯函数**：只产出 SQL 与参数，由 Lead 接入 sqlite-provider.ts。
 *  Lead 在最终事务内执行 spec.sql + spec.params 后调用 assertSingleRow(stmt.run(...).changes)。
 *  本模块不触碰 provider；跨连接并发一致性由「条件 UPDATE + changes 校验」共同保证。
 */
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
 * C-3 · 单行断言。changes===1 → 成功；否则 STATE_CONFLICT。
 * 绝不在实际未更新（0 行 / 多行异常）时报告成功。
 */
export const assertSingleRow = (
  changes: number
): { ok: true } | { ok: false; error: 'STATE_CONFLICT' } =>
  typeof changes === 'number' && changes === 1 ? { ok: true } : { ok: false, error: 'STATE_CONFLICT' };

/**
 * C-4 · 失败孤儿文件登记：把「DB 提交失败后已写入磁盘、但未被引用」的归档文件
 * 登记进 blob_cleanup_tasks 队列（契约 §3 ③），由 A 组 cleanup worker 补偿删除。
 *
 * 幂等：使用 INSERT OR IGNORE —— 若该 (owner_key, blob_ref) 已存在 pending/claimed/failed 任务
 * （partial unique index idx_cleanup_active），则忽略，不产生重复任务。
 *
 * @param db    DatabaseSync 或兼容 prepare/run 的连接。写走调用方事务。
 * @param args  ownerKey：ownerKeyFor('owner') 的摘要；blobRef：孤儿归档相对引用；kind：'archive'
 * @returns     ok 恒为 true（失败由下层抛错向上传播，绝不由本函数吞掉）；
 *              enqueued=true 表示本次新插入任务，false 表示已存在同类任务（幂等跳过）。
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
