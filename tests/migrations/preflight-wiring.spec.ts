/** R4-E5/E6：Migration 005 注册 + preflight 接入 runMigrations/rollbackTo + cleanupTasksIncomplete。 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations, rollbackTo, MIGRATIONS } from '../../src/storage/migrate.ts';
import { preflight } from '../../src/storage/preflight.ts';

describe('E6 — Migration 005 已在 MIGRATIONS 数组注册并可用', () => {
  it('MIGRATIONS 含版本 5（blob-objects-and-cleanup）', () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(MIGRATIONS[4].name).toBe('blob-objects-and-cleanup');
  });

  it('全新库 runMigrations 应用全部 5 个迁移', () => {
    const db = new DatabaseSync(':memory:');
    const { applied } = runMigrations(db);
    expect(applied).toEqual([1, 2, 3, 4, 5]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(r => r.name);
    for (const t of ['blob_objects', 'blob_refs', 'blob_cleanup_tasks'])
      expect(tables).toContain(t);
    // 全部应用后 pending 为空、无阻断
    const p = preflight(db, {});
    expect(p.pendingVersions).toEqual([]);
    expect(p.appliedVersions).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });

  it('005 表存在且有未完成任务 → cleanupTasksIncomplete 计数（done 不计）', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status)
       VALUES('o1','main/h/e', 'main', 'pending'),
             ('o2','archive/x/y','archive','claimed'),
             ('o3','main/z/w','main','done')`
    ).run();
    const p = preflight(db, {});
    expect(p.cleanupTasksIncomplete).toBe(2); // pending + claimed
    db.close();
  });

  it('005 表不存在时 cleanupTasksIncomplete=0（不抛）', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 4 });
    const p = preflight(db, {});
    expect(p.cleanupTasksIncomplete).toBe(0);
    db.close();
  });
});

describe('E5 — rollbackTo 共用 preflight 的清理队列判定', () => {
  it('存在未完成清理任务 → rollbackTo(3) 抛 MIGRATION_ABORTED 并列出任务', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status)
       VALUES('o1','ref-pending','main','pending'), ('o1','ref-failed','archive','failed')`
    ).run();
    let err: Error | null = null;
    try { rollbackTo(db, 3); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/MIGRATION_ABORTED/);
    expect(err!.message).toContain('ref-pending');
    expect(err!.message).toContain('ref-failed');
    // 任务与 004 表均未被破坏
    expect((db.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks').get() as { c: number }).c).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='purge_blob_marks'").get()).toBeTruthy();
    db.close();
  });

  it('全部 done → rollbackTo(3) 成功', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status) VALUES('o1','ref-done','main','done')`
    ).run();
    const res = rollbackTo(db, 3);
    expect(res.rolledBack).toContain(4);
    expect(res.rolledBack).toContain(5);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='purge_blob_marks'").get()).toBeUndefined();
    db.close();
  });

  it('尚未应用 005（target=4 之前）时不误拦', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 4 });
    const res = rollbackTo(db, 3);
    expect(res.rolledBack).toEqual([4]);
    db.close();
  });
});