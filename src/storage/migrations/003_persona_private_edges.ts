/** Migration 003（Review R2 修订）：Persona 私有可见性 + 边完整语义
 *
 *  R2 修复要点：
 *  - P1-E：**禁止静默删除历史边**。迁移前统计悬空边，存在即中止并列出清单
 *  - P1-E：persona/annotation 可见性收紧改为**自动修复 + 审计记录**（写入 migration_reports）
 *  - P1-F：边触发器补充 UPDATE 引用完整性；supersedes 增加同 node_id + 序号方向约束
 */

const UP_SQL = `
-- ============ 1. 重建 nodes 表：persona/annotation 强制 owner-only ============
CREATE TABLE nodes_rev5 (
  node_id TEXT NOT NULL,
  revision_id TEXT PRIMARY KEY,
  revision_sequence INTEGER NOT NULL CHECK (revision_sequence >= 1),
  content_hash TEXT NOT NULL,
  version_state TEXT NOT NULL CHECK (version_state IN ('CURRENT','SUPERSEDED')),
  content_state TEXT NOT NULL CHECK (content_state IN ('FULL','MINIMIZED','STUB','TOMBSTONE')),
  content_ref TEXT,
  stub_summary TEXT,
  minimized_blob_ref TEXT,
  minimized_blob_hash TEXT,
  modality TEXT NOT NULL DEFAULT 'text',
  confidence REAL NOT NULL DEFAULT 0.6,
  provenance TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  ingested_at TEXT NOT NULL,
  superseded_by TEXT,
  superseded_by_revision TEXT,

  owner_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN
    ('user_identity','agent_persona','global','project','private_annotation')),
  project_id TEXT,
  agent_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN
    ('owner','project_agents','all_agents','shared_list')),
  shared_with TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(shared_with) AND json_type(shared_with)='array'),

  CHECK (layer <> 'project' OR project_id IS NOT NULL),
  CHECK (layer NOT IN ('agent_persona','private_annotation') OR agent_id IS NOT NULL),
  /* 私有可见性：persona 与 annotation 都只能 owner */
  CHECK (layer NOT IN ('agent_persona','private_annotation') OR visibility = 'owner'),
  /* MINIMIZED 必须同时具备归档引用与 Hash（P0-C9） */
  CHECK (content_state <> 'MINIMIZED'
         OR (minimized_blob_ref IS NOT NULL AND minimized_blob_hash IS NOT NULL))
);

INSERT INTO nodes_rev5 SELECT
  node_id, revision_id, revision_sequence, content_hash, version_state, content_state,
  content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash, modality, confidence,
  provenance, valid_from, valid_until, ingested_at, superseded_by, superseded_by_revision,
  owner_id, layer, project_id, agent_id,
  CASE WHEN layer IN ('agent_persona','private_annotation') THEN 'owner' ELSE visibility END,
  shared_with
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_rev5 RENAME TO nodes;

CREATE UNIQUE INDEX idx_nodes_current ON nodes(node_id) WHERE version_state='CURRENT';
CREATE INDEX idx_nodes_chain ON nodes(node_id, revision_sequence);
CREATE UNIQUE INDEX idx_nodes_revseq ON nodes(node_id, revision_sequence);
CREATE INDEX idx_nodes_owner ON nodes(owner_id);
CREATE INDEX idx_nodes_layer_project ON nodes(layer, project_id);
CREATE INDEX idx_nodes_agent ON nodes(agent_id);
CREATE INDEX idx_nodes_visibility ON nodes(visibility);

/* ---- 不可变内容（NULL 安全） ---- */
CREATE TRIGGER trg_nodes_immutable_content
BEFORE UPDATE ON nodes
WHEN NEW.content_hash IS NOT OLD.content_hash
  OR NEW.content_ref IS NOT OLD.content_ref
  OR NEW.ingested_at IS NOT OLD.ingested_at
  OR NEW.provenance IS NOT OLD.provenance
BEGIN
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: immutable content/provenance fields cannot be modified');
END;

/* ---- persona/annotation 可见性不可放松 ---- */
CREATE TRIGGER trg_nodes_persona_private_upd
BEFORE UPDATE OF visibility, layer ON nodes
WHEN (NEW.layer IN ('agent_persona','private_annotation') AND NEW.visibility <> 'owner')
BEGIN
  SELECT RAISE(ABORT, 'PERMISSION_DENIED: agent_persona / private_annotation must stay owner-only');
END;

/* ---- 生命周期元数据守卫 ---- */
CREATE TRIGGER trg_nodes_lifecycle_meta_guard
BEFORE UPDATE ON nodes
WHEN (NEW.minimized_blob_ref IS NOT NULL OR NEW.minimized_blob_hash IS NOT NULL)
 AND NEW.content_state NOT IN ('MINIMIZED')
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: minimized_* fields are only valid while content_state=MINIMIZED');
END;

/* ---- 废弃列只读 ---- */
CREATE TRIGGER trg_nodes_legacy_superseded_by_readonly
BEFORE UPDATE OF superseded_by ON nodes
WHEN NEW.superseded_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MEM_DEPRECATED_FIELD: superseded_by is deprecated — use superseded_by_revision');
END;

/* ---- Revision 引用完整性（INSERT + UPDATE） ---- */
CREATE TRIGGER trg_supersede_revision_valid_ins
BEFORE INSERT ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: superseded_by_revision must reference an existing revision of the same logical memory');
END;

CREATE TRIGGER trg_supersede_revision_valid_upd
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: superseded_by_revision must reference an existing revision of the same logical memory');
END;

CREATE TRIGGER trg_supersede_no_self_ref
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL AND NEW.superseded_by_revision = NEW.revision_id
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: a revision cannot supersede itself');
END;

CREATE TRIGGER trg_supersede_no_cycle
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND EXISTS (
   WITH RECURSIVE chain(rev) AS (
     SELECT NEW.superseded_by_revision
     UNION
     SELECT n.superseded_by_revision FROM nodes n JOIN chain c ON n.revision_id = c.rev
      WHERE n.superseded_by_revision IS NOT NULL
   )
   SELECT 1 FROM chain WHERE rev = NEW.revision_id)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersede chain would form a cycle');
END;

-- ============ 2. 边完整语义（P1-F） ============
/* 普通边：端点必须是已存在的 node_id（INSERT + UPDATE） */
CREATE TRIGGER trg_edges_node_ref_ins
BEFORE INSERT ON edges
WHEN NEW.type <> 'supersedes'
 AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW."from")
   OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW."to"))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: edge endpoints must reference existing node_id');
END;

CREATE TRIGGER trg_edges_node_ref_upd
BEFORE UPDATE ON edges
WHEN NEW.type <> 'supersedes'
 AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW."from")
   OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW."to"))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: edge endpoints must reference existing node_id');
END;

/* supersedes 边：端点必须是已存在的 revision_id，且同属一个 node_id、序号递减（INSERT + UPDATE） */
CREATE TRIGGER trg_edges_revision_ref_ins
BEFORE INSERT ON edges
WHEN NEW.type = 'supersedes'
 AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = NEW."from")
   OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = NEW."to"))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersedes edge endpoints must reference existing revision_id');
END;

CREATE TRIGGER trg_edges_revision_ref_upd
BEFORE UPDATE ON edges
WHEN NEW.type = 'supersedes'
 AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = NEW."from")
   OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = NEW."to"))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersedes edge endpoints must reference existing revision_id');
END;

CREATE TRIGGER trg_edges_supersedes_same_memory_ins
BEFORE INSERT ON edges
WHEN NEW.type = 'supersedes'
 AND EXISTS (
   SELECT 1 FROM nodes f, nodes t
   WHERE f.revision_id = NEW."from" AND t.revision_id = NEW."to"
     AND (f.node_id <> t.node_id
       OR f.revision_sequence <= t.revision_sequence))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersedes must link same logical memory with ascending sequence');
END;

CREATE TRIGGER trg_edges_supersedes_same_memory_upd
BEFORE UPDATE ON edges
WHEN NEW.type = 'supersedes'
 AND EXISTS (
   SELECT 1 FROM nodes f, nodes t
   WHERE f.revision_id = NEW."from" AND t.revision_id = NEW."to"
     AND (f.node_id <> t.node_id
       OR f.revision_sequence <= t.revision_sequence))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersedes must link same logical memory with ascending sequence');
END;

/* 边重复写入不得静默覆盖 */
CREATE TRIGGER trg_edges_no_silent_replace
BEFORE INSERT ON edges
WHEN EXISTS (SELECT 1 FROM edges WHERE type = NEW.type AND "from" = NEW."from" AND "to" = NEW."to")
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: edge already exists — use explicit update instead of silent replace');
END;
`;

