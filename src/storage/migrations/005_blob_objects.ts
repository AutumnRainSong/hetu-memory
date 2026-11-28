/** Migration 005（R4）：Blob 对象 / 引用台账 / 清理任务队列
 *
 *  R4 契约 §3（A-1）。
 */
export const migration = {
  version: 5,
  name: 'blob-objects-and-cleanup',
  up: `
CREATE TABLE IF NOT EXISTS blob_objects (
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
CREATE INDEX IF NOT EXISTS idx_blob_objects_state ON blob_objects(state) WHERE state <> 'ACTIVE';

CREATE TABLE IF NOT EXISTS blob_refs (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key   TEXT NOT NULL,
  blob_ref    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('main','archive')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- 同一 revision 对同一 blob 的同一用途只能登记一次（防重复计数导致引用永不归零）
  UNIQUE (owner_key, blob_ref, revision_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_blob_refs_count ON blob_refs(owner_key, blob_ref);

CREATE TABLE IF NOT EXISTS blob_cleanup_tasks (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_active
  ON blob_cleanup_tasks(owner_key, blob_ref)
  WHERE status IN ('pending','claimed','failed');
CREATE INDEX IF NOT EXISTS idx_cleanup_pickup ON blob_cleanup_tasks(status, seq);
`,
  down: `
DROP INDEX IF EXISTS idx_cleanup_pickup;
DROP INDEX IF EXISTS idx_cleanup_active;
DROP TABLE IF EXISTS blob_cleanup_tasks;
DROP INDEX IF EXISTS idx_blob_refs_count;
DROP TABLE IF EXISTS blob_refs;
DROP INDEX IF EXISTS idx_blob_objects_state;
DROP TABLE IF EXISTS blob_objects;
`,
};
