/** Review R3 补充验收：Edge/Outbox 授权、Dry Run 共享检查、visibility=owner 语义。
 *
 *  R3-05：Edge 两端必须属于当前授权范围；Outbox entity 必须匹配写入对象。
 *  R3-06：Dry Run 与真实迁移共用同一套只读前置检查（环 + 悬空边）。
 *  R3-07：visibility='owner' 在 Project 层语义明确。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { BlobStore, sha256 } from '../../src/storage/blob-store.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import type { AuthContext } from '../../src/auth/context.ts';
import {
  asNodeId,
  asRevisionId,
  asContentHash,
  type MemoryNode,
  type Scope,
  type Edge,
} from '../../src/storage/types.ts';

const scopeOf = (over: Partial<Scope> = {}): Scope => ({
  owner_id: 'ws-1',
  layer: 'project',
  project_id: 'proj-1',
  agent_id: null,
  visibility: 'project_agents',
  shared_with: [],
  ...over,
});

const authA: AuthContext = {
  ownerId: 'ws-1',
  agentId: 'agent-a',
  projectIds: ['proj-1'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:supersede', 'memory:minimize', 'memory:revive', 'memory:purge'],
};

const authB: AuthContext = {
  ownerId: 'ws-1',
  agentId: 'agent-b',
  projectIds: ['proj-2'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write'],
};

function node(nid: string, rid: string, over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: asNodeId(nid),
    revision_id: asRevisionId(rid),
    revision_sequence: over.revision_sequence ?? 1,
    content_hash: over.content_hash ?? asContentHash('sha256:' + 'a'.repeat(64)),
    version_state: 'CURRENT',
    content_state: 'FULL',
    content_ref: over.content_ref ?? null,
    stub_summary: null,
    minimized_blob_ref: null,
    minimized_blob_hash: null,
    modality: 'text',
    confidence: 0.9,
    provenance: {
      agent_id: 'agent-a',
      origin: 'hot-path' as const,
      method: 'user-confirmed' as const,
      source_refs: [],
      producer_version: 'hetu 0.3.0',
      model_id: null,
      generated_at: '2026-11-27T00:00:00Z',
      confidence: 0.9,
    },
    scope: scopeOf(over.scope ?? ({} as Partial<Scope>)),
    sensitivity: over.sensitivity ?? 'normal',
    valid_from: '2026-11-27T00:00:00Z',
    valid_until: null,
    ingested_at: '2026-11-27T00:00:00Z',
    superseded_by: null,
  };
}

let sp: SqliteStorageProvider;
let blobRoot: string;
beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-r3b-'));
  sp = new SqliteStorageProvider({ dbPath: ':memory:', blobRoot });
  runMigrations(sp.raw);
});
afterEach(() => {
  sp.close();
  rmSync(blobRoot, { recursive: true, force: true });
});

// ───────────────────────── R3-05 · Edge / Outbox 授权 ─────────────────────────

describe('R3-05 · Edge 写入授权', () => {
  it('不能连接其他工作空间的节点', async () => {
    await sp.put(node('my-1', 'r-mine'), [], [], authA);
    // 其他工作空间节点（用 authB 的同 owner 无法代表，改用对象 owner=ws-other）
    await sp.put(
      node('other-1', 'r-other', { scope: scopeOf({ owner_id: 'ws-other' }) }),
      [],
      [],
      { ...authA, ownerId: 'ws-other', projectIds: ['proj-1'] }
    );

    const bad: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: asNodeId('my-1'),
      to: asNodeId('other-1'),
      weight: 0.5,
      created_at: '2026-11-27T00:00:00Z',
    };
    const r = await sp.put(node('my-1x', 'r-mine-x'), [bad], [], authA);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('不能连接其他 Agent 的私有 persona', async () => {
    // Agent B 的私有 persona
    await sp.put(
      node('persona-b', 'r-pb', {
        scope: scopeOf({ layer: 'agent_persona', agent_id: 'agent-b', project_id: null, visibility: 'owner' }),
      }),
      [],
      [],
      { ...authB, projectIds: [] }
    );
    await sp.put(node('my-1', 'r-mine'), [], [], authA);

    const bad: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: asNodeId('my-1'),
      to: asNodeId('persona-b'),
      weight: 0.5,
      created_at: '2026-11-27T00:00:00Z',
    };
    const r = await sp.put(node('my-1x', 'r-mine-x'), [bad], [], authA);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('不能连接不同项目的节点', async () => {
    await sp.put(node('p1-1', 'r-p1', { scope: scopeOf({ project_id: 'proj-1' }) }), [], [], authA);
    await sp.put(
      node('p2-1', 'r-p2', { scope: scopeOf({ project_id: 'proj-2' }) }),
      [],
      [],
      { ...authA, projectIds: ['proj-2'] }
    );

    const bad: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: asNodeId('p1-1'),
      to: asNodeId('p2-1'),
      weight: 0.5,
      created_at: '2026-11-27T00:00:00Z',
    };
    // authA 只属 proj-1，对 proj-2 节点不可见 → 拒绝
    const r = await sp.put(node('p1-2', 'r-p1-2'), [bad], [], authA);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('同一工作空间的可见节点可正常连接', async () => {
    await sp.put(node('n1', 'rn1'), [], [], authA);
    await sp.put(node('n2', 'rn2'), [], [], authA);
    const okEdge: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: asNodeId('n1'),
      to: asNodeId('n2'),
      weight: 0.5,
      created_at: '2026-11-27T00:00:00Z',
    };
    const r = await sp.put(node('n3', 'rn3'), [okEdge], [], authA);
    expect(r.ok).toBe(true);
  });
});

describe('R3-05 · Outbox entity 授权', () => {
  it('entity 与写入对象无关 → 拒绝', async () => {
    const r = await sp.put(node('n1', 'rn1'), [], [{ kind: 'index', entity_id: 'some-other-entity', seq: 1 }], authA);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('entity = 节点自身 / 项目 / 工作空间 → 允许', async () => {
    const ok1 = await sp.put(node('n1', 'rn1'), [], [{ kind: 'index', entity_id: 'n1', seq: 1 }], authA);
    expect(ok1.ok).toBe(true);
    const ok2 = await sp.put(node('n2', 'rn2'), [], [{ kind: 'index', entity_id: 'proj-1', seq: 1 }], authA);
    expect(ok2.ok).toBe(true);
  });
});

// ───────────────────────── R3-06 · Dry Run 共享检查 ─────────────────────────

describe('R3-06 · Dry Run 报告阻断项与真实迁移一致', () => {
  function legacyInsertSuperseded(db: InstanceType<typeof DatabaseSync>, r: {
    node_id: string; revision_id: string; superseded_by?: string | null; seq?: number;
  }) {
    db.prepare(
      `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
        content_state, modality, confidence, provenance, valid_from, ingested_at, superseded_by)
       VALUES(?,?,?,?, 'SUPERSEDED', 'FULL', 'text', 0.7, '{}', '2026-01-01', '2026-01-01', ?)`
    ).run(r.node_id, r.revision_id, r.seq ?? 1, 'sha256:x', r.superseded_by ?? null);
  }

  function legacyInsert(db: InstanceType<typeof DatabaseSync>, r: {
    node_id: string; revision_id: string; superseded_by?: string | null;
  }) {
    db.prepare(
      `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
        content_state, modality, confidence, provenance, valid_from, ingested_at, superseded_by)
       VALUES(?,?,?,?, 'CURRENT', 'FULL', 'text', 0.7, '{}', '2026-01-01', '2026-01-01', ?)`
    ).run(r.node_id, r.revision_id, 1, 'sha256:x', r.superseded_by ?? null);
  }

  it('Dry Run 检测到历史环时报告，真实迁移也中止', async () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 1 });

    // 构造环：rev-a -> rev-b -> rev-a
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-a', superseded_by: 'rev-b', seq: 1 });
    legacyInsertSuperseded(db, { node_id: 'm1', revision_id: 'rev-b', superseded_by: 'rev-a', seq: 2 });

    const report = runMigrations(db, { dryRun: true }) as any;
    expect(report.kind).toBe('DRY_RUN_REPORT');
    expect(report.cycles.length).toBeGreaterThan(0);

    // 真实迁移也应中止
    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user', acceptDefaultScopeMapping: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/MIGRATION_ABORTED/);
    db.close();
  });

  it('Dry Run 与真实迁移对 superseded 歧义同样报告', async () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, { target: 1 });
    // 目标确实是一个 node_id（跨版本歧义）：需要存在一个同 id 的节点才构成歧义
    db.prepare(
      `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
        content_state, modality, confidence, provenance, valid_from, ingested_at)
       VALUES('some-node-id','rev-target',1,'sha256:y','CURRENT','FULL','text',0.7,'{}','2026-01-01','2026-01-01')`
    ).run();
    legacyInsert(db, { node_id: 'm1', revision_id: 'rev-a', superseded_by: 'some-node-id' });

    const report = runMigrations(db, { dryRun: true }) as any;
    expect(report.ambiguous.length).toBeGreaterThan(0);

    let err: Error | null = null;
    try {
      runMigrations(db, { legacyOwnerId: 'user', acceptDefaultScopeMapping: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    db.close();
  });
});

// ───────────────────────── R3-07 · visibility=owner 语义 ─────────────────────────

describe('R3-07 · visibility=owner 在 Project 层语义', () => {
  it('project 层 + visibility=owner：项目成员可读（owner 是工作空间边界，非记录创建者）', async () => {
    await sp.put(
      node('doc-1', 'r-doc', {
        scope: scopeOf({ layer: 'project', project_id: 'proj-1', visibility: 'owner' }),
      }),
      [],
      [],
      authA
    );
    // 另一个 proj-1 成员（agent-c），CanRead 应该看到（owner 语义 = 项目内可见，由成员关系约束）
    const authC: AuthContext = { ...authA, agentId: 'agent-c' };
    const hits = await sp.query({}, authC);
    expect(hits.some(h => h.node_id === 'doc-1')).toBe(true);
  });

  it('persona 层 + visibility=owner 只有本人可见（owner = Agent 本人），非成员 C 不可见', async () => {
    await sp.put(
      node('persona-a', 'r-pa', {
        scope: scopeOf({ layer: 'agent_persona', agent_id: 'agent-a', project_id: null, visibility: 'owner' }),
      }),
      [],
      [],
      authA
    );
    const authC: AuthContext = { ...authA, agentId: 'agent-c' };
    expect((await sp.query({}, authC)).some(h => h.node_id === 'persona-a')).toBe(false);
    expect((await sp.query({}, authA)).some(h => h.node_id === 'persona-a')).toBe(true);
  });
});