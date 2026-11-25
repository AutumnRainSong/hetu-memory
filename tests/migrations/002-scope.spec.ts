/** Migration 002 Rev3 —— 全新数据库验收（任务 A4/A5/A6、E）
 *  覆盖：Scope 必需字段真实非空、字段关系约束、shared_with JSON 校验、
 *        revision 引用完整性、防自引用/环、链尾唯一索引存在。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { insertNode, getRevision, hashOf } from '../helpers/db.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
});

describe('Migration 002 Rev3 — Scope 约束（真实 NOT NULL）', () => {
  it('完整 scope 可写入并可按 owner/layer/project 前置过滤', () => {
    insertNode(db);
    const row = getRevision(db, 'rev-1001-1');
    expect(row.owner_id).toBe('user-default');
    expect(row.layer).toBe('project');
    expect(row.project_id).toBe('proj-1');
    expect(row.visibility).toBe('project_agents');
    expect(JSON.parse(row.shared_with)).toEqual([]);

    const hits = db
      .prepare("SELECT revision_id FROM nodes WHERE owner_id=? AND layer='project'")
      .all('user-default');
    expect(hits.length).toBe(1);
  });

  it('owner_id 为 NULL → NOT NULL 拒绝（不是旧版 CHECK 可绕过）', () => {
    expect(() =>
      insertNode(db, { owner_id: null as unknown as string })
    ).toThrow(/NOT NULL|owner_id/);
  });

  it('layer 为 NULL → 拒绝', () => {
    expect(() => insertNode(db, { layer: null as unknown as string })).toThrow(/NOT NULL|layer/);
  });

  it('visibility 为 NULL → 拒绝', () => {
    expect(() =>
      insertNode(db, { visibility: null as unknown as string })
    ).toThrow(/NOT NULL|visibility/);
  });

  it('layer=project 但 project_id 为 NULL → 字段关系约束拒绝', () => {
    expect(() => insertNode(db, { layer: 'project', project_id: null })).toThrow(/CHECK|constraint/);
  });

  it('layer=private_annotation 且 visibility≠owner → 拒绝', () => {
    expect(() =>
      insertNode(db, {
        layer: 'private_annotation',
        agent_id: 'agent-a',
        visibility: 'all_agents',
      })
    ).toThrow(/CHECK|constraint/);
  });

  it('layer=agent_persona 缺 agent_id → 拒绝', () => {
    expect(() =>
      insertNode(db, { layer: 'agent_persona', agent_id: null, project_id: null })
    ).toThrow(/CHECK|constraint/);
  });

  it('shared_with 非 JSON 数组 → 拒绝', () => {
    expect(() => insertNode(db, { shared_with: 'not-json' })).toThrow(/CHECK|constraint/);
    expect(() => insertNode(db, { shared_with: '"a-string"' })).toThrow(/CHECK|constraint/);
  });

  it('shared_with 合法数组 → 允许', () => {
    expect(() => insertNode(db, { shared_with: '["agent-b","agent-c"]' })).not.toThrow();
  });
});

describe('Migration 002 Rev3 — 跨 owner 隔离（SQL 层）', () => {
  it('不同 owner 的记录互不命中', () => {
    insertNode(db, { owner_id: 'user-a', node_id: 'n-a' });
    insertNode(db, { owner_id: 'user-b', node_id: 'n-b', revision_id: 'rev-n-b-1' });
    const onlyA = db.prepare('SELECT revision_id FROM nodes WHERE owner_id=?').all('user-a');
    expect(onlyA.length).toBe(1);
    expect((onlyA[0] as { revision_id: string }).revision_id).toBe('rev-1001-1');
  });
});

describe('Migration 002 Rev3 — Revision 引用完整性（任务 E/F1-F3）', () => {
  it('superseded_by_revision 指向同 node_id 已存在 revision → 允许', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1', revision_sequence: 1 });
    insertNode(db, {
      node_id: 'n1',
      revision_id: 'r2',
      revision_sequence: 2,
      content_hash: hashOf('b'),
      version_state: 'SUPERSEDED',
      content_ref: 'blobs/bb/r2.txt',
    });
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by_revision='r2' WHERE revision_id='r1'").run()
    ).not.toThrow();
    expect(getRevision(db, 'r1').superseded_by_revision).toBe('r2');
  });

  it('指向不存在的 revision → STATE_CONFLICT', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by_revision='rev-404' WHERE revision_id='r1'").run()
    ).toThrow(/STATE_CONFLICT/);
  });

  it('指向另一 node_id 的 revision → STATE_CONFLICT（必须同逻辑记忆）', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    insertNode(db, { node_id: 'n2', revision_id: 'r2', content_hash: hashOf('c') });
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by_revision='r2' WHERE revision_id='r1'").run()
    ).toThrow(/STATE_CONFLICT/);
  });

  it('自引用 → STATE_CONFLICT', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by_revision='r1' WHERE revision_id='r1'").run()
    ).toThrow(/STATE_CONFLICT|cannot supersede itself/);
  });

  it('形成环 → STATE_CONFLICT', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1', revision_sequence: 1 });
    insertNode(db, {
      node_id: 'n1', revision_id: 'r2', revision_sequence: 2,
      content_hash: hashOf('d'), version_state: 'SUPERSEDED', content_ref: 'blobs/dd/r2.txt',
    });
    db.prepare("UPDATE nodes SET superseded_by_revision='r2' WHERE revision_id='r1'").run();
    // r2 → r1 会形成 r1→r2→r1 环
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by_revision='r1' WHERE revision_id='r2'").run()
    ).toThrow(/STATE_CONFLICT|cycle/);
  });

  it('revision_sequence 重复 → UNIQUE 拒绝', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1', revision_sequence: 1 });
    expect(() =>
      insertNode(db, { node_id: 'n1', revision_id: 'r9', revision_sequence: 1, content_hash: hashOf('e') })
    ).toThrow(/UNIQUE/);
  });
});

describe('Migration 002 Rev3 — 链尾唯一索引存在（任务 F4 存储层防线）', () => {
  it('idx_nodes_current 存在，保证「最多一个 CURRENT」', () => {
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map(r => r.name);
    expect(idx).toContain('idx_nodes_current');

    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      insertNode(db, { node_id: 'n1', revision_id: 'r2', revision_sequence: 2, content_hash: hashOf('f') })
    ).toThrow(/UNIQUE/);
  });
});
