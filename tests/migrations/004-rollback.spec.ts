/** A-7 · Migration 004 Down 方案 A（契约 §9）。
 *  未完成任务（pending/claimed/failed）→ 抛 MIGRATION_ABORTED 并列出（≤50），不 DROP。
 *  全部 done 或 blob_cleanup_tasks 不存在（005 未应用） → 才 DROP。
 *  注意：禁止转存 migration_reports 后删表。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { migration as m004 } from '../../src/storage/migrations/004_purge_blob_marks.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db); // 001-00N（005 由 E 组注册；此处可能已存在）
});

function has005(): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_cleanup_tasks'")
    .get();
}

/** 保证 005 表存在（若 E 尚未注册 005，则手工 exec m005.up） */
async function ensure005(): Promise<void> {
  if (has005()) return;
  const { migration: m005 } = await import('../../src/storage/migrations/005_blob_objects.ts');
  db.exec(m005.up as string);
}

function insertTask(ref: string, status: string): void {
  db.prepare(
    `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status)
     VALUES('owner-1', ?, 'main', ?)`
  ).run(ref, status);
}

describe('A-7 · Migration 004 Down 方案 A', () => {
  it('无未完成任务（全 done）→ 004.down 才执行 DROP', async () => {
    await ensure005();
    insertTask('blobs-aa-ref', 'done');
    expect(() => (m004.down as (d: unknown) => void)(db)).not.toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='purge_blob_marks'").get()
    ).toBeUndefined();
  });

  it('★ pending 任务存在 → MIGRATION_ABORTED，任务完整保留，purge_blob_marks 不 DROP', async () => {
    await ensure005();
    insertTask('blobs-pending-ref', 'pending');
    let msg = '';
    try {
      (m004.down as (d: unknown) => void)(db);
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toMatch(/MIGRATION_ABORTED/);
    expect(msg).toContain('blobs-pending-ref');
    // 任务保留（未被转存、未被清除）
    const rows = db
      .prepare(`SELECT blob_ref, status FROM blob_cleanup_tasks WHERE status IN ('pending','claimed','failed')`)
      .all() as { blob_ref: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    // DROP 未执行
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='purge_blob_marks'").get()
    ).toBeTruthy();
  });

  it('★ claimed 与 failed 同样阻塞回滚，且逐条列出', async () => {
    await ensure005();
    insertTask('ref-claimed', 'claimed');
    insertTask('ref-failed', 'failed');
    let msg = '';
    try {
      (m004.down as (d: unknown) => void)(db);
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toMatch(/MIGRATION_ABORTED/);
    expect(msg).toContain('ref-claimed');
    expect(msg).toContain('ref-failed');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='purge_blob_marks'").get()
    ).toBeTruthy();
  });

  it('列出上限 50 条（超过 50 个未完成任务时只列前 50）', async () => {
    await ensure005();
    for (let i = 0; i < 60; i++) insertTask(`bulk-ref-${i}`, 'pending');
    let msg = '';
    try {
      (m004.down as (d: unknown) => void)(db);
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain('bulk-ref-0');
    expect(msg).toContain('bulk-ref-49');
    expect(msg).not.toContain('bulk-ref-50');
  });

  it('005 表不存在（004.down 早于 005 应用）→ 视为无阻塞，直接 DROP', () => {
    // 显式剔除 005 表与索引，模拟 005 尚未应用
    db.exec(`
DROP TABLE IF EXISTS blob_cleanup_tasks;
DROP TABLE IF EXISTS blob_refs;
DROP TABLE IF EXISTS blob_objects;
DROP INDEX IF EXISTS idx_cleanup_pickup;
DROP INDEX IF EXISTS idx_cleanup_active;
DROP INDEX IF EXISTS idx_blob_refs_count;
DROP INDEX IF EXISTS idx_blob_objects_state;`);
    expect(has005()).toBe(false);
    expect(() => (m004.down as (d: unknown) => void)(db)).not.toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='purge_blob_marks'").get()
    ).toBeUndefined();
  });

  it('m004.down 是函数而非静态 SQL（方案 A 判定逻辑真实执行）', () => {
    expect(typeof m004.down).toBe('function');
  });

  it('down 不写 migration_reports（禁止转存后删表）', async () => {
    await ensure005();
    insertTask('ref-x', 'pending');
    try {
      (m004.down as (d: unknown) => void)(db);
    } catch {
      /* 预期抛出 */
    }
    const hasReports = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_reports'")
      .get();
    if (hasReports) {
      const n = db.prepare('SELECT COUNT(*) c FROM migration_reports').get() as { c: number };
      expect(Number(n.c)).toBe(0);
    }
  });
});
