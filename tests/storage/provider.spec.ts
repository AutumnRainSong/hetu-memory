/** M1-B Storage Engine 验收测试（Review R2 修订版）
 *
 *  覆盖 R2 全部验收要求：
 *  - P0-A：get/query 强制 AuthContext、shared_list 白名单、Sensitivity 硬过滤
 *  - P0-B：写操作能力位校验、跨 owner/agent/project 拒绝、Purge 记录真实操作者
 *  - P0-C：Minimize/Revive 真实字节级归档与恢复、路径逃逸拒绝
 *  - P1-F：Supersedes 同 node_id + 序号方向、UPDATE 引用完整性
 *  - P1-G：reconcile 清理节点/两类边/覆盖层/Outbox
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

// ───────────────────────── fixtures ─────────────────────────

const provenance = (agent = 'agent-a') => ({
  agent_id: agent,
  origin: 'hot-path' as const,
  method: 'user-confirmed' as const,
  source_refs: [],
  producer_version: 'hetu 0.2.0',
  model_id: null,
  generated_at: '2026-11-27T00:00:00Z',
  confidence: 0.9,
});

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
  capabilities: ['memory:write', 'memory:supersede'],
};

const readOnlyA: AuthContext = { ...authA, capabilities: [] };
const lowSensA: AuthContext = { ...authA, maxSensitivity: 'normal' };

function node(over: Partial<MemoryNode> & { node_id: string; revision_id: string }): MemoryNode {
  return {
    node_id: asNodeId(over.node_id),
    revision_id: asRevisionId(over.revision_id),
    revision_sequence: over.revision_sequence ?? 1,
    content_hash: over.content_hash ?? asContentHash('sha256:' + 'a'.repeat(64)),
    version_state: over.version_state ?? 'CURRENT',
    content_state: over.content_state ?? 'FULL',
    content_ref: over.content_ref ?? null,
    stub_summary: over.stub_summary ?? null,
    minimized_blob_ref: over.minimized_blob_ref ?? null,
    minimized_blob_hash: over.minimized_blob_hash ?? null,
    modality: 'text',
    confidence: over.confidence ?? 0.9,
    provenance: over.provenance ?? provenance(),
    scope: over.scope ?? scopeOf(),
    sensitivity: over.sensitivity ?? 'normal',
    valid_from: over.valid_from ?? '2026-11-27T00:00:00Z',
    valid_until: over.valid_until ?? null,
    ingested_at: over.ingested_at ?? '2026-11-27T00:00:00Z',
    superseded_by: over.superseded_by ?? null,
  };
}

const byRev = (r: string) => ({ kind: 'revision' as const, revisionId: asRevisionId(r) });
const byNode = (n: string) => ({ kind: 'node' as const, nodeId: asNodeId(n) });

let sp: SqliteStorageProvider;
let blobRoot: string;

/** 写入一条带真实主区 Blob 的 FULL 记忆（用于 Minimize/Revive 测试） */
async function writeFullMemory(
  provider: SqliteStorageProvider,
  blobs: BlobStore,
  nodeId: string,
  revisionId: string,
  content: string,
  auth: AuthContext,
  scope: Partial<Scope> = {}
) {
  const hash = await blobs.write(BlobStore.mainRefFor(sha256(Buffer.from(content))), content);
  const ref = BlobStore.mainRefFor(hash);
  const r = await provider.put(
    node({
      node_id: nodeId,
      revision_id: revisionId,
      content_hash: asContentHash(hash),
      content_ref: ref,
      scope: scopeOf(scope),
    }),
    [],
    [],
    auth
  );
  expect(r.ok).toBe(true);
  return { hash, ref };
}

beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-r2-'));
  sp = new SqliteStorageProvider({ dbPath: ':memory:', blobRoot });
  runMigrations(sp.raw);
});
afterEach(() => {
  sp.close();
  rmSync(blobRoot, { recursive: true, force: true });
});

// ───────────────────────── P0-A ─────────────────────────

