/** Migration 002 Rev3 —— 旧数据升级兼容（任务 A7 / B6）
 *
 *  真实场景：先只跑到 Migration 001（M0 结构），写入旧格式记录（无 scope 列、
 *  superseded_by 为旧语义），再执行 Migration 002。
 *  断言：旧数据完整保留、关系不丢失、Scope 合法；无法安全转换时明确中止并列出记录。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { getRevision } from '../helpers/db.ts';

const legacyProvenance = JSON.stringify({
  agent_id: 'agent-legacy',
  origin: 'hot-path',
  method: 'rule',
  source_refs: [],
  producer_version: 'hetu 0.0.9',
  model_id: null,
  generated_at: '2026-11-01T00:00:00Z',
  confidence: 0.7,
});

/** 在 001 结构上插入一条旧格式记录（无 scope 列） */
function insertLegacy(
  db: InstanceType<typeof DatabaseSync>,
  r: {
    node_id: string;
    revision_id: string;
    sequence?: number;
    superseded_by?: string | null;
    contentState?: string;
    versionState?: string;
  }
): void {
  db.prepare(
    `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
      content_state, content_ref, stub_summary, modality, confidence, provenance,
      valid_from, valid_until, ingested_at, superseded_by)
     VALUES(?,?,?,?, ?, ?, ?, NULL, 'text', 0.7, ?, '2026-11-01T00:00:00Z', NULL,
       '2026-11-01T00:00:00Z', ?)`
  ).run(
    r.node_id,
    r.revision_id,
    r.sequence ?? 1,
    'sha256:' + r.revision_id.padEnd(64, '0').slice(0, 64),
    r.versionState ?? 'CURRENT',
    r.contentState ?? 'FULL',
    `blobs/legacy/${r.revision_id}.txt`,
    legacyProvenance,
    r.superseded_by ?? null
  );
}

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db, { target: 1 }); // 只到 Migration 001 = M0 结构
});

describe('Migration 002 Rev3 — 旧数据库升级', () => {
  it('M0 数据 → 002：数据完整保留且 Scope 合法（显式指定 owner）', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });
    insertLegacy(db, { node_id: 'mem-2', revision_id: 'rev-2-1' });

    const { applied } = runMigrations(db, { legacyOwnerId: 'user-legacy' });
    expect(applied).toContain(2);

    expect((db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c).toBe(2);

    const r1 = getRevision(db, 'rev-1-1');
    expect(r1.owner_id).toBe('user-legacy');
    expect(r1.layer).toBe('project');
    expect(r1.visibility).toBe('project_agents');
    expect(r1.content_hash).toBe('sha256:' + 'rev-1-1'.padEnd(64, '0').slice(0, 64));
    expect(r1.provenance).toBe(legacyProvenance); // provenance 原样保留
  });

  it('旧 superseded_by（RevisionId 语义，可无歧义匹配）→ 迁入 superseded_by_revision，关系不丢失', () => {
    insertLegacy(db, {
      node_id: 'mem-1', revision_id: 'rev-1-1', superseded_by: 'rev-1-2', versionState: 'SUPERSEDED',
    });
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-2', sequence: 2 });

    runMigrations(db, { legacyOwnerId: 'user-legacy' });

    const v1 = getRevision(db, 'rev-1-1');
    expect(v1.superseded_by_revision).toBe('rev-1-2');
    expect(v1.superseded_by).toBeNull(); // 旧列已清空（废弃策略）
  });

  it('旧 superseded_by 存的是 NodeId（跨版本歧义）→ 中止迁移并列出记录', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1', superseded_by: 'mem-9' });
    insertLegacy(db, { node_id: 'mem-9', revision_id: 'rev-9-1' });

    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user-legacy' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/MIGRATION_ABORTED/);
    expect(err!.message).toMatch(/AMBIGUOUS/);
    expect(err!.message).toMatch(/rev-1-1/); // 列出待处理记录

    // 中止后仍是 001 结构，未留半迁移状态
    expect((db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c).toBe(1);
  });

  it('旧 superseded_by 悬空（匹配不到任何 revision）→ 中止迁移并列出记录', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1', superseded_by: 'rev-404' });

    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user-legacy' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/DANGLING/);
    expect(err!.message).toMatch(/rev-404/);
  });

  it('存在旧数据但未指定 owner → 中止，不擅自归入某个用户', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });

    let err: Error | null = null;
    try {
      runMigrations(db); // 未提供 legacyOwnerId
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/MIGRATION_ABORTED/);
    expect(err!.message).toMatch(/owner/);
    expect(err!.message).toMatch(/rev-1-1/); // 待处理清单

    // 迁移未应用，未静默分配 owner
    expect((db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c).toBe(1);
    expect(db.prepare('PRAGMA table_info(nodes)').all() as unknown[]).toBeTruthy();
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name);
    expect(cols).not.toContain('owner_id');
  });

  it('空数据库升级不需要 legacyOwnerId', () => {
    const { applied } = runMigrations(db);
    expect(applied).toContain(2);
    expect((db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c).toBe(0);
  });
});
