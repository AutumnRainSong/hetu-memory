/** Migration 002 Rev3 —— 回滚与不可变性（任务 C / D）
 *
 *  任务 C：真实执行 Down SQL（不是字符串检查）；回滚后 001 结构可用、数据仍在；
 *          再次 Up 可成功（Up/Down 循环）。
 *  任务 D：NULL 安全的不可变保护（content_ref NULL↔非 NULL 必须被拦）；
 *          生命周期元数据（minimized_*）允许在合法状态迁移中变化。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations, rollbackTo } from '../../src/storage/migrate.ts';
import { insertNode, getRevision, hashOf, columnSnapshot } from '../helpers/db.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
});

describe('Migration 002 Rev3 — 回滚（任务 C）', () => {
  it('Down 真实执行成功，回到 001 结构（002 列全部消失）', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });

    const { rolledBack } = rollbackTo(db, 1);
    expect(rolledBack).toContain(2);

    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name);
    for (const c of ['owner_id', 'layer', 'project_id', 'agent_id', 'visibility', 'shared_with', 'superseded_by_revision'])
      expect(cols, `列 ${c} 应已回滚删除`).not.toContain(c);

    // 数据仍在，且 superseded_by_revision 已折叠回旧的 superseded_by
    const row = db.prepare("SELECT * FROM nodes WHERE revision_id='r1'").get() as any;
    expect(row).toBeTruthy();
    expect(row.node_id).toBe('n1');
  });

  it('回滚后 001 结构可用（可插入旧格式行）', () => {
    runMigrations(db);
    rollbackTo(db, 1);
    expect(() =>
      db.prepare(
        `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
          content_state, modality, confidence, provenance, valid_from, ingested_at, superseded_by)
         VALUES('n-old','r-old',1,'sha256:x','CURRENT','FULL','text',0.6,'{}','2026-01-01','2026-01-01',NULL)`
      ).run()
    ).not.toThrow();
  });

  it('回滚后再次 Up 成功（Up/Down 循环）', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    rollbackTo(db, 1);
    // 回滚后数据回到 001 结构（无 scope 列）→ 再次 Up 必须显式指定 legacy owner
    const { applied } = runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true });
    expect(applied).toContain(2);

    // 重新施加的约束生效
    expect(() =>
      insertNode(db, { node_id: 'n2', revision_id: 'r2', owner_id: null as unknown as string })
    ).toThrow(/NOT NULL|owner_id/);
  });

  it('表结构快照：回滚前后表集合一致（无残留临时表）', () => {
    runMigrations(db);
    const before = Object.keys(columnSnapshot(db)).sort();
    rollbackTo(db, 1);
    const after = Object.keys(columnSnapshot(db)).sort();
    expect(after).toEqual(before);
    expect(after).not.toContain('nodes_rev1');
    expect(after).not.toContain('nodes_rev3');
  });
});

describe('Migration 002 Rev3 — 不可变性（任务 D）', () => {
  it('content_hash 修改 → MEM_IMMUTABLE', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare("UPDATE nodes SET content_hash=? WHERE revision_id='r1'").run(hashOf('zzz'))
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('content_ref 从 NULL → 非 NULL 被拦截（旧版 `!=` 的 NULL 绕过点）', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1', content_ref: null });
    expect(() =>
      db.prepare("UPDATE nodes SET content_ref='blob://mutated' WHERE revision_id='r1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('content_ref 从非 NULL → NULL 被拦截', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1', content_ref: 'blobs/aa/x.txt' });
    expect(() =>
      db.prepare("UPDATE nodes SET content_ref=NULL WHERE revision_id='r1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('content_ref 非 NULL → 另一非 NULL 被拦截', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1', content_ref: 'blobs/aa/x.txt' });
    expect(() =>
      db.prepare("UPDATE nodes SET content_ref='blobs/bb/y.txt' WHERE revision_id='r1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('provenance 修改 → MEM_IMMUTABLE（来源不可篡改）', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare("UPDATE nodes SET provenance='{}' WHERE revision_id='r1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('ingested_at 修改 → MEM_IMMUTABLE', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare("UPDATE nodes SET ingested_at='2030-01-01' WHERE revision_id='r1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('合法状态迁移：FULL → MINIMIZED 允许（带归档引用）', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare(
        `UPDATE nodes SET content_state='MINIMIZED', stub_summary='摘要',
           minimized_blob_ref='archive/n1/r1.txt', minimized_blob_hash=? WHERE revision_id='r1'`
      ).run(hashOf('arch'))
    ).not.toThrow();
  });

  it('MINIMIZED 字段在没有 MINIMIZED 状态下出现 → STATE_CONFLICT', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare(
        "UPDATE nodes SET minimized_blob_ref='archive/n1/r1.txt' WHERE revision_id='r1'"
      ).run()
    ).toThrow(/STATE_CONFLICT/);
  });

  it('合法迁移：MINIMIZED → FULL（Revive）允许清除归档引用', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    db.prepare(
      `UPDATE nodes SET content_state='MINIMIZED', stub_summary='摘要',
         minimized_blob_ref='archive/n1/r1.txt', minimized_blob_hash=? WHERE revision_id='r1'`
    ).run(hashOf('arch2'));
    expect(() =>
      db.prepare(
        `UPDATE nodes SET content_state='FULL', minimized_blob_ref=NULL, minimized_blob_hash=NULL
         WHERE revision_id='r1'`
      ).run()
    ).not.toThrow();
    expect(getRevision(db, 'r1').content_state).toBe('FULL');
  });

  it('TOMBSTONE 状态同样受内容不可变性保护（不能借删除态改原文引用）', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    db.prepare("UPDATE nodes SET content_state='TOMBSTONE' WHERE revision_id='r1'").run();
    expect(() =>
      db.prepare("UPDATE nodes SET content_ref='blob://hijack' WHERE revision_id='r1'").run()
    ).toThrow(/MEM_IMMUTABLE/);
  });

  it('废弃列 superseded_by 只读：再写入 → MEM_DEPRECATED_FIELD', () => {
    runMigrations(db);
    insertNode(db, { node_id: 'n1', revision_id: 'r1' });
    expect(() =>
      db.prepare("UPDATE nodes SET superseded_by='r2' WHERE revision_id='r1'").run()
    ).toThrow(/MEM_DEPRECATED_FIELD/);
  });
});