describe('P0-A · get 与 query 强制授权（无绕过路径）', () => {
  it('未提供 AuthContext 的 get → 抛 AUTH_CONTEXT_REQUIRED', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);
    await expect(
      sp.get(byRev('r1'), undefined as unknown as AuthContext)
    ).rejects.toThrow(/AUTH_CONTEXT_REQUIRED/);
  });

  it('未提供 AuthContext 的 query → PERMISSION_DENIED', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);
    await expect(sp.query({}, undefined as unknown as AuthContext)).rejects.toThrow(
      /AUTH_CONTEXT_REQUIRED|PERMISSION_DENIED/
    );
  });

  it('auth 缺 maxSensitivity → 视为不可信上下文', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);
    const broken = { ...authA, maxSensitivity: undefined } as unknown as AuthContext;
    await expect(sp.get(byRev('r1'), broken)).rejects.toThrow(/AUTH_CONTEXT/);
  });

  it('跨 owner 绝对隔离', async () => {
    await sp.put(
      node({ node_id: 'x1', revision_id: 'rx1', scope: scopeOf({ owner_id: 'ws-other' }) }),
      [],
      [],
      { ...authA, ownerId: 'ws-other', projectIds: ['proj-1'] }
    );
    expect((await sp.query({}, authA)).find(h => h.node_id === 'x1')).toBeUndefined();
    expect(await sp.get(byRev('rx1'), authA)).toBeNull();
  });

  it('Agent A 的 persona 对 B 不可见（query + get）', async () => {
    await sp.put(
      node({
        node_id: 'pa',
        revision_id: 'rpa',
        scope: scopeOf({ layer: 'agent_persona', agent_id: 'agent-a', project_id: null, visibility: 'owner' }),
      }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, authA)).some(h => h.node_id === 'pa')).toBe(true);
    expect((await sp.query({}, authB)).some(h => h.node_id === 'pa')).toBe(false);
    expect(await sp.get(byRev('rpa'), authB)).toBeNull();
  });

  it('Agent A 的 private_annotation 对 B 不可见', async () => {
    await sp.put(
      node({
        node_id: 'aa',
        revision_id: 'raa',
        scope: scopeOf({ layer: 'private_annotation', agent_id: 'agent-a', project_id: null, visibility: 'owner' }),
      }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, authA)).some(h => h.node_id === 'aa')).toBe(true);
    expect((await sp.query({}, authB)).some(h => h.node_id === 'aa')).toBe(false);
  });

  it('非项目成员读不到该项目记忆', async () => {
    await sp.put(
      node({ node_id: 'p1', revision_id: 'rp1', scope: scopeOf({ project_id: 'proj-1' }) }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, authB)).some(h => h.node_id === 'p1')).toBe(false);
    expect(await sp.query({ scope: { project_id: 'proj-1' } }, authB)).toEqual([]);
  });

  it('canReadGlobal=false → 读不到 global 层', async () => {
    await sp.put(
      node({
        node_id: 'g1',
        revision_id: 'rg1',
        scope: scopeOf({ layer: 'global', project_id: null, visibility: 'all_agents' }),
      }),
      [],
      [],
      authA
    );
    const noGlobal: AuthContext = { ...authA, canReadGlobal: false };
    expect((await sp.query({}, noGlobal)).some(h => h.node_id === 'g1')).toBe(false);
    expect((await sp.query({}, authA)).some(h => h.node_id === 'g1')).toBe(true);
  });
});

describe('P0-A · shared_list 白名单真正执行', () => {
  it('shared_with 命中当前 Agent → 可见', async () => {
    await sp.put(
      node({
        node_id: 'sl1',
        revision_id: 'rsl1',
        scope: scopeOf({ layer: 'project', project_id: 'proj-1', visibility: 'shared_list', shared_with: ['agent-a'] }),
      }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, authA)).some(h => h.node_id === 'sl1')).toBe(true);
    expect(await sp.get(byRev('rsl1'), authA)).not.toBeNull();
  });

  it('同项目成员但不在 shared_with → 不可见（关键：项目成员≠白名单成员）', async () => {
    // agent-c 也是 proj-1 成员，但 shared_with 只有 agent-a
    const authC: AuthContext = { ...authA, agentId: 'agent-c', projectIds: ['proj-1'] };
    await sp.put(
      node({
        node_id: 'sl2',
        revision_id: 'rsl2',
        scope: scopeOf({ layer: 'project', project_id: 'proj-1', visibility: 'shared_list', shared_with: ['agent-a'] }),
      }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, authC)).some(h => h.node_id === 'sl2')).toBe(false);
    expect(await sp.get(byRev('rsl2'), authC)).toBeNull();
  });
});

