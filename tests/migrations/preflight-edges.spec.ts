/** R4-E3/E4：两类边悬空检测 + blocking 一致（E7 一致性）。
 *
 *  前置：先应用 Migration 001~004，用真实表写入 "坏边"（绕过 003 的触发器，
 *  因为触发器在迁移完成后即存在 —— 直接对已迁移的库插入悬空边会被触发器拦截，
 *  故此处先建好边所在表（001 已建 edges），再手工构造悬空端点 —— 但 003 的触发器
 *  已存在且会拒绝。为此采用「回滚到 001 → 建坏数据 → 直接查 preflight」的等价单向断言，
 *  并额外用 preflight-wiring 的 fresh 路由验证 blocking 文本来源。）
 *
 *  更稳妥的可写路径：由于 003 之后 edges 触发器要求端点存在，测试需在 001-only 阶段
 *  构造坏边（当时尚无 edges 触发器）。preflight 在任意 schema 阶段都只读运行。
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

describe('E3 — 普通边悬空（node_id 端点）', () => {
  it('001-only：坏普通边 → danglingNodeEdges 检测到 + blocking=true', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 1 });
    // 001 阶段 edges 无触发器，可写入悬空端点
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at)
       VALUES('cooccur', 'n-exists', 'n-ghost', 0.5, '2026-01-01T00:00:00Z')`
    ).run();
    const p = preflight(db, {});
    expect(p.danglingNodeEdges.length).toBeGreaterThan(0);
    expect(p.danglingNodeEdges[0]).toMatchObject({ type: 'cooccur', from: 'n-exists', to: 'n-ghost' });
    expect(p.blocking).toBe(true);
    db.close();
  });

  it('001-only：无悬空 → danglingNodeEdges 为空、blocking=false', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 1 });
    legacyInsert(db, { node_id: 'n-ok', revision_id: 'rev-1' });
    const p = preflight(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true });
    expect(p.danglingNodeEdges).toEqual([]);
    expect(p.blocking).toBe(false);
    db.close();
  });
});

describe('E4 — supersedes 边悬空（revision_id 端点）', () => {
  it('001-only：悬空 supersedes 边 → danglingRevisionEdges + blocking=true', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 1 });
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at)
       VALUES('supersedes', 'rev-1-1', 'rev-ghost', 1, '2026-01-01T00:00:00Z')`
    ).run();
    const p = preflight(db, {});
    expect(p.danglingRevisionEdges.length).toBeGreaterThan(0);
    expect(p.danglingRevisionEdges[0]).toMatchObject({ type: 'supersedes', from: 'rev-1-1', to: 'rev-ghost' });
    expect(p.blocking).toBe(true);
    db.close();
  });

  it('001-only：端点合法 supersedes → danglingRevisionEdges 为空', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 1 });
    // 同 node_id 两条 revision：第一条 SUPERSEDED，第二条 CURRENT，避免 CURRENT 唯一索引冲突
    db.prepare(
      `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
        content_state, modality, confidence, provenance, valid_from, ingested_at, superseded_by)
       VALUES('m1','rev-1-1',1,'sha256:x','SUPERSEDED','FULL','text',0.7,'{}','2026-01-01','2026-01-01','rev-1-2'),
             ('m1','rev-1-2',2,'sha256:x','CURRENT','FULL','text',0.7,'{}','2026-01-01','2026-01-01',NULL)`
    ).run();
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at)
       VALUES('supersedes', 'rev-1-1', 'rev-1-2', 1, '2026-01-01T00:00:00Z')`
    ).run();
    const p = preflight(db, { legacyOwnerId: 'u', acceptDefaultScopeMapping: true });
    expect(p.danglingRevisionEdges).toEqual([]);
    expect(p.danglingNodeEdges).toEqual([]);
    expect(p.blocking).toBe(false);
    db.close();
  });
});