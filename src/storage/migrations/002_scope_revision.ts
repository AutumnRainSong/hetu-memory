/** Migration 002：Scope 持久化 + NodeId/RevisionId 分离（M1-A，主规格 v1.4）
 *  按《第一版代码审查结论》任务 1/2/3：
 *  - nodes 表补 scope 六字段（含 shared_with JSON + 索引）
 *  - superseded_by 从 NodeId 改为指向 RevisionId（新增列 superseded_by_revision，旧列废弃保留）
 *  - 约束：NodeId+RevisionSequence 唯一 / CURRENT 唯一（已有）/ 不可变节点禁改 content（触发器）
 *  - Scope 查询索引：owner_id / layer+project_id / agent_id / visibility
 */
export const migration = {
  version: 2,
  name: 'scope-persistence-and-revision-separation',
  up: `
-- 1) Scope 六字段进入 nodes 表（owner 索引为权限过滤做准备）
ALTER TABLE nodes ADD COLUMN owner_id TEXT;
ALTER TABLE nodes ADD COLUMN layer TEXT CHECK (layer IN
  ('user_identity','agent_persona','global','project','private_annotation'));
ALTER TABLE nodes ADD COLUMN project_id TEXT;
ALTER TABLE nodes ADD COLUMN agent_id TEXT;
ALTER TABLE nodes ADD COLUMN visibility TEXT CHECK (visibility IN
  ('owner','project_agents','all_agents','shared_list'));
ALTER TABLE nodes ADD COLUMN shared_with TEXT NOT NULL DEFAULT '[]'; -- JSON 数组

CREATE INDEX idx_nodes_owner ON nodes(owner_id);
CREATE INDEX idx_nodes_layer_project ON nodes(layer, project_id);
CREATE INDEX idx_nodes_agent ON nodes(agent_id);
CREATE INDEX idx_nodes_visibility ON nodes(visibility);

-- 2) RevisionId 分离：新增 superseded_by_revision 列（指向具体 revision_id）
ALTER TABLE nodes ADD COLUMN superseded_by_revision TEXT;

-- 3) 不可变性约束（触发器）：CURRENT 节点禁止修改内容与状态
CREATE TRIGGER trg_nodes_immutable_content
BEFORE UPDATE ON nodes
WHEN OLD.content_state != 'TOMBSTONE'
 AND (NEW.content_hash != OLD.content_hash
   OR NEW.content_ref != OLD.content_ref
   OR NEW.ingested_at != OLD.ingested_at)
BEGIN
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: content fields cannot be modified, create a new revision instead');
END;

-- 4) Revision 链完整性：superseded_by_revision 必须指向同 node_id 的已存在 revision
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

-- 5) (node_id, revision_sequence) 唯一（防双写同一序号）
CREATE UNIQUE INDEX idx_nodes_revseq ON nodes(node_id, revision_sequence);

-- 6) 保留 001 的 CURRENT 部分唯一索引语义（每 node_id 同一时刻恰一个 CURRENT）——
--    它与"多 revision 链"模型不冲突：链上只有链尾是 CURRENT。此索引是链尾唯一性的
--    存储层强制（应用层 CAS 之外的最后一道防线）。001 已创建，此处无需变更。
`,
  down: `
DROP TRIGGER IF EXISTS trg_supersede_revision_valid;
DROP TRIGGER IF EXISTS trg_nodes_immutable_content;
DROP INDEX IF EXISTS idx_nodes_revseq;
DROP INDEX IF EXISTS idx_nodes_visibility;
DROP INDEX IF EXISTS idx_nodes_agent;
DROP INDEX IF EXISTS idx_nodes_layer_project;
DROP INDEX IF EXISTS idx_nodes_owner;
-- SQLite 3.35+ 支持 DROP COLUMN；旧版本需重建表，此处按 Node 22 捆绑的 3.45+ 执行
ALTER TABLE nodes DROP COLUMN superseded_by_revision;
ALTER TABLE nodes DROP COLUMN shared_with;
ALTER TABLE nodes DROP COLUMN visibility;
ALTER TABLE nodes DROP COLUMN agent_id;
ALTER TABLE nodes DROP COLUMN project_id;
ALTER TABLE nodes DROP COLUMN layer;
ALTER TABLE nodes DROP COLUMN owner_id;
`
};