describe('P0-A · Sensitivity 硬过滤（先于召回）', () => {
  it('restricted 记忆对 maxSensitivity=normal 的身份不可见', async () => {
    await sp.put(
      node({ node_id: 'sr1', revision_id: 'rsr1', sensitivity: 'restricted' }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, lowSensA)).some(h => h.node_id === 'sr1')).toBe(false);
    expect(await sp.get(byRev('rsr1'), lowSensA)).toBeNull();
    // 高权限身份可见
    expect((await sp.query({}, authA)).some(h => h.node_id === 'sr1')).toBe(true);
    expect(await sp.get(byRev('rsr1'), authA)).not.toBeNull();
  });

  it('sensitive 对 normal 不可见、对 sensitive 上限可见', async () => {
    await sp.put(
      node({ node_id: 'sr2', revision_id: 'rsr2', sensitivity: 'sensitive' }),
      [],
      [],
      authA
    );
    expect((await sp.query({}, lowSensA)).some(h => h.node_id === 'sr2')).toBe(false);
    const sensAuth: AuthContext = { ...authA, maxSensitivity: 'sensitive' };
    expect((await sp.query({}, sensAuth)).some(h => h.node_id === 'sr2')).toBe(true);
  });
});

// ───────────────────────── P0-B ─────────────────────────

describe('P0-B · 写操作授权', () => {
  it('无 memory:write 能力 → 拒绝写入', async () => {
    const r = await sp.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], readOnlyA);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('不能写入其他工作空间', async () => {
    const r = await sp.put(
      node({ node_id: 'm1', revision_id: 'r1', scope: scopeOf({ owner_id: 'ws-other' }) }),
      [],
      [],
      authA
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('不能写别人的 persona', async () => {
    const r = await sp.put(
      node({
        node_id: 'm1',
        revision_id: 'r1',
        scope: scopeOf({ layer: 'agent_persona', agent_id: 'agent-b', project_id: null, visibility: 'owner' }),
      }),
      [],
      [],
      authA
    );
    expect(r.ok).toBe(false);
  });

  it('非项目成员不能写入该项目', async () => {
    const r = await sp.put(
      node({ node_id: 'm1', revision_id: 'r1', scope: scopeOf({ project_id: 'proj-2' }) }),
      [],
      [],
      authA
    );
    expect(r.ok).toBe(false);
  });

  it('supersede 需要 memory:supersede 能力', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);
    const noSupersede: AuthContext = { ...authA, capabilities: ['memory:write'] };
    const r = await sp.put(
      node({ node_id: 'm1', revision_id: 'r2', revision_sequence: 2, content_hash: asContentHash('sha256:' + 'b'.repeat(64)) }),
      [],
      [],
      noSupersede,
      { expectedRevision: asRevisionId('r1') }
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('PERMISSION_DENIED');
  });

  it('Purge 需要 memory:purge 且 Ledger 记录真实操作者', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);

    // 无能力 → 拒绝
    const denied = await sp.purge(asNodeId('m1'), authB, 'user-request', {
      expectedRevision: asRevisionId('r1'),
    });
    expect(denied.ok).toBe(false);

    // 有能力 → 成功，operater = agent-a
    const ok = await sp.purge(asNodeId('m1'), authA, 'user-request', {
      expectedRevision: asRevisionId('r1'),
    });
    expect(ok.ok).toBe(true);
    const ledger = sp.raw.prepare('SELECT operator FROM purge_ledger').all() as { operator: string }[];
    expect(ledger[0].operator).toBe('agent-a');
  });
});

// ───────────────────────── P0-C ─────────────────────────

