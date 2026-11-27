/** Migration 002（Rev3）：Scope 持久化 + RevisionId 分离 + 旧数据安全迁移
 *
 * 按《M1-A 数据模型修订任务书 Rev3》任务 A-F 实现：
 *  - 任务 A：旧节点 Scope 回填；无法安全推断 owner → 迁移明确中止并列出待处理记录
 *  - 任务 B：superseded_by 旧值（NodeId/RevisionId 混用）显式检测；歧义或悬空 → 中止并列出
 *  - 任务 C：Down 按真实触发器名删除；执行 Down 后 001 结构可用，可再次 Up
 *  - 任务 D：不可变触发器用 NULL 安全比较（IS NOT）；字段级不变量显式定义
 *  - 任务 E：id 语义分离（node_id = 逻辑身份，revision_id = 具体版本）
 *  - 任务 F：迁移层只负责引用完整性 / 序号唯一 / 自引用与环检测；
 *            完整 CAS（恰好一个 CURRENT、事务原子性）由 StorageTx 负责（T-B-02）
 *
 * 做法：重建 nodes 表以施加真实 NOT NULL / CHECK 约束（SQLite 无法 ALTER 加 NOT NULL）。
 * 旧数据在复制前完成校验，任一条无法安全转换即整体中止，不留半迁移状态。
 */

interface LegacyRow {
  node_id: string;
  revision_id: string;
  superseded_by: string | null;
}

/** 旧数据预校验：返回问题清单（空 = 可安全迁移） */
function inspectLegacy(db: any): {
  rows: LegacyRow[];
  ambiguous: string[];
  dangling: string[];
  nodeIdShaped: string[];
  cycles: string[];
} {
  const rows = db
    .prepare('SELECT node_id, revision_id, superseded_by FROM nodes WHERE superseded_by IS NOT NULL')
    .all() as LegacyRow[];
  const ambiguous: string[] = [];
  const dangling: string[] = [];
  const nodeIdShaped: string[] = [];

  for (const r of rows) {
    const asRevision = db
      .prepare('SELECT 1 FROM nodes WHERE node_id=? AND revision_id=?')
      .get(r.node_id, r.superseded_by as string);
    if (asRevision) continue; // 同 node_id 下确有该 revision → 可无歧义迁移
    const asNodeId = db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(r.superseded_by as string);
    if (asNodeId) {
      // 旧值实际是 NodeId（跨版本歧义）：无法判断它指向哪个 revision
      ambiguous.push(`${r.node_id}/${r.revision_id} -> superseded_by=${r.superseded_by}`);
      nodeIdShaped.push(r.superseded_by as string);
    } else {
      dangling.push(`${r.node_id}/${r.revision_id} -> superseded_by=${r.superseded_by}`);
    }
  }
  // 环检测（任务 A3）：沿旧 superseded_by 链遍历，回到起点即成环
  const cycles: string[] = [];
  const chainMap = new Map<string, string>();
  for (const r of db
    .prepare('SELECT revision_id, superseded_by FROM nodes WHERE superseded_by IS NOT NULL')
    .all() as { revision_id: string; superseded_by: string }[]) {
    chainMap.set(r.revision_id, r.superseded_by);
  }
  for (const start of chainMap.keys()) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur && chainMap.has(cur)) {
      if (seen.has(cur)) {
        cycles.push([...seen, cur].join(' -> '));
        break;
      }
      seen.add(cur);
      cur = chainMap.get(cur);
    }
  }

  return { rows, ambiguous, dangling, nodeIdShaped, cycles };
}

export interface LegacyScopeEntry {
  layer: 'user_identity' | 'agent_persona' | 'global' | 'project' | 'private_annotation';
  project_id?: string | null;
  agent_id?: string | null;
  visibility: 'owner' | 'project_agents' | 'all_agents' | 'shared_list';
  shared_with?: string[];
}

