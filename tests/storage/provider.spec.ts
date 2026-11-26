/** M1-B Storage Engine 验收测试（Review R1 修订版）
 *
 *  覆盖：P0-A 权限隔离（AuthContext 失败关闭）、P0-B 生命周期数据完整性、
 *  P1-D 类型语义（NodeRef / RevisionId）、P1-E 边引用完整性、P1-F 跨连接并发 CAS。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
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

const prov = (): any => ({
  agent_id: 'agent-a',
  origin: 'hot-path' as const,
  method: 'user-confirmed' as const,
  source_refs: [],
  producer_version: 'hetu 0.1.0',
  model_id: null,
  generated_at: '2026-11-26T00:00:00Z',
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
};
const authB: AuthContext = {
  ownerId: 'ws-1',
  agentId: 'agent-b',
  projectIds: ['proj-2'],
  canReadGlobal: true,
};

function node(over: Partial<MemoryNode> & { node_id: string; revision_id: string }): MemoryNode {
  return {
    node_id: asNodeId(over.node_id),
    revision_id: asRevisionId(over.revision_id),
    revision_sequence: over.revision_sequence ?? 1,
    content_hash: over.content_hash ?? asContentHash('sha256:' + 'a'.repeat(64)),
    version_state: over.version_state ?? 'CURRENT',
    content_state: over.content_state ?? 'FULL',
    content_ref: over.content_ref ?? 'blobs/aa/x.txt',
    stub_summary: over.stub_summary ?? null,
    minimized_blob_ref: over.minimized_blob_ref ?? null,
    minimized_blob_hash: over.minimized_blob_hash ?? null,
    modality: 'text',
    confidence: over.confidence ?? 0.9,
    provenance: over.provenance ?? prov(),
    scope: over.scope ?? scopeOf(),
    sensitivity: over.sensitivity ?? 'normal',
    valid_from: over.valid_from ?? '2026-11-26T00:00:00Z',
    valid_until: over.valid_until ?? null,
    ingested_at: over.ingested_at ?? '2026-11-26T00:00:00Z',
    superseded_by: over.superseded_by ?? null,
  };
}

const byRev = (r: string) => ({ kind: 'revision' as const, revisionId: asRevisionId(r) });
const byNode = (n: string) => ({ kind: 'node' as const, nodeId: asNodeId(n) });

let sp: SqliteStorageProvider;
let blobDir: string;
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), 'hetu-blob-'));
  sp = new SqliteStorageProvider({ dbPath: ':memory:', blobRoot: blobDir });
  runMigrations(sp.raw);
});
afterEach(() => {
  sp.close();
  rmSync(blobDir, { recursive: true, force: true });
});

describe('M1-B · 基本读写（P1-D NodeRef 语义）', () => {
  it('按 revision 精确取 / 按 node 取 CURRENT', async () => {
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);

    const r = await sp.get(byRev('rev-1'));
    expect(r).not.toBeNull();
    expect(r!.node_id).toBe('mem-1');

    const n = await sp.get(byNode('mem-1'));
    expect(n!.revision_id).toBe('rev-1');

    expect(await sp.get(byNode('mem-404'))).toBeNull();
  });

  it('scope 与 provenance 完整往返', async () => {
    const n = node({ node_id: 'mem-1', revision_id: 'rev-1' });
    await sp.put(n, [], []);
    const got = await sp.get(byRev('rev-1'));
    expect(got!.scope.owner_id).toBe('ws-1');
    expect(got!.provenance.agent_id).toBe('agent-a');
  });
});

describe('P0-A · 权限隔离（失败关闭）', () => {
  it('未提供 AuthContext 的 query → PERMISSION_DENIED（不返回全部数据）', async () => {
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    await expect(sp.query({}, undefined as unknown as AuthContext)).rejects.toThrow(
      /AUTH_CONTEXT_REQUIRED|PERMISSION_DENIED/
    );
  });

  it('跨 owner 绝对隔离（返回空，不泄漏存在性）', async () => {
    await sp.put(
      node({ node_id: 'n-x', revision_id: 'r-x', scope: scopeOf({ owner_id: 'ws-other' }) }),
      [],
      []
    );
    const hits = await sp.query({}, authA);
    expect(hits.find(h => h.node_id === 'n-x')).toBeUndefined();
  });

  it('Agent A 的 persona 不被 Agent B 读到', async () => {
    await sp.put(
      node({
        node_id: 'p-a',
        revision_id: 'r-pa',
        scope: scopeOf({
          layer: 'agent_persona',
          agent_id: 'agent-a',
          project_id: null,
          visibility: 'owner',
        }),
      }),
      [],
      []
    );
    const aHits = await sp.query({}, authA);
    expect(aHits.some(h => h.node_id === 'p-a')).toBe(true);

    const bHits = await sp.query({}, authB);
    expect(bHits.some(h => h.node_id === 'p-a')).toBe(false);
  });

  it('Agent A 的 private_annotation 不被 Agent B 读到', async () => {
    await sp.put(
      node({
        node_id: 'ann-a',
        revision_id: 'r-ann',
        scope: scopeOf({
          layer: 'private_annotation',
          agent_id: 'agent-a',
          project_id: null,
          visibility: 'owner',
        }),
      }),
      [],
      []
    );
    expect((await sp.query({}, authA)).some(h => h.node_id === 'ann-a')).toBe(true);
    expect((await sp.query({}, authB)).some(h => h.node_id === 'ann-a')).toBe(false);
  });

  it('非项目成员无法读取该项目记忆', async () => {
    await sp.put(
      node({ node_id: 'p1', revision_id: 'r-p1', scope: scopeOf({ project_id: 'proj-1' }) }),
      [],
      []
    );
    // authB 只属于 proj-2
    expect((await sp.query({}, authB)).some(h => h.node_id === 'p1')).toBe(false);
    // 显式指定未授权项目 → 空结果
    expect(await sp.query({ scope: { project_id: 'proj-1' } }, authB)).toEqual([]);
  });

  it('canReadGlobal=false 时读不到 global 层', async () => {
    await sp.put(
      node({
        node_id: 'g-1',
        revision_id: 'r-g1',
        scope: scopeOf({ layer: 'global', project_id: null, visibility: 'all_agents' }),
      }),
      [],
      []
    );
    const noGlobal: AuthContext = { ...authA, canReadGlobal: false };
    expect((await sp.query({}, noGlobal)).some(h => h.node_id === 'g-1')).toBe(false);
    expect((await sp.query({}, authA)).some(h => h.node_id === 'g-1')).toBe(true);
  });

  it('get 带 auth 时不可见即返回 null', async () => {
    await sp.put(
      node({
        node_id: 'p-a',
        revision_id: 'r-pa',
        scope: scopeOf({
          layer: 'agent_persona',
          agent_id: 'agent-a',
          project_id: null,
          visibility: 'owner',
        }),
      }),
      [],
      []
    );
    expect(await sp.get(byRev('r-pa'), { auth: authB })).toBeNull();
    expect(await sp.get(byRev('r-pa'), { auth: authA })).not.toBeNull();
  });

  it('persona 用 all_agents 写入被 DB 拒绝（不能靠业务自律）', async () => {
    const r = await sp.put(
      node({
        node_id: 'bad',
        revision_id: 'r-bad',
        scope: scopeOf({
          layer: 'agent_persona',
          agent_id: 'a1',
          project_id: null,
          visibility: 'all_agents',
        }),
      }),
      [],
      []
    );
    expect(r.ok).toBe(false);
  });
});

describe('M1-B · CAS 与链尾唯一性', () => {
  it('CAS 命中：旧链尾翻转，新 revision 唯一 CURRENT', async () => {
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await sp.put(
      node({ node_id: 'mem-1', revision_id: 'rev-2', revision_sequence: 2 }),
      [],
      [],
      { expectedRevision: asRevisionId('rev-1') }
    );
    expect(r.ok).toBe(true);

    const cur = sp.raw
      .prepare("SELECT revision_id FROM nodes WHERE node_id='mem-1' AND version_state='CURRENT'")
      .all() as { revision_id: string }[];
    expect(cur.length).toBe(1);
    expect(cur[0].revision_id).toBe('rev-2');
  });

  it('CAS 冲突返回当前版本且不改库', async () => {
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await sp.put(
      node({ node_id: 'mem-1', revision_id: 'rev-9', revision_sequence: 2 }),
      [],
      [],
      { expectedRevision: asRevisionId('rev-999') }
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('CAS_CONFLICT');
    expect((r as any).currentRevision).toBe('rev-1');
    expect(
      (sp.raw.prepare("SELECT COUNT(*) c FROM nodes WHERE node_id='mem-1'").get() as any).c
    ).toBe(1);
  });
});

describe('P1-F · 跨连接并发 CAS（两个独立 Provider 同一文件库）', () => {
  it('两连接同时 CAS 同一 expectedRevision → 仅一个成功，无双链尾', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hetu-multi-'));
    const dbPath = join(dir, 'hetu.db');

    const s1 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    runMigrations(s1.raw);
    await s1.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);

    const s2 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
    const cas = { expectedRevision: asRevisionId('rev-1') };

    const [r1, r2] = await Promise.all([
      s1.put(node({ node_id: 'mem-1', revision_id: 'rev-2a', revision_sequence: 2 }), [], [], cas),
      s2.put(node({ node_id: 'mem-1', revision_id: 'rev-2b', revision_sequence: 2 }), [], [], cas),
    ]);

    const okCount = [r1, r2].filter(r => r.ok).length;
    expect(okCount).toBe(1);

    const cur = s1.raw
      .prepare("SELECT revision_id FROM nodes WHERE node_id='mem-1' AND version_state='CURRENT'")
      .all() as { revision_id: string }[];
    expect(cur.length).toBe(1); // 无双链尾

    s1.close();
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('M1-B · 原子性与 Outbox', () => {
  it('Node + Edge + Outbox 同事务提交', async () => {
    await sp.put(node({ node_id: 'mem-2', revision_id: 'rev-2' }), [], []);
    const edges: Edge[] = [
      {
        type: 'link',
        link_class: 'explicit',
        from: asNodeId('mem-1'),
        to: asNodeId('mem-2'),
        weight: 0.5,
        created_at: '2026-11-26T00:00:00Z',
      },
    ];
    const r = await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), edges, [
      { kind: 'index', entity_id: 'mem-1', seq: 1 },
    ]);
    expect(r.ok).toBe(true);
    expect((sp.raw.prepare('SELECT COUNT(*) c FROM edges').get() as any).c).toBe(1);
    expect((sp.raw.prepare('SELECT COUNT(*) c FROM outbox').get() as any).c).toBe(1);
  });

  it('任一步失败 → 整体回滚（节点不落库）', async () => {
    const r = await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], [
      { kind: 'bogus' as unknown as 'index', entity_id: 'x', seq: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect((sp.raw.prepare('SELECT COUNT(*) c FROM nodes').get() as any).c).toBe(0);
  });
});

describe('P1-E · 边引用完整性', () => {
  it('普通边指向不存在的 node → 被拒绝', async () => {
    const r = await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [
      {
        type: 'link',
        link_class: 'explicit',
        from: asNodeId('mem-1'),
        to: asNodeId('mem-ghost'),
        weight: 0.5,
        created_at: '2026-11-26T00:00:00Z',
      },
    ], []);
    expect(r.ok).toBe(false);
  });

  it('supersedes 边指向不存在的 revision → 被拒绝', async () => {
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await sp.put(node({ node_id: 'mem-2', revision_id: 'rev-2' }), [
      {
        type: 'supersedes',
        from: asRevisionId('rev-2'),
        to: asRevisionId('rev-ghost'),
        weight: 1,
        created_at: '2026-11-26T00:00:00Z',
      },
    ], []);
    expect(r.ok).toBe(false);
  });

  it('重复边不得静默覆盖', async () => {
    await sp.put(node({ node_id: 'mem-2', revision_id: 'rev-2' }), [], []);
    const e: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: asNodeId('mem-1'),
      to: asNodeId('mem-2'),
      weight: 0.5,
      created_at: '2026-11-26T00:00:00Z',
    };
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [e], []);
    const r2 = await sp.put(
      node({ node_id: 'mem-1', revision_id: 'rev-1b', revision_sequence: 2 }),
      [e],
      [],
      { expectedRevision: asRevisionId('rev-1') }
    );
    expect(r2.ok).toBe(false); // 已存在 → 拒绝而非覆盖
  });
});

describe('P0-B · 生命周期能力边界与归档真实性', () => {
  it('未配置 blobRoot 时 minimize 拒绝（不产生假成功）', async () => {
    const noBlob = new SqliteStorageProvider({ dbPath: ':memory:' });
    runMigrations(noBlob.raw);
    await noBlob.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await noBlob.minimize(
      asRevisionId('rev-1'),
      { ref: 'archive/x.txt', hash: asContentHash('sha256:' + 'd'.repeat(64)), inArchive: true },
      { expectedRevision: asRevisionId('rev-1') }
    );
    expect(r.ok).toBe(false);
    // 数据库状态未变
    const got = await noBlob.get(byRev('rev-1'));
    expect(got!.content_state).toBe('FULL');
    noBlob.close();
  });

  it('归档文件不存在时 minimize 拒绝且不改状态', async () => {
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await sp.minimize(
      asRevisionId('rev-1'),
      { ref: 'archive/missing.txt', hash: asContentHash('sha256:' + 'e'.repeat(64)), inArchive: true },
      { expectedRevision: asRevisionId('rev-1') }
    );
    expect(r.ok).toBe(false);
    expect((await sp.get(byRev('rev-1')))!.content_state).toBe('FULL');
  });

  it('归档 Hash 不匹配时 minimize 拒绝', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const ref = 'archive/mem-1/rev-1.txt';
    mkdirSync(join(blobDir, 'archive/mem-1'), { recursive: true });
    writeFileSync(join(blobDir, ref), 'real content');

    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await sp.minimize(
      asRevisionId('rev-1'),
      { ref, hash: asContentHash('sha256:' + 'f'.repeat(64)), inArchive: true }, // 错误 hash
      { expectedRevision: asRevisionId('rev-1') }
    );
    expect(r.ok).toBe(false);
    expect((await sp.get(byRev('rev-1')))!.content_state).toBe('FULL');
  });

  it('归档正确写入且 Hash 匹配 → minimize 成功', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const ref = 'archive/mem-1/rev-1.txt';
    const content = 'content to archive';
    mkdirSync(join(blobDir, 'archive/mem-1'), { recursive: true });
    writeFileSync(join(blobDir, ref), content);
    const hash = asContentHash('sha256:' + createHash('sha256').update(content).digest('hex'));

    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    const r = await sp.minimize(
      asRevisionId('rev-1'),
      { ref, hash, inArchive: true },
      { expectedRevision: asRevisionId('rev-1') }
    );
    expect(r.ok).toBe(true);
    const got = await sp.get(byRev('rev-1'));
    expect(got!.content_state).toBe('MINIMIZED');
    expect(got!.minimized_blob_ref).toBe(ref);
  });

  it('归档丢失时 revive 失败且数据库状态不变', async () => {
    const { writeFileSync, mkdirSync, rmSync: rm } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const ref = 'archive/mem-1/rev-1.txt';
    const content = 'archived';
    mkdirSync(join(blobDir, 'archive/mem-1'), { recursive: true });
    writeFileSync(join(blobDir, ref), content);
    const hash = asContentHash('sha256:' + createHash('sha256').update(content).digest('hex'));

    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1' }), [], []);
    await sp.minimize(asRevisionId('rev-1'), { ref, hash, inArchive: true }, {
      expectedRevision: asRevisionId('rev-1'),
    });

    // 删除归档文件
    rm(join(blobDir, ref));

    const r = await sp.revive(asRevisionId('rev-1'), { expectedRevision: asRevisionId('rev-1') });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('ARCHIVE_MISSING');
    // 状态未被改成 FULL
    expect((await sp.get(byRev('rev-1')))!.content_state).toBe('MINIMIZED');
  });
});

describe('P1-E · Purge 后无悬空边', () => {
  it('purge 删除整条逻辑记忆的所有 revision 与相关边', async () => {
    await sp.put(node({ node_id: 'mem-2', revision_id: 'rev-2' }), [], []);
    await sp.put(
      node({ node_id: 'mem-1', revision_id: 'rev-1a' }),
      [
        {
          type: 'link',
          link_class: 'explicit',
          from: asNodeId('mem-1'),
          to: asNodeId('mem-2'),
          weight: 0.5,
          created_at: '2026-11-26T00:00:00Z',
        },
      ],
      []
    );
    // 产生第二个 revision
    await sp.put(node({ node_id: 'mem-1', revision_id: 'rev-1b', revision_sequence: 2 }), [], [], {
      expectedRevision: asRevisionId('rev-1a'),
    });

    const r = await sp.purge(asNodeId('mem-1'), 'user-request', {
      expectedRevision: asRevisionId('rev-1b'),
    });
    expect(r.ok).toBe(true);

    // 节点全删
    expect(
      (sp.raw.prepare("SELECT COUNT(*) c FROM nodes WHERE node_id='mem-1'").get() as any).c
    ).toBe(0);
    // 悬空边全删
    const dangling = sp.raw
      .prepare(
        `SELECT COUNT(*) c FROM edges e
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = e."from")
            OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = e."to")`
      )
      .get() as any;
    expect(dangling.c).toBe(0);
    // Ledger 覆盖所有被擦除的 revision
    const ledger = sp.raw.prepare('SELECT content_hash FROM purge_ledger').all() as any[];
    expect(ledger.length).toBe(2);
  });
});