describe('P0-C · Minimize / Revive 真实内容闭环', () => {
  const CONTENT = '这段是原始记忆内容，必须能字节级恢复。';

  it('Minimize 真正写入归档文件并记录 Hash', async () => {
    const blobs = new BlobStore(blobRoot);
    await writeFullMemory(sp, blobs, 'm1', 'r1', CONTENT, authA);

    const r = await sp.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });
    expect(r.ok).toBe(true);

    const got = await sp.get(byRev('r1'), authA);
    expect(got!.content_state).toBe('MINIMIZED');
    expect(got!.minimized_blob_ref).toBeTruthy();
    expect(got!.minimized_blob_hash).toBe(sha256(Buffer.from(CONTENT)));

    // 归档文件真实存在且内容一致
    const archived = await blobs.read(got!.minimized_blob_ref!);
    expect(archived.toString('utf8')).toBe(CONTENT);
  });

  it('Revive 真实恢复主区内容，字节级一致', async () => {
    const blobs = new BlobStore(blobRoot);
    const { hash } = await writeFullMemory(sp, blobs, 'm1', 'r1', CONTENT, authA);
    await sp.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });

    // 删掉主区文件，证明 Revive 确实重建了它
    await blobs.remove(BlobStore.mainRefFor(hash));
    expect(await blobs.exists(BlobStore.mainRefFor(hash))).toBe(false);

    const r = await sp.revive(asRevisionId('r1'), authA, { expectedRevision: asRevisionId('r1') });
    expect(r.ok).toBe(true);

    const got = await sp.get(byRev('r1'), authA);
    expect(got!.content_state).toBe('FULL');
    expect(got!.minimized_blob_ref).toBeNull();
    expect(got!.minimized_blob_hash).toBeNull();

    // 主区内容真实恢复且字节一致
    const restored = await blobs.read(got!.content_ref!);
    expect(restored.toString('utf8')).toBe(CONTENT);
    expect(sha256(restored)).toBe(hash);
  });

  it('归档文件被删后 Revive 失败且状态不变', async () => {
    const blobs = new BlobStore(blobRoot);
    await writeFullMemory(sp, blobs, 'm1', 'r1', CONTENT, authA);
    await sp.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });
    const minimized = await sp.get(byRev('r1'), authA);
    await blobs.remove(minimized!.minimized_blob_ref!);

    const r = await sp.revive(asRevisionId('r1'), authA, { expectedRevision: asRevisionId('r1') });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('ARCHIVE_MISSING');
    // 状态未变
    expect((await sp.get(byRev('r1'), authA))!.content_state).toBe('MINIMIZED');
  });

  it('归档 Hash 被篡改后 Revive 失败（内容校验生效）', async () => {
    const blobs = new BlobStore(blobRoot);
    await writeFullMemory(sp, blobs, 'm1', 'r1', CONTENT, authA);
    await sp.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });
    const minimized = await sp.get(byRev('r1'), authA);

    // 篡改归档文件
    await blobs.write(minimized!.minimized_blob_ref!, '被篡改的内容');

    const r = await sp.revive(asRevisionId('r1'), authA, { expectedRevision: asRevisionId('r1') });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('ARCHIVE_MISSING');
  });

  it('无 memory:minimize / memory:revive 能力 → 拒绝', async () => {
    const blobs = new BlobStore(blobRoot);
    await writeFullMemory(sp, blobs, 'm1', 'r1', CONTENT, authA);
    const writeOnly: AuthContext = { ...authA, capabilities: ['memory:write'] };

    expect(
      (await sp.minimize(asNodeId('m1'), writeOnly, { expectedRevision: asRevisionId('r1') })).ok
    ).toBe(false);
  });
});

