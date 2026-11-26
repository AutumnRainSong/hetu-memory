/** Migration 003（Review R1）：Agent Persona 私有可见性 + 边引用完整性 + 边语义约束
 *
 *  修复 Review R1 指出的数据库层约束缺失：
 *  - P0-A：`agent_persona` 强制 `visibility='owner'`（人格记忆不能被其他 Agent 读取）
 *  - P1-E：普通边端点必须是已存在的 node_id；supersedes 边端点必须是已存在的 revision_id
 *  - P1-E：边重复写入不得 `INSERT OR REPLACE` 静默覆盖（改为拒绝或更新同一语义）
 *
 *  作法：重建 nodes 表追加 CHECK；为 edges 增加触发器（SQLite 无法对已有表加 FK）。
 */
export const migration = {
  version: 3,
  name: 'agent-persona-private-and-edge-integrity',
  up: `
-- ============ 1. agent_persona 私有可见性（P0-A） ============
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

  /* 层与字段关系 */
  CHECK (layer <> 'project' OR project_id IS NOT NULL),
  CHECK (layer NOT IN ('agent_persona','private_annotation') OR agent_id IS NOT NULL),
  /* 私有可见性：persona 与 annotation 都必须 owner-only（P0-A 核心约束） */
  CHECK (layer NOT IN ('agent_persona','private_annotation') OR visibility = 'owner')
);

INSERT INTO nodes_rev5 SELECT
  node_id, revision_id, revision_sequence, content_hash, version_state, content_state,
  content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash, modality, confidence,
  provenance, valid_from, valid_until, ingested_at, superseded_by, superseded_by_revision,
  owner_id, layer, project_id, agent_id,
  /* 历史数据里若 persona 不是 owner，强制收敛为 owner（私有性不可协商） */
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

/* 不可变内容触发器（NULL 安全） */
CREATE TRIGGER trg_nodes_immutable_content
BEFORE UPDATE ON nodes
WHEN NEW.content_hash IS NOT OLD.content_hash
  OR NEW.content_ref IS NOT OLD.content_ref
  OR NEW.ingested_at IS NOT OLD.ingested_at
  OR NEW.provenance IS NOT OLD.provenance
BEGIN
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: immutable content/provenance fields cannot be modified — create a new revision instead');
END;

/* 私有层可见性不可放松（防 UPDATE 绕过） */
CREATE TRIGGER trg_nodes_persona_private_upd
BEFORE UPDATE OF visibility, layer ON nodes
WHEN (NEW.layer IN ('agent_persona','private_annotation') AND NEW.visibility <> 'owner')
BEGIN
  SELECT RAISE(ABORT, 'PERMISSION_DENIED: agent_persona / private_annotation must stay owner-only');
END;

/* 生命周期元数据守卫 */
CREATE TRIGGER trg_nodes_lifecycle_meta_guard
BEFORE UPDATE ON nodes
WHEN (NEW.minimized_blob_ref IS NOT NULL OR NEW.minimized_blob_hash IS NOT NULL)
 AND NEW.content_state NOT IN ('MINIMIZED')
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: minimized_* fields are only valid while content_state=MINIMIZED');
END;

/* 废弃列只读 */
CREATE TRIGGER trg_nodes_legacy_superseded_by_readonly
BEFORE UPDATE OF superseded_by ON nodes
WHEN NEW.superseded_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MEM_DEPRECATED_FIELD: superseded_by is deprecated — use superseded_by_revision');
END;

/* Revision 引用完整性 + 自引用 + 环 */
CREATE TRIGGER trg_supersede_revision_valid_ins
BEFORE INSERT ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM nodes WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: superseded_by_revision must reference an existing revision of the same logical memory');
END;

CREATE TRIGGER trg_supersede_revision_valid_upd
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM nodes WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
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

-- ============ 2. 边引用完整性（P1-E） ============
/* 普通边：from/to 必须是已存在的 node_id */
CREATE TRIGGER trg_edges_node_ref_ins
BEFORE INSERT ON edges
WHEN NEW.type <> 'supersedes'
 AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW."from")
   OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = NEW."to"))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: edge endpoints must reference existing node_id');
END;

/* supersedes 边：from/to 必须是已存在的 revision_id */
CREATE TRIGGER trg_edges_revision_ref_ins
BEFORE INSERT ON edges
WHEN NEW.type = 'supersedes'
 AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = NEW."from")
   OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = NEW."to"))
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersedes edge endpoints must reference existing revision_id');
END;

/* 边重复写入不得静默覆盖（PK 冲突即拒绝，调用方须显式处理） */
CREATE TRIGGER trg_edges_no_silent_replace
BEFORE INSERT ON edges
WHEN EXISTS (SELECT 1 FROM edges
             WHERE type = NEW.type AND "from" = NEW."from" AND "to" = NEW."to")
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: edge already exists — use explicit update instead of silent replace');
END;

/* 清理历史遗留的悬空边（Migration 前已存在的无效边） */
DELETE FROM edges
WHERE type <> 'supersedes'
  AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."from")
    OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."to"));

DELETE FROM edges
WHERE type = 'supersedes'
  AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."from")
    OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."to"));
`,
  down: `
DROP TRIGGER IF EXISTS trg_edges_no_silent_replace;
DROP TRIGGER IF EXISTS trg_edges_revision_ref_ins;
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

/* 还原为 002 的 CHECK（放开 persona 私有约束） */
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
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: immutable content/provenance fields cannot be modified — create a new revision instead');
END;

CREATE TRIGGER trg_nodes_lifecycle_meta_guard
BEFORE UPDATE ON nodes
WHEN (NEW.minimized_blob_ref IS NOT NULL OR NEW.minimized_blob_hash IS NOT NULL)
 AND NEW.content_state NOT IN ('MINIMIZED')
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: minimized_* fields are only valid while content_state=MINIMIZED');
END;

CREATE TRIGGER trg_nodes_legacy_superseded_by_readonly
BEFORE UPDATE OF superseded_by ON nodes
WHEN NEW.superseded_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MEM_DEPRECATED_FIELD: superseded_by is deprecated — use superseded_by_revision');
END;

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
`
};
