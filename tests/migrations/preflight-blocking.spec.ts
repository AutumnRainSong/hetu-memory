/** R4-E5：环 / 歧义 / 未映射 全覆盖 + blocking 判定 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { preflight } from '../../src/storage/preflight.ts';

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

// 001-only（无 superseded_by_revision 列、无 edges 触发器）阶段构造历史数据
function freshLegacyDb() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, { target: 1 });
  return db;
}

describe('E5 — 历史环 / 歧义 / 未映射', () => {
  it('历史环（rev-a<->rev-b）→ cycles 非空 + blocking=true', () => {
    const db = freshLegacyDb();
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-a', superseded_by: 'rev-b', seq: 1 });
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-b', superseded_by: 'rev-a', seq: 2 });
    const p = preflight(db, {});
    expect(p.cycles.length).toBeGreaterThan(0);
    expect(p.blocking).toBe(true);
    db.close();
  });

  it('superseded 歧义（旧值指向存在的 node_id）→ supersededAmbiguous + blocking=true', () => {
    const db = freshLegacyDb();
    // 目标是一个 node_id 而非同链 revision
    legacyInsert(db, { node_id: 'mem-9', revision_id: 'rev-9-1' });
    legacyInsertSuperseded(db, { node_id: 'mem-1', revision_id: 'rev-1-1', superseded_by: 'mem-9', seq: 1 });
    const p = preflight(db, {});
    expect(p.supersededAmbiguous.length).toBeGreaterThan(0);
    expect(p.blocking).toBe(true);
    db.close();
  });

  it('superseded 悬空（旧值无匹配）→ supersededDangling + blocking=true', () => {
    const db = freshLegacyDb();
    legacyInsertSuperseded(db, { node_id: 'mem-1', revision_id: 'rev-1-1', superseded_by: 'rev-404', seq: 1 });
    const p = preflight(db, {});
    expect(p.supersededDangling.length).toBeGreaterThan(0);
    expect(p.blocking).toBe(true);
    db.close();
  });

  it('旧数据无映射且未接受默认 → unmappedRevisions + blocking=true', () => {
    const db = freshLegacyDb();
    legacyInsert(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });
    const p = preflight(db, { legacyOwnerId: 'u' }); // 有 owner 仍缺映射
    expect(p.unmappedRevisions).toEqual(['rev-1-1']);
    expect(p.blocking).toBe(true);
    db.close();
  });

  it('接受默认映射 + 提供 owner → unmapped 不阻断', () => {
    const db = freshLegacyDb();
    legacyInsert(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });
    const p = preflight(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true });
    expect(p.unmappedRevisions.length).toBeGreaterThan(0);
    expect(p.blocking).toBe(false);
    db.close();
  });

  it('提供完整映射 → blocking=false', () => {
    const db = freshLegacyDb();
    legacyInsert(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });
    const p = preflight(db, {
      legacyOwnerId: 'u',
      legacyScopeManifest: { 'rev-1-1': { layer: 'global', visibility: 'all_agents' } },
    });
    expect(p.unmappedRevisions).toEqual([]);
    expect(p.blocking).toBe(false);
    db.close();
  });
});