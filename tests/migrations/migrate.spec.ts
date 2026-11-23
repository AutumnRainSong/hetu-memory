/** Migration 001 幂等回放测试。 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => { db = new DatabaseSync(':memory:'); });

describe('migration 001', () => {
  it('首次回放创建全部表', () => {
    const { applied } = runMigrations(db);
    expect(applied).toContain(1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(r => r.name);
    for (const t of ['nodes', 'edges', 'outbox', 'purge_ledger', 'raw_events', 'digest_watermarks', 'sensitivity_overlay', 'schema_migrations'])
      expect(tables, `缺表 ${t}`).toContain(t);
  });

  it('重复回放幂等', () => {
    runMigrations(db);
    const { applied } = runMigrations(db);
    expect(applied.length).toBe(0);
  });

  it('状态约束生效：非法 content_state 拒绝', () => {
    runMigrations(db);
    expect(() =>
      db.prepare(`INSERT INTO nodes(node_id,revision_id,revision_sequence,content_hash,
        version_state,content_state,modality,confidence,provenance,valid_from,ingested_at)
        VALUES('n1','r1',1,'sha256:x','CURRENT','WEIRD','text',0.5,'{}','2026-01-01','2026-01-01')`).run()
    ).toThrow();
  });

  it('链尾唯一性：同 node_id 只允许一个 CURRENT（部分唯一索引）', () => {
    runMigrations(db);
    const ins = db.prepare(`INSERT INTO nodes(node_id,revision_id,revision_sequence,content_hash,
      version_state,content_state,modality,confidence,provenance,valid_from,ingested_at)
      VALUES(?,?,?,?,'CURRENT','FULL','text',0.6,'{}','2026-01-01','2026-01-01')`);
    ins.run('n1', 'r1', 1, 'sha256:a');
    expect(() => ins.run('n1', 'r2', 2, 'sha256:b')).toThrow(); // CURRENT 冲突
    db.prepare("UPDATE nodes SET version_state='SUPERSEDED', superseded_by='r3' WHERE revision_id='r1'").run();
    expect(() => ins.run('n1', 'r3', 3, 'sha256:c')).not.toThrow();
  });

  it('Purge Ledger 追加并按 content_hash 检索', () => {
    runMigrations(db);
    db.prepare(`INSERT INTO purge_ledger(node_id,content_hash,operator,reason_category)
      VALUES('n1','sha256:dead','tester','user-request')`).run();
    const hit = db.prepare('SELECT node_id FROM purge_ledger WHERE content_hash=?').get('sha256:dead');
    expect((hit as { node_id: string }).node_id).toBe('n1');
  });
});
