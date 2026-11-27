/** Review R2 · 端到端数据安全测试（大师明确要求"两个真实身份不同的 Agent"）
 *
 *  设计原则：
 *  - 不使用测试辅助直写 SQL，全部通过真实 `SqliteStorageProvider` 接口
 *  - 两个身份（Agent A / Agent B）使用各自 AuthContext，对**同一批记忆**做读、写、改、删
 *  - 每个操作都断言"允许"与"拒绝"两侧，避免只测 happy path
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../../src/storage/types.ts';

const provenance = (agent: string) => ({
  agent_id: agent,
  origin: 'hot-path' as const,
  method: 'user-confirmed' as const,
  source_refs: [],
  producer_version: 'hetu 0.2.0',
  model_id: null,
  generated_at: '2026-11-27T00:00:00Z',
  confidence: 0.9,
});

const baseScope = (over: Partial<Scope> = {}): Scope => ({
  owner_id: 'ws-acme',
  layer: 'project',
  project_id: 'proj-apollo',
  agent_id: null,
  visibility: 'project_agents',
  shared_with: [],
  ...over,
});

/** Agent A：proj-apollo 成员，全能力 */
const A: AuthContext = {
  ownerId: 'ws-acme',
  agentId: 'agent-a',
  projectIds: ['proj-apollo'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:supersede', 'memory:minimize', 'memory:revive', 'memory:purge'],
};

/** Agent B：proj-apollo 成员，但无 purge 能力、敏感级上限 normal */
const B: AuthContext = {
  ownerId: 'ws-acme',
  agentId: 'agent-b',
  projectIds: ['proj-apollo'],
  canReadGlobal: true,
  maxSensitivity: 'normal',
  capabilities: ['memory:write', 'memory:supersede'],
};

/** Agent C：非 proj-apollo 成员 */
const C: AuthContext = {
  ownerId: 'ws-acme',
  agentId: 'agent-c',
  projectIds: ['proj-other'],
  canReadGlobal: false,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:supersede'],
};

/** 外部工作空间的 Agent D */
const D: AuthContext = {
  ownerId: 'ws-other',
  agentId: 'agent-d',
  projectIds: ['proj-apollo'], // 即使在同名项目里，owner 不同也隔离
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:supersede'],
};

function node(
  nodeId: string,
  revisionId: string,
  scope: Partial<Scope>,
  over: Partial<MemoryNode> = {}
): MemoryNode {
  return {
    node_id: asNodeId(nodeId),
    revision_id: asRevisionId(revisionId),
    revision_sequence: over.revision_sequence ?? 1,
    content_hash: over.content_hash ?? asContentHash('sha256:' + 'a'.repeat(64)),
    version_state: over.version_state ?? 'CURRENT',
    content_state: over.content_state ?? 'FULL',
    content_ref: over.content_ref ?? null,
    stub_summary: over.stub_summary ?? null,
    minimized_blob_ref: null,
    minimized_blob_hash: null,
    modality: 'text',
    confidence: 0.9,
    provenance: over.provenance ?? provenance('agent-a'),
    scope: baseScope(scope),
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
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-e2e-'));
  sp = new SqliteStorageProvider({ dbPath: ':memory:', blobRoot });
  runMigrations(sp.raw);
});
afterEach(() => {
  sp.close();
  rmSync(blobRoot, { recursive: true, force: true });
});

describe('E2E · 项目共享记忆：三身份对同一批数据的读权限', () => {
  beforeEach(async () => {
    // Agent A 写入 3 条项目记忆
    await sp.put(node('shared-1', 'rs1', { visibility: 'project_agents' }), [], [], A);
    await sp.put(
      node('shared-2', 'rs2', { visibility: 'shared_list', shared_with: ['agent-a'] }),
      [],
      [],
      A
    );
    await sp.put(node('secret-1', 'rx1', { visibility: 'project_agents' }, { sensitivity: 'restricted' }), [], [], A);
  });

  it('项目成员 B 能读到 project_agents 共享记忆', async () => {
    const hits = await sp.query({}, B);
    expect(hits.some(h => h.node_id === 'shared-1')).toBe(true);
  });

  it('B 读不到 shared_list 里没列他的记忆（项目成员 ≠ 白名单成员）', async () => {
    expect((await sp.query({}, B)).some(h => h.node_id === 'shared-2')).toBe(false);
    expect(await sp.get({ kind: 'revision', revisionId: asRevisionId('rs2') }, B)).toBeNull();
  });

  it('B（敏感级 normal）读不到 restricted 记忆', async () => {
    expect((await sp.query({}, B)).some(h => h.node_id === 'secret-1')).toBe(false);
  });

  it('A（敏感级 restricted）能读到全部三条', async () => {
    const hits = await sp.query({}, A);
    expect(hits.map(h => h.node_id).sort()).toEqual(['secret-1', 'shared-1', 'shared-2']);
  });

  it('非项目成员 C 一条都读不到', async () => {
    expect(await sp.query({}, C)).toEqual([]);
  });

  it('外部工作空间 D（即便项目名相同）一条都读不到', async () => {
    expect(await sp.query({}, D)).toEqual([]);
  });
});

describe('E2E · 人格与私人注解：只有本人可见', () => {
  beforeEach(async () => {
    await sp.put(
      node('persona-a', 'rpa', { layer: 'agent_persona', agent_id: 'agent-a', project_id: null, visibility: 'owner' }),
      [],
      [],
      A
    );
    await sp.put(
      node('note-a', 'rna', { layer: 'private_annotation', agent_id: 'agent-a', project_id: null, visibility: 'owner' }),
      [],
      [],
      A
    );
  });

  it('A 能看到自己的 persona 与注解', async () => {
    const ids = (await sp.query({}, A)).map(h => h.node_id);
    expect(ids).toContain('persona-a');
    expect(ids).toContain('note-a');
  });

  it('B（同项目、同工作空间）两条都看不到', async () => {
    const ids = (await sp.query({}, B)).map(h => h.node_id);
    expect(ids).not.toContain('persona-a');
    expect(ids).not.toContain('note-a');
    expect(await sp.get({ kind: 'revision', revisionId: asRevisionId('rpa') }, B)).toBeNull();
  });

  it('B 不能替 A 写 persona（写入被拒）', async () => {
    const r = await sp.put(
      node('persona-a-2', 'rpa2', { layer: 'agent_persona', agent_id: 'agent-a', project_id: null, visibility: 'owner' }),
      [],
      [],
      B
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });
});

describe('E2E · 同一批记忆的写、改、删权限矩阵', () => {
  let contentHash: string;

  beforeEach(async () => {
    const blobs = new BlobStore(blobRoot);
    const content = '项目决议：采用方案 B。';
    contentHash = await blobs.write(BlobStore.mainRefFor(sha256(Buffer.from(content))), content);
    await sp.put(
      node('decision-1', 'rd1', {}, { content_hash: asContentHash(contentHash), content_ref: BlobStore.mainRefFor(contentHash) }),
      [],
      [],
      A
    );
  });

  it('B（项目成员）可以写入新记忆', async () => {
    const r = await sp.put(node('decision-2', 'rd2'), [], [], B);
    expect(r.ok).toBe(true);
  });

  it('C（非成员）写入被拒', async () => {
    const r = await sp.put(node('decision-3', 'rd3'), [], [], C);
    expect(r.ok).toBe(false);
  });

  it('D（外部工作空间）写入被拒', async () => {
    const r = await sp.put(node('decision-4', 'rd4'), [], [], D);
    expect(r.ok).toBe(false);
  });

  it('B 可以 supersede（有 memory:supersede 能力）', async () => {
    const r = await sp.put(
      node('decision-1', 'rd1-v2', {}, { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'b'.repeat(64)) }),
      [],
      [],
      B,
      { expectedRevision: asRevisionId('rd1') }
    );
    expect(r.ok).toBe(true);
  });

  it('C 尝试 supersede 被拒', async () => {
    const r = await sp.put(
      node('decision-1', 'rd1-v3', {}, { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'c'.repeat(64)) }),
      [],
      [],
      C,
      { expectedRevision: asRevisionId('rd1') }
    );
    expect(r.ok).toBe(false);
  });

  it('B 无 memory:purge → purge 被拒；A 有 → 成功且记录操作者', async () => {
    const denied = await sp.purge(asNodeId('decision-1'), B, 'gdpr', {
      expectedRevision: asRevisionId('rd1'),
    });
    expect(denied.ok).toBe(false);

    const ok = await sp.purge(asNodeId('decision-1'), A, 'gdpr', {
      expectedRevision: asRevisionId('rd1'),
    });
    expect(ok.ok).toBe(true);
    const op = sp.raw.prepare('SELECT operator FROM purge_ledger').get() as { operator: string };
    expect(op.operator).toBe('agent-a');
  });

  it('Purge 后 B 也读不到（跨身份一致）', async () => {
    await sp.purge(asNodeId('decision-1'), A, 'gdpr', { expectedRevision: asRevisionId('rd1') });
    expect(await sp.get({ kind: 'revision', revisionId: asRevisionId('rd1') }, B)).toBeNull();
    expect((await sp.query({}, B)).some(h => h.node_id === 'decision-1')).toBe(false);
  });
});

describe('E2E · 跨会话召回一致性（同一身份多次查询结果稳定）', () => {
  it('A 连续查询三次结果一致，且不含他人私有内容', async () => {
    await sp.put(node('p1', 'rp1', { visibility: 'project_agents' }), [], [], A);
    await sp.put(
      node('note-b', 'rnb', { layer: 'private_annotation', agent_id: 'agent-b', project_id: null, visibility: 'owner' }),
      [],
      [],
      B
    );

    const [h1, h2, h3] = await Promise.all([sp.query({}, A), sp.query({}, A), sp.query({}, A)]);
    const ids = (r: typeof h1) => r.map(h => h.node_id).sort();
    expect(ids(h1)).toEqual(ids(h2));
    expect(ids(h2)).toEqual(ids(h3));
    expect(ids(h1)).toContain('p1');
    expect(ids(h1)).not.toContain('note-b');
  });
});
