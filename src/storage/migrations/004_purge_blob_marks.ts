/** Migration 004（Review R3）：Purge 文件删除的持久化对账状态表
 *
 *  R3-01 修复：Purge 必须可靠清除本地 Blob，文件删除失败要保留可重试状态。
 *  `purge_blob_marks` 记录待物理删除的 blob 引用，由 reconcile 补偿。
 *
 *  R4（A-7）· Migration 004 Down 方案 A（契约 §9）：
 *  - down 前检查 blob_cleanup_tasks（005 已建表）是否存在 status IN
 *    ('pending','claimed','failed')。
 *  - 存在 → 抛 MIGRATION_ABORTED，列出未完成任务（最多 50 条），不执行 DROP。
 *  - 全部 done 或表不存在 → 才执行 DROP TABLE。
 *  - 004 比 005 早：004.down 执行时 005 的表可能已不存在 → 检查 sqlite_master，
 *    无该表则视为无阻塞。
 */
export const migration = {
  version: 4,
  name: 'purge-blob-marks',
  up: `
CREATE TABLE IF NOT EXISTS purge_blob_marks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  blob_ref TEXT NOT NULL,          -- 主区或归档区相对引用
  kind TEXT NOT NULL CHECK (kind IN ('main','archive')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  operator TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purge_marks_pending ON purge_blob_marks(node_id) WHERE status='pending';
`,
  down: (db: any) => {
    // ── R4 §9 方案 A：未完成清理任务 → 拒绝回滚 ──
    const cleanupExists = !!db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='blob_cleanup_tasks'"
      )
      .get();
    if (cleanupExists) {
      const pending = db
        .prepare(
          `SELECT seq, owner_key, blob_ref, status FROM blob_cleanup_tasks
            WHERE status IN ('pending','claimed','failed')
            ORDER BY seq
            LIMIT 50`
        )
        .all() as { seq: number; owner_key: string; blob_ref: string; status: string }[];
      if (pending.length > 0) {
        const lines = pending
          .map((t) => `  [${t.status}] ${t.owner_key} ${t.blob_ref} (seq=${t.seq})`)
          .join('\n');
        throw new Error(
          `MIGRATION_ABORTED: 存在 ${pending.length} 个未完成的 Blob 清理任务，拒绝回滚 Migration 004。\n` +
            `未完成任务：\n${lines}\n` +
            `请先运行 reconcileBlobs() 完成物理清理后再重试回滚。`
        );
      }
    }
    // 全部 done（或在 004.down 时 005 未建表）→ 执行 DROP
    db.exec('DROP TABLE IF EXISTS purge_blob_marks;');
  },
};
