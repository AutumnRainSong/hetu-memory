/** A-1 · Migration 005 三张表结构验收（契约 §3）。 */
import { describe, it, expect } from 'vitest';
import { createDb, hashOf, mainRefFor } from './helpers/a-group.ts';
import { migration as m005 } from '../../src/storage/migrations/005_blob_objects.ts';

const O = 'owner-1';
const H = hashOf('a');
const REF = mainRefFor(O, H);

describe('A-1 · Migration 005 schema', () => {
  it('blob_objects: 复合主键 (owner_key, blob_ref)', () => {
    const db = createDb();
    const cols = db.prepare('PRAGMA table_info(blob_objects)').all() as {
      name: string;
      pk: number;
    }[];
    expect(cols.filter((c) => c.pk).map((c) => c.name).sort()).toEqual(['blob_ref', 'owner_key']);
    const names = cols.map((c) => c.name);
    for (const c of [
      'kind',
      'state',
      'content_hash',
      'size_bytes',
      'created_at',
      'deleted_at',
    ])
      expect(names, `blob_objects 缺列 ${c}`).toContain(c);
  });

  it('blob_objects.state 只允许 ACTIVE/DELETING/DELETED，非法拒绝', () => {
    const db = createDb();
    for (const s of ['ACTIVE', 'DELETING', 'DELETED']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
             VALUES(?,?, 'main', ?, ?)`
          )
          .run(O, `ref-${s}`, s, 'sha256:' + H)
      ).not.toThrow();
    }
    expect(() =>
      db
        .prepare(
          `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
           VALUES(?,?,'main','WEIRD',?)`
        )
        .run(O, 'ref-bad', 'sha256:' + H)
    ).toThrow();
  });

  it('★ blob_refs: UNIQUE(owner_key, blob_ref, revision_id, kind) 防重复计数', () => {
    const db = createDb();
    const ins = db.prepare(
      `INSERT INTO blob_refs(owner_key, blob_ref, node_id, revision_id, kind) VALUES(?,?,?,?,?)`
    );
    ins.run(O, REF, 'n1', 'r1', 'main');
    expect(() => ins.run(O, REF, 'n1', 'r1', 'main')).toThrow(/UNIQUE/);
    // 不同 revision / 不同 kind 是合法的新引用
    expect(() => ins.run(O, REF, 'n1', 'r2', 'main')).not.toThrow();
    expect(() => ins.run(O, REF, 'n1', 'r1', 'archive')).not.toThrow();
    const c = db
      .prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?')
      .get(O, REF) as { c: number };
    expect(Number(c.c)).toBe(3);
  });

  it('blob_cleanup_tasks: 部分唯一索引只约束 pending/claimed/failed（done 不占用）', () => {
    const db = createDb();
    const ins = db.prepare(
      `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status) VALUES(?,?,'main',?)`
    );
    ins.run(O, 'refA', 'pending');
    expect(() => ins.run(O, 'refA', 'failed')).toThrow(/UNIQUE/);
    expect(() => ins.run(O, 'refA', 'claimed')).toThrow(/UNIQUE/);
    db.prepare(`UPDATE blob_cleanup_tasks SET status='done' WHERE blob_ref='refA'`).run();
    expect(() => ins.run(O, 'refA', 'pending')).not.toThrow();
  });

  it('down 脚本只 DROP 005 三表，不触碰 004 的 purge_blob_marks', () => {
    const db = createDb();
    const sql = String(m005.down);
    for (const t of ['blob_objects', 'blob_refs', 'blob_cleanup_tasks'])
      expect(sql).toContain(`DROP TABLE IF EXISTS ${t}`);
    db.exec(sql);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ['blob_objects', 'blob_refs', 'blob_cleanup_tasks'])
      expect(names).not.toContain(t);
    expect(names).toContain('purge_blob_marks');
  });
});