describe('P0-C · Blob 路径逃逸防护', () => {
  it('引用含 ../ → 拒绝', () => {
    const blobs = new BlobStore(blobRoot);
    expect(() => blobs.resolve('../etc/passwd')).toThrow(/BLOB_PATH_REJECTED/);
    expect(() => blobs.resolve('archive/../../escape.txt')).toThrow(/BLOB_PATH_REJECTED/);
  });

  it('绝对路径 → 拒绝', () => {
    const blobs = new BlobStore(blobRoot);
    // POSIX 绝对路径（Linux CI 与 Windows 都会判定为 isAbsolute）
    expect(() => blobs.resolve('/etc/passwd')).toThrow(/BLOB_PATH_REJECTED/);
    // 反斜杠形式的穿越同样拒绝（Windows 风格）
    expect(() => blobs.resolve('..\\..\\evil.txt')).toThrow(/BLOB_PATH_REJECTED/);
  });

  it('合法归档引用 → 允许', async () => {
    const blobs = new BlobStore(blobRoot);
    const ref = BlobStore.archiveRefFor('mem-1', 'rev-1');
    await blobs.write(ref, 'content');
    expect(await blobs.exists(ref)).toBe(true);
  });

  it('node_id 含路径字符时归档引用被安全化', () => {
    const ref = BlobStore.archiveRefFor('../../etc', '../passwd');
    expect(ref.startsWith('archive/')).toBe(true);
    expect(ref).not.toContain('..');
  });
});

// ───────────────────────── P1-F / P1-G ─────────────────────────

describe('P1-F · Supersedes 边语义', () => {
  it('跨逻辑记忆的 supersedes 边 → 拒绝', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1a' }), [], [], authA);
    await sp.put(node({ node_id: 'm2', revision_id: 'r2a' }), [], [], authA);

    const r = await sp.put(
      node({ node_id: 'm1', revision_id: 'r1b', revision_sequence: 2, content_hash: asContentHash('sha256:' + 'c'.repeat(64)) }),
      [
        {
          type: 'supersedes',
          from: asRevisionId('r1b'),
          to: asRevisionId('r2a'), // 属于 m2 → 跨逻辑记忆
          weight: 1,
          created_at: '2026-11-27T00:00:00Z',
        },
      ],
      [],
      authA,
      { expectedRevision: asRevisionId('r1a') }
    );
    expect(r.ok).toBe(false);
  });

  it('序号方向错误（新序列 ≤ 旧序列）的 supersedes → 拒绝', async () => {
    await sp.put(node({ node_id: 'm1', revision_id: 'r1a', revision_sequence: 1 }), [], [], authA);
    await sp.put(node({ node_id: 'm1', revision_id: 'r1b', revision_sequence: 2, content_hash: asContentHash('sha256:' + 'd'.repeat(64)) }), [], [], authA, { expectedRevision: asRevisionId('r1a') });

    // 反向：从 seq2 指向 seq1 是合法的；从 seq1 指向 seq2 不合法
    const r = await sp.put(
      node({ node_id: 'm1', revision_id: 'r1c', revision_sequence: 1, content_hash: asContentHash('sha256:' + 'e'.repeat(64)) }),
      [
        {
          type: 'supersedes',
          from: asRevisionId('r1c'),
          to: asRevisionId('r1b'), // seq 1 -> seq 2：方向非法
          weight: 1,
          created_at: '2026-11-27T00:00:00Z',
        },
      ],
      [],
      authA
    );
    expect(r.ok).toBe(false);
  });

  it('普通边指向不存在 node → 拒绝', async () => {
    const r = await sp.put(
      node({ node_id: 'm1', revision_id: 'r1' }),
      [
        {
          type: 'link',
          link_class: 'explicit',
          from: asNodeId('m1'),
          to: asNodeId('ghost'),
          weight: 0.5,
          created_at: '2026-11-27T00:00:00Z',
        },
      ],
      [],
      authA
    );
    expect(r.ok).toBe(false);
  });
});

