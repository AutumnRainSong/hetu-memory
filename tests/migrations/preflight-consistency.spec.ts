/** R4-E7：blocking=true ⇒ 真实 runMigrations() 也中止（一一对应）。
 *
 *  对每个 blocking 场景用同一数据库实例：
 *   1) preflight 报告 blocking=true
 *   2) 调用真实 runMigrations()（不 dryRun）→ 抛 MIGRATION_ABORTED
 *  关键一致性约束。注意：真实迁移会沿 001→002 依次执行，002 的 pre-check 与
 *  preflight 使用同一判定，故二者阻塞集合一致。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { preflight } from '../../src/storage/preflight.ts';

function legacyInsert(
  db: InstanceType<typeof DatabaseSync>,
  r: { node_id: string; revision_id: string; superseded_by?: string | null; seq?: number }
): void {
  db.prepare(
    `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
      content_state, modality, confidence, provenance, valid_from, ingested_at, superseded_by)
     VALUES(?,?,?,?, 'CURRENT', 'FULL', 'text', 0.7, '{}', '2026-01-01', '2026-01-01', ?)`
  ).run(r.node_id, r.revision_id, r.seq ?? 1, 'sha256:x', r.superseded_by ?? null);
}
function legacyInsertSuperseded(
  db: InstanceType<typeof DatabaseSync>,
  r: { node_id: string; revision_id: string; superseded_by?: string | null; seq?: number }
): void {
  db.prepare(
    `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
      content_state, modality, confidence, provenance, valid_from, ingested_at, superseded_by)
     VALUES(?,?,?,?, 'SUPERSEDED', 'FULL', 'text', 0.7, '{}', '2026-01-01', '2026-01-01', ?)`
  ).run(r.node_id, r.revision_id, r.seq ?? 1, 'sha256:x', r.superseded_by ?? null);
}

function freshLegacyDb() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, { target: 1 });
  return db;
}

function expectAborted(fn: () => void) {
  let err: Error | null = null;
  try { fn(); } catch (e) { err = e as Error; }
  expect(err).not.toBeNull();
  expect(err!.message).toMatch(/MIGRATION_ABORTED/);
}

describe('E7 — blocking ⇔ 真实迁移中止一一对应', () => {
  it('未映射 + 真迁移 → preflight blocking=true 且 runMigrations MIGRATION_ABORTED', () => {
    const db = freshLegacyDb();
    legacyInsert(db, { node_id: 'm1', revision_id: 'rev-1' });
    expect(preflight(db, {}).blocking).toBe(true);
    expectAborted(() => runMigrations(db, { legacyOwnerId: 'u' })); // 缺映射
    db.close();
  });

  it('歧义 superseded + 真迁移 → blocking + MIGRATION_ABORTED', () => {
    const db = freshLegacyDb();
    legacyInsert(db, { node_id: 'mem-9', revision_id: 'rev-9-1' });
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-a', superseded_by: 'mem-9', seq: 1 });
    expect(preflight(db, {}).blocking).toBe(true);
    expectAborted(() => runMigrations(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true }));
    db.close();
  });

  it('悬空 superseded + 真迁移 → blocking + MIGRATION_ABORTED', () => {
    const db = freshLegacyDb();
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-a', superseded_by: 'rev-404', seq: 1 });
    expect(preflight(db, {}).blocking).toBe(true);
    expectAborted(() => runMigrations(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true }));
    db.close();
  });

  it('历史环 + 真迁移 → blocking + MIGRATION_ABORTED', () => {
    const db = freshLegacyDb();
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-a', superseded_by: 'rev-b', seq: 1 });
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-b', superseded_by: 'rev-a', seq: 2 });
    expect(preflight(db, {}).blocking).toBe(true);
    expectAborted(() => runMigrations(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true }));
    db.close();
  });

  it('悬空普通边 + 真迁移 → blocking + MIGRATION_ABORTED', () => {
    const db = freshLegacyDb();
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at)
       VALUES('cooccur', 'n1', 'n-ghost', 0.5, '2026-01-01T00:00:00Z')`
    ).run();
    expect(preflight(db, {}).blocking).toBe(true);
    expectAborted(() => runMigrations(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true }));
    db.close();
  });

  it('悬空 supersedes 边 + 真迁移 → blocking + MIGRATION_ABORTED', () => {
    const db = freshLegacyDb();
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at)
       VALUES('supersedes', 'rev-a', 'rev-ghost', 1, '2026-01-01T00:00:00Z')`
    ).run();
    expect(preflight(db, {}).blocking).toBe(true);
    expectAborted(() => runMigrations(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true }));
    db.close();
  });

  it('无任何阻断 → preflight blocking=false 且真迁移成功', () => {
    const db = freshLegacyDb();
    legacyInsert(db, { node_id: 'm1', revision_id: 'rev-1' });
    expect(preflight(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true }).blocking).toBe(false);
    expect(() =>
      runMigrations(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true })
    ).not.toThrow();
    db.close();
  });
});