const DOWN_SQL = `
DROP TRIGGER IF EXISTS trg_edges_no_silent_replace;
DROP TRIGGER IF EXISTS trg_edges_supersedes_same_memory_upd;
DROP TRIGGER IF EXISTS trg_edges_supersedes_same_memory_ins;
DROP TRIGGER IF EXISTS trg_edges_revision_ref_upd;
DROP TRIGGER IF EXISTS trg_edges_revision_ref_ins;
DROP TRIGGER IF EXISTS trg_edges_node_ref_upd;
DROP TRIGGER IF EXISTS trg_edges_node_ref_ins;
DROP TRIGGER IF EXISTS trg_supersede_no_cycle;
DROP TRIGGER IF EXISTS trg_supersede_no_self_ref;
DROP TRIGGER IF EXISTS trg_supersede_revision_valid_upd;
DROP TRIGGER IF EXISTS trg_supersede_revision_valid_ins;
DROP TRIGGER IF EXISTS trg_nodes_legacy_superseded_by_readonly;
DROP TRIGGER IF EXISTS trg_nodes_lifecycle_meta_guard;
DROP TRIGGER IF EXISTS trg_nodes_persona_private_upd;
DROP TRIGGER IF EXISTS trg_nodes_immutable_content;
DROP INDEX IF EXISTS idx_nodes_visibility;
DROP INDEX IF EXISTS idx_nodes_agent;
DROP INDEX IF EXISTS idx_nodes_layer_project;
DROP INDEX IF EXISTS idx_nodes_owner;
DROP INDEX IF EXISTS idx_nodes_revseq;
DROP INDEX IF EXISTS idx_nodes_chain;
DROP INDEX IF EXISTS idx_nodes_current;

CREATE TABLE nodes_rev4 (
  node_id TEXT NOT NULL,
  revision_id TEXT PRIMARY KEY,
  revision_sequence INTEGER NOT NULL CHECK (revision_sequence >= 1),
  content_hash TEXT NOT NULL,
  version_state TEXT NOT NULL CHECK (version_state IN ('CURRENT','SUPERSEDED')),
  content_state TEXT NOT NULL CHECK (content_state IN ('FULL','MINIMIZED','STUB','TOMBSTONE')),
  content_ref TEXT, stub_summary TEXT, minimized_blob_ref TEXT, minimized_blob_hash TEXT,
  modality TEXT NOT NULL DEFAULT 'text', confidence REAL NOT NULL DEFAULT 0.6,
  provenance TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, ingested_at TEXT NOT NULL,
  superseded_by TEXT, superseded_by_revision TEXT,
  owner_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN
    ('user_identity','agent_persona','global','project','private_annotation')),
  project_id TEXT, agent_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN
    ('owner','project_agents','all_agents','shared_list')),
  shared_with TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(shared_with) AND json_type(shared_with)='array'),
  CHECK (layer <> 'project' OR project_id IS NOT NULL),
  CHECK (layer NOT IN ('agent_persona','private_annotation') OR agent_id IS NOT NULL),
  CHECK (layer <> 'private_annotation' OR visibility = 'owner')
);
INSERT INTO nodes_rev4 SELECT * FROM nodes;
DROP TABLE nodes;
ALTER TABLE nodes_rev4 RENAME TO nodes;

CREATE UNIQUE INDEX idx_nodes_current ON nodes(node_id) WHERE version_state='CURRENT';
CREATE INDEX idx_nodes_chain ON nodes(node_id, revision_sequence);
CREATE UNIQUE INDEX idx_nodes_revseq ON nodes(node_id, revision_sequence);
CREATE INDEX idx_nodes_owner ON nodes(owner_id);
CREATE INDEX idx_nodes_layer_project ON nodes(layer, project_id);
CREATE INDEX idx_nodes_agent ON nodes(agent_id);
CREATE INDEX idx_nodes_visibility ON nodes(visibility);

CREATE TRIGGER trg_nodes_immutable_content
BEFORE UPDATE ON nodes
WHEN NEW.content_hash IS NOT OLD.content_hash
  OR NEW.content_ref IS NOT OLD.content_ref
  OR NEW.ingested_at IS NOT OLD.ingested_at
  OR NEW.provenance IS NOT OLD.provenance
BEGIN
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: immutable content/provenance fields cannot be modified');
END;

CREATE TRIGGER trg_nodes_lifecycle_meta_guard
BEFORE UPDATE ON nodes
WHEN (NEW.minimized_blob_ref IS NOT NULL OR NEW.minimized_blob_hash IS NOT NULL)
 AND NEW.content_state NOT IN ('MINIMIZED')
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: minimized_* fields are only valid while content_state=MINIMIZED');
END;
`;