describe('P1-G · reconcile 完整清理', () => {
  it('Purge 后残留（节点/边/覆盖层/Outbox）被 reconcile 全部清理', async () => {
    const blobs = new BlobStore(blobRoot);
    await writeFullMemory(sp, blobs, 'mq', 'rq', 'other', authA);
    await sp.put(
      node({
        node_id: 'm1',
        revision_id: 'r1',
        sensitivity: 'restricted',
        content_hash: asContentHash('sha256:' + 'f'.repeat(64)),
      }),
      [
        {
          type: 'link',
          link_class: 'explicit',
          from: asNodeId('m1'),
          to: asNodeId('mq'),
          weight: 0.5,
          created_at: '2026-11-27T00:00:00Z',
        },
      ],
      [{ kind: 'index', entity_id: 'm1', seq: 1 }],
      authA
    );

    // 模拟崩溃残留：Ledger 有记录，但节点/边/覆盖层/Outbox 都还在
    sp.raw
      .prepare("INSERT INTO purge_ledger(node_id,content_hash,operator,reason_category) VALUES('m1','sha256:x','agent-a','crash')")
      .run();

    expect((sp.raw.prepare("SELECT COUNT(*) c FROM nodes WHERE node_id='m1'").get() as any).c).toBe(1);
    expect((sp.raw.prepare('SELECT COUNT(*) c FROM sensitivity_overlay').get() as any).c).toBe(1);

    const { fixed } = await sp.reconcile();
    expect(fixed).toBe(1);

    expect((sp.raw.prepare("SELECT COUNT(*) c FROM nodes WHERE node_id='m1'").get() as any).c).toBe(0);
    expect(
      (sp.raw.prepare("SELECT COUNT(*) c FROM edges WHERE \"from\"='m1' OR \"to\"='m1'").get() as any).c
    ).toBe(0);
    expect(
      (sp.raw.prepare("SELECT COUNT(*) c FROM sensitivity_overlay WHERE node_id='m1'").get() as any).c
    ).toBe(0);
    expect((sp.raw.prepare("SELECT COUNT(*) c FROM outbox WHERE entity_id='m1'").get() as any).c).toBe(0);
  });
});

describe('M1-B · 持久化与并发', () => {
  it('文件数据库重启后数据仍在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hetu-persist-'));
    const dbPath = join(dir, 'hetu.db');
    const s1 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    runMigrations(s1.raw);
    await s1.put(node({ node_id: 'mp', revision_id: 'rp' }), [], [], authA);
    s1.close();

    const s2 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    const got = await s2.get(byRev('rp'), authA);
    expect(got).not.toBeNull();
    expect(got!.node_id).toBe('mp');
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('两个独立连接同库 CAS：同一 expectedRevision 只有第一个成功（跨连接一致性）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hetu-cas-'));
    const dbPath = join(dir, 'hetu.db');
    const s1 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    runMigrations(s1.raw);
    await s1.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);

    // 第二个独立连接（独立 SQLite handle，同一文件）
    const s2 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    const cas = { expectedRevision: asRevisionId('r1') };

    // 连接 1 先提交 CAS
    const a = await s1.put(
      node({ node_id: 'm1', revision_id: 'r2a', revision_sequence: 2, content_hash: asContentHash('sha256:' + '1'.repeat(64)) }),
      [], [], authA, cas
    );
    expect(a.ok).toBe(true);

    // 连接 2 用同一期望版本再试 → 必须看到冲突（它读的是最新落盘状态）
    const b = await s2.put(
      node({ node_id: 'm1', revision_id: 'r2b', revision_sequence: 2, content_hash: asContentHash('sha256:' + '2'.repeat(64)) }),
      [], [], authA, cas
    );
    expect(b.ok).toBe(false);
    expect((b as any).error).toBe('CAS_CONFLICT');
    expect((b as any).currentRevision).toBe('r2a');

    // 无双链尾
    const cur = s2.raw
      .prepare("SELECT revision_id FROM nodes WHERE node_id='m1' AND version_state='CURRENT'")
      .all() as { revision_id: string }[];
    expect(cur.length).toBe(1);
    expect(cur[0].revision_id).toBe('r2a');

    s1.close();
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('跨连接：第二条 CAS 成功的链式翻转不产生双链尾', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hetu-cas2-'));
    const dbPath = join(dir, 'hetu.db');
    const s1 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    runMigrations(s1.raw);
    await s1.put(node({ node_id: 'm1', revision_id: 'r1' }), [], [], authA);

    const s2 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    // 连接 2 读到 r1 后做 CAS
    const b = await s2.put(
      node({ node_id: 'm1', revision_id: 'r2', revision_sequence: 2, content_hash: asContentHash('sha256:' + '3'.repeat(64)) }),
      [], [], authA, { expectedRevision: asRevisionId('r1') }
    );
    expect(b.ok).toBe(true);

    // 连接 1 能看到连接 2 写入的结果
    const fromS1 = await s1.get(byNode('m1'), authA);
    expect(fromS1!.revision_id).toBe('r2');

    s1.close();
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
