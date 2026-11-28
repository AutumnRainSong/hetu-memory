/**
 * F-9 · migration-004-rollback —— 004 有 pending/failed 任务时回滚 → 拒绝回滚（任务完整保留）。
 *
 * R4 契约 §9（裁决6）：Migration 004 down 方案 A —— 若 blob_cleanup_tasks 存在 status
 * IN (pending,claimed,failed)，则**拒绝回滚**，抛 MIGRATION_ABORTED，列出未完成任务（最多 50 条）；
 * 禁止把任务转存 migration_reports 后删表。全部 done 或表不存在才 DROP。
 *
 * 前置条件：005 已注册（否则 blob_cleanup_tasks 不存在 → down 无法检测 pending）+ 004 已 apply
 *   + 有未完成任务行。
 * 并发方式：串行。
 * 预期：
 *  - 存在 pending/failed 任务时 rollbackTo(3) 抛 MIGRATION_ABORTED；且不删 purge_blob_marks、
 *    blob_cleanup_tasks 中任务完整保留（数量/内容不变）；schema_migrations 仍含 version 4。
 *  - 清空未完成任务（置 done 或删除）后 rollbackTo(3) 成功，purge_blob_marks DROP。
 * 失败数据态：若 down 先转存 migration_reports 再删表 → 任务丢失、无重试依据（契约禁止）。
 *
 * 当前：005 未注册（blob_cleanup_tasks 不存在）→ 该场景下 down 会当作“表不存在”直接 DROP，
 * 与契约预期不符 → 本文件整体 skip 并提示 E 组必须注册 005 后再验收。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations, rollbackTo, schemaHasTable, skipReason, } from './_helpers.ts';

describe('F-9 · migration-004-rollback', () => {
  let db: InstanceType<typeof DatabaseSync>;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
  });

  it('blob_cleanup_tasks 存在（005 注册）后，含 pending 任务回滚被拒绝', () => {
    if (!schemaHasTable(db, 'blob_cleanup_tasks')) {
      skipReason('F-9', '005 未注册 → blob_cleanup_tasks 不存在，004.down 无法检测 pending，场景不可测');
      return;
    }
    // 保证 004 已 apply
    const applied = (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(r => r.version);
    if (!applied.includes(4)) {
      // 004 尚未 apply → 直接 apply
      runMigrations(db);
    }
    // 插入一条 pending 任务
    db.prepare(
      "INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status) VALUES('ws-1','workspaces/x/blobs/aa/a1','main','pending')"
    ).run();

    // 回滚到 3（触发 004.down）→ 必须拒绝
    let err: Error | null = null;
    try {
      rollbackTo(db, 3);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch('MIGRATION_ABORTED');

    // 任务完整保留
    const leftover = db.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks').get() as { c: number };
    expect(Number(leftover.c)).toBe(1);
    // 004 表与版本未动
    expect(schemaHasTable(db, 'purge_blob_marks')).toBe(true);
    const v4 = db.prepare("SELECT COUNT(*) c FROM schema_migrations WHERE version=4").get() as { c: number };
    expect(Number(v4.c)).toBe(1);
  });

  it('无未完成任务时 004 可回滚（DOWN DROP purge_blob_marks）', () => {
    if (!schemaHasTable(db, 'blob_cleanup_tasks')) {
      skipReason('F-9', '005 未注册，跳过回滚成功分支');
      return;
    }
    // 清空未完成任务（把 pending 置 done）
    db.prepare("UPDATE blob_cleanup_tasks SET status='done' WHERE status='pending'").run();
    // 注意：done 任务行可保留（不阻塞 down）；此处为求证「仅未完成才拒绝」。
    const res = rollbackTo(db, 3);
    expect(res.rolledBack).toContain(4);
    expect(schemaHasTable(db, 'purge_blob_marks')).toBe(false);
  });
});