export const migration = {
  version: 3,
  name: 'agent-persona-private-and-edge-integrity',
  up: (db: any) => {
    // ── P1-E：迁移前统计悬空边，存在即中止（禁止静默删除）──
    const danglingNormal = db
      .prepare(
        `SELECT type, "from", "to" FROM edges WHERE type <> 'supersedes'
         AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."from")
           OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."to"))`
      )
      .all() as { type: string; from: string; to: string }[];
    const danglingSupersedes = db
      .prepare(
        `SELECT type, "from", "to" FROM edges WHERE type = 'supersedes'
         AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."from")
           OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."to"))`
      )
      .all() as { type: string; from: string; to: string }[];

    const dangling = [...danglingNormal, ...danglingSupersedes];
    if (dangling.length) {
      throw new Error(
        [
          `MIGRATION_ABORTED: 检测到 ${dangling.length} 条悬空边（端点不存在）。`,
          '迁移不会静默删除历史数据。请先修复端点或显式删除后重跑。',
          '受影响记录：',
          ...dangling.slice(0, 50).map(e => `  ${e.type}: ${e.from} -> ${e.to}`),
        ].join('\n')
      );
    }

    // ── persona/annotation 可见性收紧：自动修复 + 写入审计报告 ──
    const widened = db
      .prepare(
        `SELECT node_id, revision_id, layer, visibility FROM nodes
         WHERE layer IN ('agent_persona','private_annotation') AND visibility <> 'owner'`
      )
      .all() as { node_id: string; revision_id: string; layer: string; visibility: string }[];

    db.exec(UP_SQL);

    db.exec(`CREATE TABLE IF NOT EXISTS migration_reports (
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);

    if (widened.length) {
      db.prepare('INSERT INTO migration_reports(version,kind,detail) VALUES(?,?,?)').run(
        3,
        'persona-visibility-tightened',
        JSON.stringify({ count: widened.length, records: widened })
      );
    }
  },
  down: (db: any) => {
    db.exec(DOWN_SQL);
  },
};