export const migration = {
  version: 2,
  name: 'scope-persistence-and-revision-separation',
  up: (
    db: any,
    opts: {
      legacyOwnerId?: string;
      /** Legacy Scope Mapping Manifest：node_id → 显式归属映射（任务 A2）。
       *  未提供时不得擅自推断旧记忆归属；仅当全部旧数据可由默认策略安全归类
       *  （即数据库为空，或调用方显式声明 acceptDefaultScopeMapping=true）时才继续。 */
      legacyScopeManifest?: Record<string, LegacyScopeEntry>;
      /** 显式声明接受默认映射（全部归入 project/default-project）。默认 false。 */
      acceptDefaultScopeMapping?: boolean;
      /** Dry run：只做校验与报告，不修改数据库。 */
      dryRun?: boolean;
    } = {}
  ) => {
    const legacy = inspectLegacy(db);

    // ── dryRun 已由 Runner 最外层拦截（P1-D）；此处为纵深防御 ──
    if (opts.dryRun) {
      const total = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
      const mapped = Object.keys(opts.legacyScopeManifest ?? {});
      const revIds = (
        db.prepare('SELECT revision_id FROM nodes').all() as { revision_id: string }[]
      ).map(r => r.revision_id);
      const unmapped = revIds.filter(id => !(id in (opts.legacyScopeManifest ?? {})));
      throw new Error(
        [
          'DRY_RUN_REPORT（未执行任何数据库写操作）',
          `总记录数：${total}`,
          `显式映射条数：${mapped.length}`,
          `未映射条数：${unmapped.length}${unmapped.length ? '（需提供 legacyScopeManifest 或 acceptDefaultScopeMapping）' : ''}`,
          `superseded_by 待转换：${legacy.rows.length}（歧义 ${legacy.ambiguous.length} / 悬空 ${legacy.dangling.length}）`,
          `历史环：${legacy.cycles.length}`,
          `旧 owner 提供：${opts.legacyOwnerId ? '是' : '否'}`,
          unmapped.length ? `待映射记录：\n  ${unmapped.slice(0, 20).join('\n  ')}` : '',
          '如需执行，请在不设置 dryRun 的情况下重新调用。',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    // ── 任务 A3：历史 Revision 环必须中止（不能依赖迁移后的 UPDATE 触发器）──
    if (legacy.cycles.length) {
      throw new Error(
        `MIGRATION_ABORTED: legacy supersede chain contains cycle(s):\n  ${legacy.cycles.join('\n  ')}\n` +
          `修复方式：人工断开环（将其中一条 superseded_by 置 NULL 或指向正确版本）后重跑迁移。`
      );
    }

    // ── 任务 B：歧义/悬空历史数据必须报告并中止，绝不静默丢弃或错误转换 ──
    if (legacy.ambiguous.length || legacy.dangling.length) {
      const detail = [
        legacy.ambiguous.length
          ? `[AMBIGUOUS] 旧 superseded_by 存的是 NodeId（无法确定具体 revision）：\n  ${legacy.ambiguous.join('\n  ')}`
          : '',
        legacy.dangling.length
          ? `[DANGLING] 旧 superseded_by 无法匹配任何同 node_id 的 revision_id：\n  ${legacy.dangling.join('\n  ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      throw new Error(
        `MIGRATION_ABORTED: migration 002 cannot safely convert legacy superseded_by values.\n${detail}\n` +
          `修复方式：人工确认每条记录应指向的 revision_id（或置 NULL），修正后重跑迁移。`
      );
    }

    const nodeCount = (
      db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }
    ).c;

    // ── 任务 A2：旧数据归属必须来自显式映射，不得默认全部塞进 project ──
    const manifest = opts.legacyScopeManifest ?? {};
    if (nodeCount > 0) {
      const revIds: string[] = (
        db.prepare('SELECT revision_id FROM nodes').all() as { revision_id: string }[]
      ).map(r => r.revision_id);
      const unmapped = revIds.filter(id => !(id in manifest));
      if (unmapped.length > 0 && !opts.acceptDefaultScopeMapping) {
        if (opts.dryRun) {
          // Dry run：只报告，不修改数据库
          throw new Error(
            `DRY_RUN_REPORT: 共 ${nodeCount} 条旧记忆，其中 ${unmapped.length} 条没有显式 Scope 映射。\n` +
              `未经映射不得写入共享空间。请提供 legacyScopeManifest（revision_id → {layer, visibility, ...}）\n` +
              `或显式传 acceptDefaultScopeMapping=true 表示同意全部归入 project/default-project。\n` +
              `待映射记录（最多 20 条）：\n  ${unmapped.slice(0, 20).join('\n  ')}`
          );
        }
        throw new Error(
          `MIGRATION_ABORTED: ${unmapped.length}/${nodeCount} 条旧记忆缺少显式 Scope 映射。\n` +
            `旧数据可能分属 user_identity / agent_persona / global / project / private_annotation，\n` +
            `不能因为迁移时缺少信息就一律归入默认项目。请提供 legacyScopeManifest，\n` +
            `或显式传 acceptDefaultScopeMapping=true。\n` +
            `待映射记录（最多 20 条）：\n  ${unmapped.slice(0, 20).join('\n  ')}`
        );
      }
    }

    if (nodeCount > 0 && !opts.legacyOwnerId) {
      const sample = db
        .prepare('SELECT node_id, revision_id FROM nodes LIMIT 20')
        .all() as { node_id: string; revision_id: string }[];
      throw new Error(
        `MIGRATION_ABORTED: 数据库已有 ${nodeCount} 条记忆记录，但未提供旧数据归属 owner。\n` +
          `迁移不会擅自把旧记忆归入某个用户。请显式提供 owner（MIGRATIONS 选项 legacyOwnerId / 环境变量 HETU_LEGACY_OWNER）。\n` +
          `待处理记录（最多 20 条）：\n  ${sample.map(r => r.revision_id).join('\n  ')}`
      );
    }
    const legacyOwner = opts.legacyOwnerId ?? null;

    // ── 重建表以施加真实 NOT NULL / CHECK 约束 ──
    db.exec(`
CREATE TABLE nodes_rev3 (
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

  /* 已被 superseded_by_revision 取代；保留列仅为兼容读取，禁止再写入 */
  superseded_by TEXT,
  superseded_by_revision TEXT,

  /* --- Scope（任务 A：必需字段真实 NOT NULL）--- */
  owner_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN
    ('user_identity','agent_persona','global','project','private_annotation')),
  project_id TEXT,
  agent_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN
    ('owner','project_agents','all_agents','shared_list')),
  shared_with TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(shared_with) AND json_type(shared_with)='array'),

  /* --- 字段约束关系（任务 A6）--- */
  CHECK (layer <> 'project' OR project_id IS NOT NULL),
  CHECK (layer NOT IN ('agent_persona','private_annotation') OR agent_id IS NOT NULL),
  CHECK (layer <> 'private_annotation' OR visibility = 'owner')
);
`);

    // 复制数据（旧行一律回填显式 owner；superseded_by 迁移为 RevisionId 语义）
    const rows = db
      .prepare(
        `SELECT node_id, revision_id, revision_sequence, content_hash, version_state,
                content_state, content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash,
                modality, confidence, provenance,
                valid_from, valid_until, ingested_at, superseded_by
         FROM nodes`
      )
      .all() as Record<string, any>[];

    const insert = db.prepare(
      `INSERT INTO nodes_rev3(node_id, revision_id, revision_sequence, content_hash, version_state,
        content_state, content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash,
        modality, confidence, provenance, valid_from, valid_until, ingested_at,
        superseded_by, superseded_by_revision,
        owner_id, layer, project_id, agent_id, visibility, shared_with)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`
    );
    for (const r of rows) {
      const mapped: LegacyScopeEntry | undefined = manifest[r.revision_id];
      const m: LegacyScopeEntry =
        mapped ??
        ({
          layer: 'project',
          project_id: 'default-project',
          agent_id: null,
          visibility: 'project_agents',
          shared_with: [],
        } as LegacyScopeEntry);
      insert.run(
        r.node_id,
        r.revision_id,
        r.revision_sequence,
        r.content_hash,
        r.version_state,
        r.content_state,
        r.content_ref ?? null,
        r.stub_summary ?? null,
        r.minimized_blob_ref ?? null,
        r.minimized_blob_hash ?? null,
        r.modality,
        r.confidence,
        r.provenance,
        r.valid_from,
        r.valid_until ?? null,
        r.ingested_at,
        r.superseded_by ?? null, // 已验证可无歧义转换 → 迁入新列
        legacyOwner ?? 'default',
        m.layer,
        m.project_id ?? null,
        m.agent_id ?? null,
        m.visibility,
        JSON.stringify(m.shared_with ?? [])
      );
    }

    db.exec('DROP TABLE nodes');
    db.exec('ALTER TABLE nodes_rev3 RENAME TO nodes');

    // ── 索引（含 001 的链尾唯一性索引，重建表后必须恢复）──
    db.exec(`
CREATE UNIQUE INDEX idx_nodes_current ON nodes(node_id) WHERE version_state='CURRENT';
CREATE INDEX idx_nodes_chain ON nodes(node_id, revision_sequence);
CREATE UNIQUE INDEX idx_nodes_revseq ON nodes(node_id, revision_sequence);
CREATE INDEX idx_nodes_owner ON nodes(owner_id);
CREATE INDEX idx_nodes_layer_project ON nodes(layer, project_id);
CREATE INDEX idx_nodes_agent ON nodes(agent_id);
CREATE INDEX idx_nodes_visibility ON nodes(visibility);
`);

    // ── 任务 D：不可变触发器（NULL 安全：IS NOT）+ 字段级不变量 ──
    // 不可变内容（创建后永不可改）：content_hash / content_ref / ingested_at / provenance
    //   —— content_ref 从 NULL↔非 NULL 的变更同样被拦截（旧版 `!=` 会被 NULL 绕过）
    // 生命周期元数据（允许随合法状态迁移变化）：content_state / stub_summary /
    //   minimized_blob_ref / minimized_blob_hash / superseded_by_revision
    db.exec(`
CREATE TRIGGER trg_nodes_immutable_content
BEFORE UPDATE ON nodes
WHEN NEW.content_hash IS NOT OLD.content_hash
  OR NEW.content_ref IS NOT OLD.content_ref
  OR NEW.ingested_at IS NOT OLD.ingested_at
  OR NEW.provenance IS NOT OLD.provenance
BEGIN
  SELECT RAISE(ABORT, 'MEM_IMMUTABLE: immutable content/provenance fields cannot be modified — create a new revision instead');
END;

/* 生命周期元数据只在合法状态迁移中变化：MINIMIZED 字段只允许在
   FULL<->MINIMIZED 之间出现/消失（STUB/TOMBSTONE 不应带归档引用） */
CREATE TRIGGER trg_nodes_lifecycle_meta_guard
BEFORE UPDATE ON nodes
WHEN (NEW.minimized_blob_ref IS NOT NULL OR NEW.minimized_blob_hash IS NOT NULL)
 AND NEW.content_state NOT IN ('MINIMIZED')
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: minimized_* fields are only valid while content_state=MINIMIZED');
END;

/* 废弃列保护：旧 superseded_by 只读，禁止再写入（任务 B5 兼容/废弃策略） */
CREATE TRIGGER trg_nodes_legacy_superseded_by_readonly
BEFORE UPDATE OF superseded_by ON nodes
WHEN NEW.superseded_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MEM_DEPRECATED_FIELD: superseded_by is deprecated — use superseded_by_revision');
END;
`);

    // ── RevisionId 分离：引用完整性 + 自引用 + 环（任务 F1-F3）──
    const refCheck = `
  SELECT RAISE(ABORT, 'STATE_CONFLICT: superseded_by_revision must reference an existing revision of the same logical memory');
`;
    db.exec(`
CREATE TRIGGER trg_supersede_revision_valid_ins
BEFORE INSERT ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM nodes WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN ${refCheck} END;

CREATE TRIGGER trg_supersede_revision_valid_upd
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM nodes WHERE node_id = NEW.node_id AND revision_id = NEW.superseded_by_revision)
BEGIN ${refCheck} END;

/* 自引用禁止 */
CREATE TRIGGER trg_supersede_no_self_ref
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND NEW.superseded_by_revision = NEW.revision_id
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: a revision cannot supersede itself');
END;

/* 环检测：沿 superseded_by_revision 链向前走，若回到自身则成环 */
CREATE TRIGGER trg_supersede_no_cycle
BEFORE UPDATE OF superseded_by_revision ON nodes
WHEN NEW.superseded_by_revision IS NOT NULL
 AND EXISTS (
   WITH RECURSIVE chain(rev) AS (
     SELECT NEW.superseded_by_revision
     UNION
     SELECT n.superseded_by_revision
       FROM nodes n JOIN chain c ON n.revision_id = c.rev
      WHERE n.superseded_by_revision IS NOT NULL
   )
   SELECT 1 FROM chain WHERE rev = NEW.revision_id)
BEGIN
  SELECT RAISE(ABORT, 'STATE_CONFLICT: supersede chain would form a cycle');
END;
`);
  },

  down: (db: any) => {
    // ── 任务 C：按真实触发器名逆序删除，再删依赖列 ──
    db.exec(`
DROP TRIGGER IF EXISTS trg_supersede_no_cycle;
DROP TRIGGER IF EXISTS trg_supersede_no_self_ref;
DROP TRIGGER IF EXISTS trg_supersede_revision_valid_upd;
DROP TRIGGER IF EXISTS trg_supersede_revision_valid_ins;
DROP TRIGGER IF EXISTS trg_nodes_legacy_superseded_by_readonly;
DROP TRIGGER IF EXISTS trg_nodes_lifecycle_meta_guard;
DROP TRIGGER IF EXISTS trg_nodes_immutable_content;
DROP INDEX IF EXISTS idx_nodes_visibility;
DROP INDEX IF EXISTS idx_nodes_agent;
DROP INDEX IF EXISTS idx_nodes_layer_project;
DROP INDEX IF EXISTS idx_nodes_owner;
DROP INDEX IF EXISTS idx_nodes_revseq;
DROP INDEX IF EXISTS idx_nodes_chain;
DROP INDEX IF EXISTS idx_nodes_current;

/* 还原为 001 结构：去掉 002 引入的列（先删引用它们的触发器，已在上方完成） */
CREATE TABLE nodes_rev1 (
  node_id TEXT NOT NULL,
  revision_id TEXT PRIMARY KEY,
  revision_sequence INTEGER NOT NULL,
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
  superseded_by TEXT
);
INSERT INTO nodes_rev1(node_id, revision_id, revision_sequence, content_hash, version_state,
  content_state, content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash, modality,
  confidence, provenance, valid_from, valid_until, ingested_at, superseded_by)
SELECT node_id, revision_id, revision_sequence, content_hash, version_state, content_state,
  content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash, modality, confidence,
  provenance, valid_from, valid_until, ingested_at,
  COALESCE(superseded_by, superseded_by_revision)
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_rev1 RENAME TO nodes;

CREATE UNIQUE INDEX idx_nodes_current ON nodes(node_id) WHERE version_state='CURRENT';
CREATE INDEX idx_nodes_chain ON nodes(node_id, revision_sequence);
`);
  },
};
