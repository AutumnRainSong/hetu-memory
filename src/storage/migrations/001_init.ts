/** Migration 001：初始 Schema（主规格 v1.4 收敛定稿）
 *  每条 migration 必须可回放（幂等）：依赖 schema_migrations 表记录版本。
 */
export const migration = {
  version: 1,
  name: 'init',
  up: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 记忆节点（不可变；每行一个 revision）
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT NOT NULL,
  revision_id TEXT PRIMARY KEY,
  revision_sequence INTEGER NOT NULL,
  content_hash TEXT NOT NULL,            -- sha256:... 防复活拦截键
  version_state TEXT NOT NULL CHECK (version_state IN ('CURRENT','SUPERSEDED')),
  content_state TEXT NOT NULL CHECK (content_state IN ('FULL','MINIMIZED','STUB','TOMBSTONE')),
  content_ref TEXT,
  stub_summary TEXT,
  minimized_blob_ref TEXT,               -- 洛书包内相对路径
  minimized_blob_hash TEXT,
  modality TEXT NOT NULL DEFAULT 'text',
  confidence REAL NOT NULL DEFAULT 0.6,
  provenance TEXT NOT NULL,              -- JSON：agent_id/origin/method/source_refs/producer_version/model_id/generated_at/confidence
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  ingested_at TEXT NOT NULL,
  superseded_by TEXT                     -- NULL = 链尾（CURRENT）
);
CREATE UNIQUE INDEX idx_nodes_current ON nodes(node_id) WHERE version_state='CURRENT';
CREATE INDEX idx_nodes_chain ON nodes(node_id, revision_sequence);

-- sensitivity 覆盖层（可变；节点不可变，此表独立记审计）
CREATE TABLE IF NOT EXISTS sensitivity_overlay (
  node_id TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (value IN ('normal','sensitive','restricted')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  reason TEXT
);

-- 边
CREATE TABLE IF NOT EXISTS edges (
  type TEXT NOT NULL CHECK (type IN ('cooccur','supersedes','annotation','link')),
  link_class TEXT CHECK (link_class IN ('pinned','explicit','inferred') OR type != 'link'),
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  weight REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (type, "from", "to")
);

-- Outbox（与业务数据同事务写入；消费者按 (kind,entity_id,seq) 幂等）
CREATE TABLE IF NOT EXISTS outbox (
  kind TEXT NOT NULL CHECK (kind IN ('digest','index','gc')),
  entity_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  consumed_at TEXT,
  PRIMARY KEY (kind, entity_id, seq)
);

-- Purge Ledger（append-only；PURGED 的唯一承载，节点物理删除）
CREATE TABLE IF NOT EXISTS purge_ledger (
  purge_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,            -- 防复活拦截键
  operator TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  reason_category TEXT NOT NULL
);
CREATE INDEX idx_ledger_hash ON purge_ledger(content_hash);

-- RAW 层（结绳）
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_raw_session ON raw_events(session_id);

-- RAW GC 水位线（按 Session 分区；最小未完成 watermark 之前才可 GC）
CREATE TABLE IF NOT EXISTS digest_watermarks (
  session_id TEXT PRIMARY KEY,
  watermark INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`,
  down: `
DROP TABLE IF EXISTS digest_watermarks;
DROP TABLE IF EXISTS raw_events;
DROP TABLE IF EXISTS purge_ledger;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS sensitivity_overlay;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS schema_migrations;
`
};
