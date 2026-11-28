/** C-5 · Minimize / Revive 跨 Provider × 跨连接并发一致性（R4，P0）
 *
 *  关键证明对象（契约 §6 裁决 §4/5）：
 *  1. 用**两个独立 SqliteStorageProvider 连接同一个文件库**（非 :memory:，独立 SQLite handle）。
 *  2. 每个连接在自己的独立事务里执行我们交付的 CAS 纯函数
 *     buildMinimizeUpdate / buildReviveUpdate + assertSingleRow：
 *     「BEGIN IMMEDIATE → UPDATE(WITH CAS 条件) → 检查 changes」
 *     两个连接同时 minimize 同一 revision → CAS 条件保证**恰好一个 changes===1**，另一个 STATE_CONFLICT。
 *  3. 对照组：直接调 provider.minimize（现状，最终 UPDATE 无 content_state 条件，也不检查 changes）
 *     → 两个连接会都返回 ok:true（缺陷实证），但库内无二义（唯一 CURRENT）。证明 R4 必须修复。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { BlobStore, sha256 } from '../../src/storage/blob-store.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { buildMinimizeUpdate, buildReviveUpdate, assertSingleRow } from '../../src/storage/lifecycle-cas.ts';
import type { AuthContext } from '../../src/auth/context.ts';
import { asNodeId, asRevisionId, asContentHash, type MemoryNode, type Scope } from '../../src/storage/types.ts';

const authA: AuthContext = {
  ownerId: 'ws-1',
  agentId: 'agent-a',
  projectIds: ['proj-1'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:supersede', 'memory:minimize', 'memory:revive', 'memory:purge'],
};

const scopeOf = (over: Partial<Scope> = {}): Scope => ({
  owner_id: 'ws-1',
  layer: 'project',
  project_id: 'proj-1',
  agent_id: null,
  visibility: 'project_agents',
  shared_with: [],
  ...over,
});

function node(nodeId: string, revisionId: string, over: Partial<MemoryNode> = {}): MemoryNode {
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
    provenance: over.provenance ?? {
      agent_id: 'agent-a',
      origin: 'hot-path' as const,
      method: 'user-confirmed' as const,
      source_refs: [],
      producer_version: 'hetu 0.4.0',
      model_id: null,
      generated_at: '2026-11-27T00:00:00Z',
      confidence: 0.9,
    },
    scope: over.scope ?? scopeOf(),
    sensitivity: 'normal',
    valid_from: '2026-11-27T00:00:00Z',
    valid_until: null,
    ingested_at: '2026-11-27T00:00:00Z',
    superseded_by: null,
  };
}

const byRev = (r: string) => ({ kind: 'revision' as const, revisionId: asRevisionId(r) });
const byNode = (n: string) => ({ kind: 'node' as const, nodeId: asNodeId(n) });

interface Ctx {
  dir: string;
  blobRoot: string;
  p1: SqliteStorageProvider;
  p2: SqliteStorageProvider;
  blobs: BlobStore;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'hetu-r4-c5-'));
  const dbPath = join(dir, 'hetu.db');
  const blobRoot = dir;
  const p1 = new SqliteStorageProvider({ dbPath, blobRoot });
  runMigrations(p1.raw); // 建表进文件库，两个连接共享同一 schema/数据
  const p2 = new SqliteStorageProvider({ dbPath, blobRoot }); // 第二个独立 handle，同一文件
  const blobs = new BlobStore(blobRoot);
  return { dir, blobRoot, p1, p2, blobs };
}

function teardown(ctx: Ctx): void {
  ctx.p1.close();
  ctx.p2.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

/** 在某连接的独立事务里执行一条 CAS UPDATE，返回 assertSingleRow 的结果。 */
async function execCasTx(
  p: SqliteStorageProvider,
  sql: string,
  params: unknown[]
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    p.raw.exec('BEGIN IMMEDIATE');
    try {
      const changes = p.raw.prepare(sql).run(...params).changes;
      p.raw.exec('COMMIT');
      const a = assertSingleRow(changes);
      resolve(a.ok ? { ok: true } : { ok: false, error: a.error });
    } catch {
      try { p.raw.exec('ROLLBACK'); } catch { /* ignore */ }
      resolve({ ok: false, error: 'THREW' });
    }
  });
}

