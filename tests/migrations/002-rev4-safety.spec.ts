/** Migration 002 Rev4 —— 新增：归档字段保全、Scope 显式映射、环检测（任务 A1/A2/A3）
 *
 *  这三类问题在 Rev3 中都存在：
 *  - A1：MINIMIZED 的 minimized_blob_ref / minimized_blob_hash 未被复制 → 归档引用丢失
 *  - A2：旧记录一律归入 project/default-project → 可能把私有记忆错误共享
 *  - A3：历史 Revision 环只在成环后才由 UPDATE 触发器拦住 → 历史数据本身可能已坏
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { getRevision } from '../helpers/db.ts';

const prov = JSON.stringify({
  agent_id: 'agent-legacy',
  origin: 'hot-path',
  method: 'rule',
  source_refs: [],
  producer_version: 'hetu 0.0.9',
  model_id: null,
  generated_at: '2026-11-01T00:00:00Z',
  confidence: 0.7,
});

interface LegacyRow {
  node_id: string;
  revision_id: string;
  sequence?: number;
  versionState?: string;
  contentState?: string;
  superseded_by?: string | null;
  minimizedRef?: string | null;
  minimizedHash?: string | null;
}

function insertLegacy(db: InstanceType<typeof DatabaseSync>, r: LegacyRow): void {
  db.prepare(
    `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
      content_state, content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash,
      modality, confidence, provenance, valid_from, valid_until, ingested_at, superseded_by)
     VALUES(?,?,?,?,?,?,?,?,?,?, 'text', 0.7, ?, '2026-11-01T00:00:00Z', NULL,
       '2026-11-01T00:00:00Z', ?)`
  ).run(
    r.node_id,
    r.revision_id,
    r.sequence ?? 1,
    'sha256:' + r.revision_id.padEnd(60, '0').slice(0, 60),
    r.versionState ?? 'CURRENT',
    r.contentState ?? 'FULL',
    r.contentState === 'MINIMIZED' ? null : `blobs/legacy/${r.revision_id}.txt`,
    r.contentState === 'MINIMIZED' ? '精简摘要' : null,
    r.minimizedRef ?? null,
    r.minimizedHash ?? null,
    prov,
    r.superseded_by ?? null
  );
}

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db, { target: 1 });
});

describe('A1 — MINIMIZED 归档信息不丢失', () => {
  const archRef = 'archive/mem-1/rev-1-1.txt';
  const archHash = 'sha256:' + 'a'.repeat(64);

  it('MINIMIZED 记录升级后归档引用与 Hash 一致', () => {
    insertLegacy(db, {
      node_id: 'mem-1',
      revision_id: 'rev-1-1',
      contentState: 'MINIMIZED',
      minimizedRef: archRef,
      minimizedHash: archHash,
    });

    runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true });

    const row = getRevision(db, 'rev-1-1');
    expect(row.content_state).toBe('MINIMIZED');
    expect(row.minimized_blob_ref).toBe(archRef);
    expect(row.minimized_blob_hash).toBe(archHash);
    expect(row.stub_summary).toBe('精简摘要');
  });

  it('FULL / STUB 状态也完整保留（无静默数据损失）', () => {
    insertLegacy(db, { node_id: 'mem-f', revision_id: 'rev-f-1', contentState: 'FULL' });
    insertLegacy(db, { node_id: 'mem-s', revision_id: 'rev-s-1', contentState: 'STUB' });

    runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true });

    expect(getRevision(db, 'rev-f-1').content_ref).toBe('blobs/legacy/rev-f-1.txt');
    expect(getRevision(db, 'rev-s-1').content_state).toBe('STUB');
  });

  it('Down → Up 后归档信息仍一致', async () => {
    insertLegacy(db, {
      node_id: 'mem-1',
      revision_id: 'rev-1-1',
      contentState: 'MINIMIZED',
      minimizedRef: archRef,
      minimizedHash: archHash,
    });
    runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true });
    const { rollbackTo } = await import('../../src/storage/migrate.ts');
    rollbackTo(db, 1);
    runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true });

    const row = getRevision(db, 'rev-1-1');
    expect(row.minimized_blob_ref).toBe(archRef);
    expect(row.minimized_blob_hash).toBe(archHash);
  });
});

describe('A2 — 旧数据归属必须显式映射（不得默认全部塞进 project）', () => {
  it('无映射且未声明 acceptDefaultScopeMapping → 中止并列出待映射记录', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });

    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user-legacy' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/缺少显式 Scope 映射/);
    expect(err!.message).toMatch(/rev-1-1/);
    expect(err!.message).toMatch(/legacyScopeManifest/);
  });

  it('提供 manifest → 按映射写入各自的 layer / visibility / agent', () => {
    insertLegacy(db, { node_id: 'mem-p', revision_id: 'rev-p-1' });
    insertLegacy(db, { node_id: 'mem-a', revision_id: 'rev-a-1' });

    runMigrations(db, {
      legacyOwnerId: 'user-legacy',
      legacyScopeManifest: {
        'rev-p-1': { layer: 'project', project_id: 'proj-x', visibility: 'project_agents' },
        'rev-a-1': {
          layer: 'private_annotation',
          agent_id: 'agent-a',
          visibility: 'owner',
        },
      },
    });

    const p = getRevision(db, 'rev-p-1');
    expect(p.layer).toBe('project');
    expect(p.project_id).toBe('proj-x');

    const a = getRevision(db, 'rev-a-1');
    expect(a.layer).toBe('private_annotation');
    expect(a.agent_id).toBe('agent-a');
    expect(a.visibility).toBe('owner'); // 私有注解必须 owner-only
  });

  it('manifest 中的 private_annotation 若 visibility≠owner → 被 DB 约束拒绝（迁移失败）', () => {
    insertLegacy(db, { node_id: 'mem-a', revision_id: 'rev-a-1' });

    expect(() =>
      runMigrations(db, {
        legacyOwnerId: 'user-legacy',
        legacyScopeManifest: {
          'rev-a-1': {
            layer: 'private_annotation',
            agent_id: 'agent-a',
            visibility: 'all_agents', // 违反私有约束
          },
        },
      })
    ).toThrow(/CHECK|constraint/);
  });

  it('dryRun → 只报告不修改数据库', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });

    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user-legacy', dryRun: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/DRY_RUN_REPORT/);

    // 数据库未被改动：仍是 001 结构
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name);
    expect(cols).not.toContain('owner_id');
    expect((db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c).toBe(1);
  });

  it('全部映射齐全时不需要 acceptDefaultScopeMapping', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1-1' });
    expect(() =>
      runMigrations(db, {
        legacyOwnerId: 'user-legacy',
        legacyScopeManifest: {
          'rev-1-1': { layer: 'global', visibility: 'all_agents' },
        },
      })
    ).not.toThrow();
  });
});

describe('A3 — 历史 Revision 环检测（迁移前，非迁移后触发器）', () => {
  it('旧数据成环 → 迁移中止并报告环路径', () => {
    insertLegacy(db, {
      node_id: 'mem-1', revision_id: 'rev-1-1', sequence: 1,
      versionState: 'SUPERSEDED', superseded_by: 'rev-1-2',
    });
    insertLegacy(db, {
      node_id: 'mem-1', revision_id: 'rev-1-2', sequence: 2, contentState: 'FULL',
      versionState: 'SUPERSEDED', superseded_by: 'rev-1-1', // 成环
    });

    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/MIGRATION_ABORTED/);
    expect(err!.message).toMatch(/cycle/);
  });

  it('正常链（无环）→ 迁移通过', () => {
    insertLegacy(db, {
      node_id: 'mem-1', revision_id: 'rev-1-1', sequence: 1,
      versionState: 'SUPERSEDED', superseded_by: 'rev-1-2',
    });
    insertLegacy(db, {
      node_id: 'mem-1', revision_id: 'rev-1-2', sequence: 2, contentState: 'FULL',
    });

    expect(() =>
      runMigrations(db, { legacyOwnerId: 'user-legacy', acceptDefaultScopeMapping: true })
    ).not.toThrow();
    expect(getRevision(db, 'rev-1-1').superseded_by_revision).toBe('rev-1-2');
  });
});

describe('P1-C — dryRun 在任何条件下都不得写库', () => {
  it('完整 manifest + dryRun → 仍只报告，数据库完全不变', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1' });
    const before = {
      cols: (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name),
      rows: (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c,
      migrations: (db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c,
    };

    let err: Error | null = null;
    try {
      runMigrations(db, {
        legacyOwnerId: 'user-legacy',
        dryRun: true,
        legacyScopeManifest: {
          'rev-1': { layer: 'project', project_id: 'p1', visibility: 'project_agents' },
        },
      });
    } catch (e) {
      err = e as Error;
    }

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/DRY_RUN_REPORT/);
    expect(err!.message).toMatch(/未执行任何数据库写操作/);

    const after = {
      cols: (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name),
      rows: (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c,
      migrations: (db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c,
    };
    expect(after).toEqual(before);
  });

  it('acceptDefaultScopeMapping + dryRun → 仍不写库', () => {
    insertLegacy(db, { node_id: 'mem-1', revision_id: 'rev-1' });
    let err: Error | null = null;
    try {
      runMigrations(db, {
        legacyOwnerId: 'user-legacy',
        acceptDefaultScopeMapping: true,
        dryRun: true,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/DRY_RUN_REPORT/);

    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name);
    expect(cols).not.toContain('owner_id');
  });

  it('空库 + dryRun → 报告并在不写库的情况下返回', () => {
    let err: Error | null = null;
    try {
      runMigrations(db, { dryRun: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/DRY_RUN_REPORT/);
    expect((db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c).toBe(1);
  });
});
