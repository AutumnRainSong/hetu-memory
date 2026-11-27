/** Migration 004（Review R3）：Purge 文件删除的持久化对账状态表
 *
 *  R3-01 修复：Purge 必须可靠清除本地 Blob，文件删除失败要保留可重试状态。
 *  `purge_blob_marks` 记录待物理删除的 blob 引用，由 reconcile 补偿。
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
CREATE INDEX idx_purge_marks_pending ON purge_blob_marks(node_id) WHERE status='pending';
`,
  down: `
DROP TABLE IF EXISTS purge_blob_marks;
`,
};