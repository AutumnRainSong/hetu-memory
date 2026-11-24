/** Migration 002（修订版 2）：Scope 持久化 + RevisionId 分离 + 旧数据迁移与校验
 *  按《M1-A 数据模型修订任务书》任务 A-F 重写：
 *  - 旧数据 Scope 回填：无法安全推断 owner → 迁移明确失败并列出待处理记录
 *  - superseded_by（旧 NodeId 语义）→ superseded_by_revision（RevisionId 语义）：显式检测，歧义即中止
 *  - 必需字段非空约束 + shared_with JSON 合法性校验
 *  - Down 脚本按真实触发器名删除
 *  - NULL 安全的不可变触发器（IS NOT），字段级不变量明确
 */
export const migration = {
  version: 2,
  name: 'scope-persistence-and-revision-separation',
  up: `
-- ============ 阶段 1：加列（允许 NULL，先加列后回填） ============
ALTER TABLE nodes ADD COLUMN owner_id TEXT;
ALTER TABLE nodes ADD COLUMN layer TEXT;
ALTER TABLE nodes ADD COLUMN project_id TEXT;
ALTER TABLE nodes ADD COLUMN agent_id TEXT;
ALTER TABLE nodes ADD COLUMN visibility TEXT;
ALTER TABLE nodes ADD COLUMN shared_with TEXT NOT NULL DEFAULT '[]';
ALTER TABLE nodes ADD COLUMN superseded_by_revision TEXT;

-- ============ 阶段 2：旧数据回填与校验 ============

-- 2a. shared_with JSON 合法性校验：非合法 JSON 数组 → 迁移失败
CREATE TRIGGER trg_m002_sharedwith_validate
BEFORE UPDATE ON nodes
WHEN json_valid(NEW.shared_with)=0 OR json_type(NEW.shared_with)!='array'
BEGIN
  SELECT RAISE(ABORT, 'MIGRATION_FAIL: shared_with is not a valid JSON array — manual fix required before re-running migration 002');
END;

-- 2b. superseded_by 历史数据迁移（旧列语义混用检测）：
--     旧值与同 node_id 的某 revision_id 匹配 → 迁入 superseded_by_revision
UPDATE nodes SET superseded_by_revision = superseded_by
WHERE superseded_by IS NOT NULL
  AND EXISTS (SELECT 1 FROM nodes AS other
              WHERE other.node_id = nodes.node_id
                AND other.revision_id = nodes.superseded_by);

-- 残留检测：仍有 superseded_by 非 NULL 但 superseded_by_revision 为 NULL 的行
-- （NodeId 歧义 / 悬空引用）→ 触发迁移失败，列出待处理记录
CREATE TRIGGER trg_m002_superseded_leftover
BEFORE UPDATE ON nodes
WHEN EXISTS (
  SELECT 1 FROM nodes AS n
  WHERE n.superseded_by IS NOT NULL AND n.superseded_by_revision IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'MIGRATION_FAIL: unresolved legacy superseded_by values detected — inspect: SELECT node_id,revision_id,superseded_by FROM nodes WHERE superseded_by IS NOT NULL AND superseded_by_revision IS NULL');
END;

-- Scope 回填（MVP 单用户基线：owner_id='default'；layer=project；visibility=project_agents）
-- 无法推断 owner 的记录 → 由 trg_m002_scope_backfill_check 拦截并要求人工处理
CREATE TRIGGER trg_m002_scope_backfill_check
BEFORE UPDATE ON nodes
WHEN EXISTS (
  SELECT 1 FROM nodes AS n
  WHERE n.owner_id IS NULL OR n.layer IS NULL OR n.visibility IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'MIGRATION_FAIL: nodes with NULL owner_id/layer/visibility detected — backfill scope explicitly before re-running migration 002. Inspect: SELECT node_id,revision_id FROM nodes WHERE owner_id IS NULL');
END;

UPDATE nodes SET owner_id='default', layer='project', visibility='project_agents'
WHERE owner_id IS NULL;
UPDATE nodes SET project_id='default-project' WHERE layer='project' AND project_id IS NULL;
-- agent_id：无法从旧数据推断 → 保持 NULL（Global/Project 层允许 NULL）

-- ============ 阶段 3：约束固化（回填完成后） ============

CREATE TRIGGER trg_nodes_scope_required_ins
BEFORE INSERT ON nodes
WHEN NEW.owner_id IS NULL OR NEW.layer IS NULL OR NEW.visibility IS NULL
  OR (NEW.layer='project' AND NEW.project_id IS NULL)
  OR (NEW.layer IN ('agent_persona','private_annotation') AND NEW.agent_id IS NULL)
  OR (NEW.layer='private_annotation' AND NEW.visibility!='owner')
  OR json_valid(NEW.shared_with)=0 OR json_type(NEW.shared_with)!='array'
BEGIN
  SELECT RAISE(ABORT, 'SCOPE_INVALID: scope fields violate the node-level scope contract');
END;

CREATE TRIGGER trg_nodes_scope_required_upd
BEFORE UPDATE ON nodes
WHEN NEW.owner_id IS NULL OR NEW.layer IS NULL OR NEW.visibility IS NULL
  OR (NEW.layer='project' AND NEW.project_id IS NULL)
  OR (NEW.layer IN ('agent_persona','private_annotation') AND NEW.agent_id IS NULL)
  OR (NEW.layer='private_annotation' AND NEW.visibility!='owner')
  OR json_valid(NEW.shared_with)=0 OR json_type(NEW.shared_with)!='array'
BEGIN
  SELECT RAISE(ABORT, 'SCOPE_INVALID: scope fields violate the node-level scope contract');
END;

CREATE INDEX idx_nodes_owner ON nodes(owner_id);
CREATE INDEX idx_nodes_layer_project ON nodes(layer, project_id);
CREATE INDEX idx_nodes_agent ON nodes(agent_id);
CREATE INDEX idx_nodes_visibility ON nodes(visibility);

-- RevisionId 分离：引用完整性（INSERT + UPDATE 双触发器）
CREATE TRIGGER trg_supersede_revision_valid_ins
BEFORE INSERT ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM nodes
   WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: superseded_by_revision must reference an existing revision of the same logical memory');
END;

CREATE TRIGGER trg_supersede_revision_valid_upd
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM nodes
   WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: superseded_by_revision must reference an existing revision of the same logical memory');
END;

-- (node_id, revision_sequence) 唯一
CREATE UNIQUE INDEX idx_nodes_revseq ON nodes(node_id, revision_sequence);

-- 保留 001 的 CURRENT 部分唯一索引（每 node_id 恰一 CURRENT，链尾唯一性存储层强制）

-- ============ 阶段 4：不可变触发器（NULL 安全 + 字段级不变量） ============
-- 不可变内容字段：content_hash / content_ref / ingested_at / provenance
-- 生命周期元数据（允许随状态迁移变化）：content_state / stub_summary /
--   minimized_blob_ref / minimized_blob_hash / superseded_by_revision
CREATE TRIGGER trg_nodes_immutable_content
BEFORE UPDATE ON nodes
WHEN NEW.content_state != 'TOMBSTONE'
 AND (NEW.content_hash IS NOT OLD.content_hash
   OR NEW.content_ref IS NOT OLD.content_ref
   OR NEW.ingested_at IS NOT OLD.ingested_at
   OR NEW.provenance IS NOT OLD.provenance)
BEGIN
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: immutable content/provenance fields cannot be modified — create a new revision instead');
END;
`,
  down: `
-- Down：按真实触发器名逆序删除（任务 C 修复）
DROP TRIGGER IF EXISTS trg_nodes_immutable_content;
DROP TRIGGER IF EXISTS trg_supersede_revision_valid_upd;
DROP TRIGGER IF EXISTS trg_supersede_revision_valid_ins;
DROP TRIGGER IF EXISTS trg_nodes_scope_required_upd;
DROP TRIGGER IF EXISTS trg_nodes_scope_required_ins;
DROP TRIGGER IF EXISTS trg_m002_scope_backfill_check;
DROP TRIGGER IF EXISTS trg_m002_superseded_leftover;
DROP TRIGGER IF EXISTS trg_m002_sharedwith_validate;
DROP INDEX IF EXISTS idx_nodes_revseq;
DROP INDEX IF EXISTS idx_nodes_visibility;
DROP INDEX IF EXISTS idx_nodes_agent;
DROP INDEX IF EXISTS idx_nodes_layer_project;
DROP INDEX IF EXISTS idx_nodes_owner;
-- 先删触发器（引用 superseded_by_revision），再删列
ALTER TABLE nodes DROP COLUMN superseded_by_revision;
ALTER TABLE nodes DROP COLUMN shared_with;
ALTER TABLE nodes DROP COLUMN visibility;
ALTER TABLE nodes DROP COLUMN agent_id;
ALTER TABLE nodes DROP COLUMN project_id;
ALTER TABLE nodes DROP COLUMN layer;
ALTER TABLE nodes DROP COLUMN owner_id;
`
};