describe('C-5 · 两个独立 Provider 连接同一文件库 · Minimize 并发', () => {
  it('同时 minimize 同一 CURRENT/FULL revision → 恰好一个成功，另一个 STATE_CONFLICT', async () => {
    const ctx = setup();
    try {
      const CONTENT = 'concurrent-minimize-content';
      const hashHex = sha256(Buffer.from(CONTENT)).replace(/^sha256:/, '');
      // 通过 p2 写入真实 FULL 记忆（含主区 Blob），p2 与 p1 见同一数据
      const mainRef = `blobs/${hashHex.slice(0, 2)}/${hashHex}`;
      await ctx.blobs.write(mainRef, CONTENT);
      const put = await ctx.p2.put(
        node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: mainRef }),
        [],
        [],
        authA
      );
      expect(put.ok).toBe(true);

      // 模拟 Minimize 的文件 I/O 已成功：写入真实归档文件
      const archiveRef = `workspaces/ws-1/archive/${hashHex.slice(0, 2)}/${hashHex}`;
      await ctx.blobs.write(archiveRef, CONTENT);
      const archiveHash = sha256(Buffer.from(CONTENT));

      const spec = buildMinimizeUpdate({
        revisionId: 'r1',
        archiveRef,
        archiveHash,
        stubSummary: '精简摘要',
      });

      // 两个连接同时执行同一 CAS UPDATE
      const [a, b] = await Promise.all([
        execCasTx(ctx.p1, spec.sql, spec.params),
        execCasTx(ctx.p2, spec.sql, spec.params),
      ]);
      const oks = [a, b].filter((x) => x.ok);
      const conflicts = [a, b].filter((x) => !x.ok && x.error === 'STATE_CONFLICT');
      expect(oks.length).toBe(1);
      expect(conflicts.length).toBe(1);

      // 状态一致：唯一 CURRENT 且 MINIMIZED，归档落盘
      const cur = (await ctx.p2.unsafeInternalGet(byNode('m1')))!;
      expect(cur.version_state).toBe('CURRENT');
      expect(cur.content_state).toBe('MINIMIZED');
      expect(cur.minimized_blob_ref).toBe(archiveRef);
      expect(cur.minimized_blob_hash).toBe(archiveHash);
      expect(await ctx.blobs.exists(archiveRef)).toBe(true);
    } finally {
      teardown(ctx);
    }
  });

  it('真实 Provider minimize 并发：CAS 修复后恰好一个成功、一个 STATE_CONFLICT', async () => {
    const ctx = setup();
    try {
      const CONTENT = 'provider-race-content';
      const hex = sha256(Buffer.from(CONTENT)).replace(/^sha256:/, '');
      const mainRef = BlobStore.mainRefFor(authA.ownerId, `sha256:${hex}`);
      await ctx.blobs.write(mainRef, CONTENT);
      await ctx.p1.put(
        node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: mainRef }),
        [],
        [],
        authA
      );

      const [a, b] = await Promise.all([
        ctx.p1.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') }),
        ctx.p2.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') }),
      ]);
      // R4 修好后：最终 UPDATE 带 content_state CAS + changes===1 → 恰好一个成功，另一个 STATE_CONFLICT
      const wins = [a, b].filter(r => r.ok);
      const conflict = [a, b].filter(r => !r.ok);
      expect(wins.length).toBe(1);
      expect(conflict.length).toBe(1);
      expect((conflict[0] as any).error).toBe('STATE_CONFLICT');

      const cur = (await ctx.p1.unsafeInternalGet(byNode('m1')))!;
      expect(cur.version_state).toBe('CURRENT');
      expect(cur.content_state).toBe('MINIMIZED');
    } finally {
      teardown(ctx);
    }
  });
});

describe('C-5 · 两个独立 Provider 连接同一文件库 · Revive 并发', () => {
  it('同时 revive 同一 MINIMIZED revision → 恰好一个成功，另一个 STATE_CONFLICT', async () => {
    const ctx = setup();
    try {
      const CONTENT = 'concurrent-revive-content';
      const hex = sha256(Buffer.from(CONTENT)).replace(/^sha256:/, '');
      const mainRef = `blobs/${hex.slice(0, 2)}/${hex}`;
      await ctx.blobs.write(mainRef, CONTENT);
      await ctx.p1.put(
        node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: mainRef }),
        [],
        [],
        authA
      );
      const minimized = await ctx.p2.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });
      expect(minimized.ok).toBe(true);
      const row = (await ctx.p2.unsafeInternalGet(byRev('r1')))!;
      const archiveRef = row.minimized_blob_ref!;
      const archiveHash = row.minimized_blob_hash!;

      // 假设 Revive 的文件 I/O 已成功：恢复主区
      const restoredMain = mainRef;
      const spec = buildReviveUpdate({
        revisionId: 'r1',
        expectedRef: archiveRef,
        expectedHash: archiveHash,
        mainRef: restoredMain,
      });

      const [a, b] = await Promise.all([
        execCasTx(ctx.p1, spec.sql, spec.params),
        execCasTx(ctx.p2, spec.sql, spec.params),
      ]);
      const oks = [a, b].filter((x) => x.ok);
      const conflicts = [a, b].filter((x) => !x.ok && x.error === 'STATE_CONFLICT');
      expect(oks.length).toBe(1);
      expect(conflicts.length).toBe(1);

      const cur = (await ctx.p2.unsafeInternalGet(byRev('r1')))!;
      expect(cur.content_state).toBe('FULL');
      expect(cur.minimized_blob_ref).toBeNull();
      expect(cur.minimized_blob_hash).toBeNull();
      expect(cur.content_ref).toBe(restoredMain);
    } finally {
      teardown(ctx);
    }
  });
});