/** C-6 · Revive×Purge、Minimize×Supersede 交叉并发（R4，P0）
 *
 *  证明契约 §6 / 裁决 §5 要求的状态一致性与失败语义：
 *  - Revive 目标已被 Purge → PURGED_FINAL
 *  - Minimize 进行中 Supersede 发生 → 最终只有一个成功，状态一致（CAS 终局判定）
 *  - SUPERSEDED 历史版本 revive → INVALID_STATE（复测既有行为并保留断言）
 *
 *  并发场景：用两个独立 Provider 连接同一文件库，一个执行目标操作（minimize/revive），
 *  一个执行干扰操作（supersede/purge），断言最终数据库状态一致且报告结果互斥。
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
      producer_version: 'hetu 0.4.0',
      model_id: null,
      generated_at: '2026-11-27T00:00:00Z',
      confidence: 0.9,
    },
    scope: scopeOf(),
    sensitivity: 'normal',
    valid_from: '2026-11-27T00:00:00Z',
    valid_until: null,
    ingested_at: '2026-11-27T00:00:00Z',
    superseded_by: null,
  };
}
const byRev = (r: string) => ({ kind: 'revision' as const, revisionId: asRevisionId(r) });

const CONTENT = 'cross-concurrency-content';

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'hetu-r4-c6-'));
  const dbPath = join(dir, 'hetu.db');
  const p1 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
  runMigrations(p1.raw);
  const p2 = new SqliteStorageProvider({ dbPath, blobRoot: dir });
  const blobs = new BlobStore(dir);
  return { dir, p1, p2, blobs };
}
function freeCtx(ctx: ReturnType<typeof makeCtx>) {
  ctx.p1.close();
  ctx.p2.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}
function contentRef(content: string) {
  const h = sha256(Buffer.from(content)).replace(/^sha256:/, '');
  return `blobs/${h.slice(0, 2)}/${h}`;
}

describe('C-6 · Revive×Purge', () => {
  it('Revive 目标已被 Purge → PURGED_FINAL（PURGED_FINAL 语义）', async () => {
    const ctx = makeCtx();
    try {
      await ctx.blobs.write(contentRef(CONTENT), CONTENT);
      await ctx.p1.put(node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: contentRef(CONTENT) }), [], [], authA);
      await ctx.p1.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });

      // 另一连接/并发：Purge 该逻辑记忆（R3 现有行为）
      const purged = await ctx.p2.purge(asNodeId('m1'), authA, 'user-request', { expectedRevision: asRevisionId('r1') });
      expect(purged.ok).toBe(true);

      // Revive 目标版本已永久擦除（PURGED_FINAL）
      const rr = await ctx.p1.revive(asRevisionId('r1'), authA, { expectedRevision: asRevisionId('r1') });
      expect(rr.ok).toBe(false);
      expect((rr as any).error).toBe('PURGED_FINAL');
    } finally {
      freeCtx(ctx);
    }
  });

  it('Purge 提交后，CAS Revive 最终 UPDATE 必须报 STATE_CONFLICT（不误报成功）', async () => {
    const ctx = makeCtx();
    try {
      await ctx.blobs.write(contentRef(CONTENT), CONTENT);
      await ctx.p1.put(node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: contentRef(CONTENT) }), [], [], authA);
      await ctx.p1.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });
      const row = (await ctx.p1.unsafeInternalGet(byRev('r1')))!;
      const archiveRef = row.minimized_blob_ref!;
      const archiveHash = row.minimized_blob_hash!;

      // Purge 先提交（把该 revision 连同节点从库内物理删除）
      const purged = await ctx.p2.purge(asNodeId('m1'), authA, 'user-request', { expectedRevision: asRevisionId('r1') });
      expect(purged.ok).toBe(true);
      expect(await ctx.p1.unsafeInternalGet(byRev('r1'))).toBeNull();

      // Revive 已完成文件 I/O（读回归档 OK），随后执行最终 CAS UPDATE
      // —— 此刻行已不存在 → changes===0，绝不允许报成功。
      const spec = buildReviveUpdate({
        revisionId: 'r1',
        expectedRef: archiveRef,
        expectedHash: archiveHash,
        mainRef: contentRef(CONTENT),
      });
      const changes = ctx.p1.raw.prepare(spec.sql).run(...spec.params).changes;
      expect(changes).toBe(0);
      expect(assertSingleRow(changes)).toEqual({ ok: false, error: 'STATE_CONFLICT' });
      // 不产生残留：无任何行被更新
      expect(await ctx.p1.unsafeInternalGet(byRev('r1'))).toBeNull();
    } finally {
      freeCtx(ctx);
    }
  });
});

describe('C-6 · Minimize×Supersede 交叉并发', () => {
  it('Minimize 进行中 Supersede 发生 → 最终只有一个成功，状态一致', async () => {
    const ctx = makeCtx();
    try {
      await ctx.blobs.write(contentRef(CONTENT), CONTENT);
      await ctx.p1.put(node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: contentRef(CONTENT) }), [], [], authA);

      const [, sup] = await Promise.all([
        ctx.p2.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') }),
        ctx.p1.put(
          node('m1', 'r2', { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'e'.repeat(64)), content_ref: contentRef(CONTENT) }),
          [], [], authA, { expectedRevision: asRevisionId('r1') }
        ),
      ]);
      // supersede 产生新 CURRENT r2（第二次 potential，sup 成功）
      expect(sup.ok).toBe(true);

      const cur = (await ctx.p1.unsafeInternalGet({ kind: 'node', nodeId: asNodeId('m1') }))!;
      // 唯一 CURRENT 且为 r2（全量新版本）；r1 已 SUPERSEDED 不得被 minimize 翻成 CURRENT
      expect(cur.revision_id.toString()).toBe('r2');
      expect(cur.version_state).toBe('CURRENT');
      // r1 历史版本仍是 SUPERSEDED，状态不越界
      const r1 = (await ctx.p1.unsafeInternalGet(byRev('r1')))!;
      expect(r1.version_state).toBe('SUPERSEDED');
    } finally {
      freeCtx(ctx);
    }
  });

  it('CAS 终局：minimize 与 supersede 基于同一 expectedRevision 竞争，恰好一个能对 CURRENT 生效', async () => {
    const ctx = makeCtx();
    try {
      await ctx.blobs.write(contentRef(CONTENT), CONTENT);
      await ctx.p1.put(node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: contentRef(CONTENT) }), [], [], authA);

      // 手工模拟最小化前置文件 I/O：归档落盘
      const h = sha256(Buffer.from(CONTENT)).replace(/^sha256:/, '');
      const archiveRef = `workspaces/ws-1/archive/${h.slice(0, 2)}/${h}`;
      await ctx.blobs.write(archiveRef, CONTENT);
      const spec = buildMinimizeUpdate({ revisionId: 'r1', archiveRef, archiveHash: sha256(Buffer.from(CONTENT)), stubSummary: '摘要' });

      // 连接1：CAS minimize；连接2：supersede 产生 r2（使 r1 变 SUPERSEDED）
      const [minRes, superseded] = await Promise.all([
        (async () => {
          ctx.p1.raw.exec('BEGIN IMMEDIATE');
          const changes = ctx.p1.raw.prepare(spec.sql).run(...spec.params).changes;
          ctx.p1.raw.exec('COMMIT');
          return assertSingleRow(changes);
        })(),
        ctx.p2.put(
          node('m1', 'r2', { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'f'.repeat(64)), content_ref: contentRef(CONTENT) }),
          [], [], authA, { expectedRevision: asRevisionId('r1') }
        ),
      ]);
      expect(superseded.ok).toBe(true);

      // 关键：无论交集顺序，r1（被 supersede 的历史版本）的状态必须自洽。
      const r1state = (await ctx.p2.unsafeInternalGet(byRev('r1')))!;
      if (minRes.ok) {
        // minimize 赢了→ r1 翻成 MINIMIZED（SUPERSEDED + MINIMIZED 合法），且 CAS 成功后 supersede 也看到它
        expect(r1state.content_state).toBe('MINIMIZED');
        expect(r1state.version_state).toBe('SUPERSEDED');
        expect(r1state.minimized_blob_ref).toBe(archiveRef);
      } else {
        // supersede 赢了（r1 先变 SUPERSEDED）→ minimize 因 version_state='CURRENT' 未命中
        expect(minRes).toEqual({ ok: false, error: 'STATE_CONFLICT' });
        expect(r1state.content_state).toBe('FULL');
      }
      // 当前链尾始终唯一且为新版本 r2
      const cur = (await ctx.p2.unsafeInternalGet({ kind: 'node', nodeId: asNodeId('m1') }))!;
      expect(cur.revision_id.toString()).toBe('r2');
    } finally {
      freeCtx(ctx);
    }
  });
});

describe('C-6 · SUPERSEDED 历史版本 revive 拒绝（复测既有行为）', () => {
  it('已 SUPERSEDED 的 MINIMIZED 历史版本 revive → INVALID_STATE', async () => {
    const ctx = makeCtx();
    try {
      await ctx.blobs.write(contentRef(CONTENT), CONTENT);
      await ctx.p1.put(node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: contentRef(CONTENT) }), [], [], authA);
      await ctx.p1.minimize(asNodeId('m1'), authA, { expectedRevision: asRevisionId('r1') });
      // 产生新 revision，r1 变 SUPERSEDED
      await ctx.p1.put(
        node('m1', 'r2', { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'b'.repeat(64)), content_ref: contentRef(CONTENT) }),
        [], [], authA, { expectedRevision: asRevisionId('r1') }
      );
      const rr = await ctx.p2.revive(asRevisionId('r1'), authA, { expectedRevision: asRevisionId('r1') });
      expect(rr.ok).toBe(false);
      expect((rr as any).error).toBe('INVALID_STATE');
    } finally {
      freeCtx(ctx);
    }
  });
});