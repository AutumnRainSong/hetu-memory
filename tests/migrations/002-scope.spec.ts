/** Migration 002 验收测试：Scope 持久化 + RevisionId 分离 + 不可变约束。
 *  对应《第一版代码审查结论》M1-A 任务 1/2/3 的 QA 门禁。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); });

const insertNode = (over: Record<string, unknown> = {}) => {
  const base = {
    node_id: 'mem-1001', revision_id: 'rev-1001-1', revision_sequence: 1,
    content_hash: 'sha256:' + 'a'.repeat(64), version_state: 'CURRENT',
    content_state: 'FULL', modality: 'text', confidence: 0.8,
    provenance: JSON.stringify({ agent_id: 'agent-a', origin: 'hot-path', method: 'user-confirmed', source_refs: [], producer_version: 'hetu 0.1.0', generated_at: '2026-11-24T00:00:00Z', confidence: 0.9 }),
    owner_id: 'user-default', layer: 'project', project_id: 'proj-1',
    agent_id: null, visibility: 'project_agents', shared_with: '[]',
    valid_from: '2026-11-24T00:00:00Z', ingested_at: '2026-11-24T00:00:00Z',
  };
  const row = { ...base, ...over };
  db.prepare(`INSERT INTO nodes(node_id,revision_id,revision_sequence,content_hash,version_state,
    content_state,modality,confidence,provenance,owner_id,layer,project_id,agent_id,visibility,
    shared_with,valid_from,ingested_at,superseded_by_revision)
    VALUES(@node_id,@revision_id,@revision_sequence,@content_hash,@version_state,@content_state,
    @modality,@confidence,@provenance,@owner_id,@layer,@project_id,@agent_id,@visibility,
    @shared_with,@valid_from,@ingested_at,@superseded_by_revision)`).run({
      ...row, superseded_by_revision: (row.superseded_by_revision as string) ?? null });
  return row;
};

describe('migration 002 — Scope 持久化', () => {
  it('scope 六字段完整持久化并可按 owner/layer/project 查询', () => {
    insertNode();
    const row = db.prepare('SELECT owner_id,layer,project_id,agent_id,visibility,shared_with FROM nodes WHERE node_id=?')
      .get('mem-1001') as any;
    expect(row.owner_id).toBe('user-default');
    expect(row.layer).toBe('project');
    expect(row.project_id).toBe('proj-1');
    expect(row.visibility).toBe('project_agents');
    expect(JSON.parse(row.shared_with)).toEqual([]);
    // SQL 前置过滤可用：按 owner + layer 查询命中
    const hits = db.prepare("SELECT node_id FROM nodes WHERE owner_id=? AND layer='project'").all('user-default');
    expect(hits.length).toBe(1);
  });

  it('跨 owner 隔离：B owner 的 SQL 过滤查不到 A 的记忆', () => {
    insertNode();
    const hits = db.prepare("SELECT node_id FROM nodes WHERE owner_id='user-other'").all();
    expect(hits.length).toBe(0);
  });

  it('scope 索引存在（owner/layer+project/agent/visibility）', () => {
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map(r => r.name);
    for (const n of ['idx_nodes_owner', 'idx_nodes_layer_project', 'idx_nodes_agent', 'idx_nodes_visibility'])
      expect(idx, `缺索引 ${n}`).toContain(n);
  });
});

describe('migration 002 — NodeId/RevisionId 分离', () => {
  it('superseded_by_revision 指向同 node_id 的已存在 revision 时允许', () => {
    insertNode();
    // 链尾唯一性（idx_nodes_current）要求同一时刻仅一个 CURRENT：
    // 先将 v1 转 SUPERSEDED（指向即将插入的 v2？不行——外键触发器要求目标已存在）
    // 正确顺序（应用层 CAS 流程）：v2 以 CURRENT 插入前，v1 必须已转 SUPERSEDED，
    // 但 trg_supersede_revision_valid_upd 又要求 superseded_by_revision 指向已存在的 revision。
    // 两约束的解法 = 事务内两步：先插 v2 为临时 SUPERSEDED？No——
    // 最终语义（与行为矩阵一致）：supersede 由存储层 CAS 完成，单事务内
    //   ① UPDATE 旧链尾 SET superseded_by_revision=新rev, version_state=SUPERSEDED（此时新 rev 未入表，
    //      触发器要求目标存在 → 采用两步：先插新行 version_state=SUPERSEDED 占位再翻转？）
    // 收敛结论（本测试锁定的最终语义）：**插入新 revision 时先以 SUPERSEDED+superseded_by 逆向指针入库，
    // 随后同事务将旧链尾 UPDATE 为 SUPERSEDED**。为允许"新行以非 CURRENT 态插入"，idx_nodes_current
    // 只约束 CURRENT，SUPERSEDED 行可并存 → 顺序：插新行(SUPERSEDED) → 旧链尾 UPDATE 翻转。
    insertNode({ revision_id: 'rev-1001-2', revision_sequence: 2,
      content_hash: 'sha256:' + 'b'.repeat(64),
      version_state: 'SUPERSEDED', superseded_by_revision: null });
    // 同事务翻转旧链尾（supersede 的存储层 CAS 流程）
    db.prepare("UPDATE nodes SET superseded_by_revision='rev-1001-2' WHERE revision_id='rev-1001-1'").run();
    db.prepare("UPDATE nodes SET version_state='SUPERSEDED' WHERE revision_id='rev-1001-1'").run();
    const v1 = db.prepare("SELECT version_state,superseded_by_revision FROM nodes WHERE revision_id='rev-1001-1'").get() as any;
    expect(v1.version_state).toBe('SUPERSEDED');
    expect(v1.superseded_by_revision).toBe('rev-1001-2');
    // 语义澄清：此测试锁定的是"superseded_by_revision 的引用完整性触发器"，
    // supersede 的完整 CAS 流程在 T-B-02（存储主程）任务中实现与测试。
  });

  it('superseded_by_revision 指向不存在 revision → STATE_CONFLICT 拒绝', () => {
    insertNode();
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by_revision='rev-9999' WHERE revision_id='rev-1001-1'").run()
    ).toThrow(/STATE_CONFLICT/);
  });

  it('同 node_id 的 revision_sequence 重复 → 唯一索引拒绝', () => {
    insertNode();
    expect(() =>
      insertNode({ revision_id: 'rev-1001-dup', content_hash: 'sha256:' + 'c'.repeat(64) })
    ).toThrow(/UNIQUE/);
  });
});

describe('migration 002 — 不可变性触发器', () => {
  it('修改 CURRENT 节点的 content_hash/content_ref → MEM_IMMUTABLE 拒绝', () => {
    insertNode();
    expect(() =>
      db.prepare("UPDATE nodes SET content_hash='sha256:' || replace(hex(randomblob(32)),'','0') WHERE revision_id='rev-1001-1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('修改 TOMBSTONE 节点不受不可变触发器限制（tombstone 元数据可管理）', () => {
    insertNode({ content_state: 'TOMBSTONE' });
    expect(() =>
      db.prepare("UPDATE nodes SET stub_summary='managed' WHERE revision_id='rev-1001-1'").run()
    ).not.toThrow();
  });
});
