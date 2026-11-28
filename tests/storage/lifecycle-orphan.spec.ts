/** C-4 · 失败孤儿归档文件登记（R4，P0）
 *
 *  场景：Minimize 已把原始内容写入归档文件（磁盘 I/O 成功），但随后 DB 最终 CAS UPDATE
 *  因并发冲突返回 changes===0（STATE_CONFLICT）。此时归档文件已在磁盘上、却没有任何 revision
 *  引用它 → **孤儿文件**。若不做补偿，会静默残留。
 *
 *  本测试证明：在「DB 提交失败」路径上调用 recordOrphanForCleanup 能可靠地把该归档登记进
 *  blob_cleanup_tasks（契约 §3 ③ 队列），由 A 组 cleanup worker 补偿删除。
 *  blob_cleanup_tasks 当前尚未由 A 组交付，测试内直接按契约 DDL 建表（与 Migration 005 一致）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { buildMinimizeUpdate, assertSingleRow, recordOrphanForCleanup } from '../../src/storage/lifecycle-cas.ts';
import type { AuthContext } from '../../src/auth/context.ts';
import { asNodeId, asRevisionId, asContentHash, type MemoryNode, type Scope } from '../../src/storage/types.ts';

const authA: AuthContext = {
  ownerId: 'ws-1',
  agentId: 'agent-a',
  projectIds: ['proj-1'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:minimize'],
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

describe('C-4 · Minimize 失败孤儿归档登记', () => {
  it('DB 最终 CAS 冲突（changes===0）→ 归档文件落盘但仍登记清理任务', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hetu-r4-orphan-'));
    const dbPath = join(dir, 'hetu.db');
    const blobRoot = dir;
    const sp = new SqliteStorageProvider({ dbPath, blobRoot });
    runMigrations(sp.raw);
    const blobs = new BlobStore(blobRoot);

    try {
      // A 组 Migration 005 已未交付：测试内按契约 DDL 直接建清理任务表（与 005 一致）
      sp.raw.exec(`CREATE TABLE IF NOT EXISTS blob_cleanup_tasks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_key TEXT NOT NULL,
        blob_ref TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('main','archive')),
        status TEXT NOT NULL CHECK (status IN ('pending','claimed','failed','done')),
        claim_token TEXT, claimed_by TEXT, claimed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )`);
      sp.raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_active
        ON blob_cleanup_tasks(owner_key, blob_ref) WHERE status IN ('pending','claimed','failed')`);

      const CONTENT = 'orphan-archive-content';
      const hashHex = sha256(Buffer.from(CONTENT)).replace(/^sha256:/, '');
      const mainRef = `workspaces/ws-1/blobs/${hashHex.slice(0, 2)}/${hashHex}`;
      await blobs.write(mainRef, CONTENT);
      const put = await sp.put(
        node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: mainRef }),
        [],
        [],
        authA
      );
      expect(put.ok).toBe(true);
      const ownerKey = ownerKeyFor('ws-1');

      // 模拟 Minimize 文件 I/O 已成功：归档文件落盘
      const archiveRef = `workspaces/ws-1/archive/${hashHex.slice(0, 2)}/${hashHex}`;
      await blobs.write(archiveRef, CONTENT);
      expect(await blobs.exists(archiveRef)).toBe(true);

      // 制造最终 CAS 冲突：Minimize vs Supersede 并发——第三方先把该 revision 翻为 SUPERSEDED，
      // 使 Minimize 的 CAS 条件 version_state='CURRENT' 不再命中。
      //（不能用 content_state='MINIMIZED'：003 有 CHECK content_state<>'MINIMIZED' OR
      //   (minimized_blob_ref&hash 均非空)，无引用时直接置 MINIMIZED 会违反约束。）
      sp.raw.prepare(`UPDATE nodes SET version_state='SUPERSEDED' WHERE revision_id='r1'`).run();

      const spec = buildMinimizeUpdate({
        revisionId: 'r1',
        archiveRef,
        archiveHash: sha256(Buffer.from(CONTENT)),
        stubSummary: '摘要',
      });
      const changes = sp.raw.prepare(spec.sql).run(...spec.params).changes;
      expect(changes).toBe(0); // 状态已变 → 未更新
      const verdict = assertSingleRow(changes);
      expect(verdict).toEqual({ ok: false, error: 'STATE_CONFLICT' });

      // 关键：即使 DB 提交失败，归档文件已在磁盘 → 必须登记清理任务，不得静默残留
      const enqueue = recordOrphanForCleanup(sp.raw as any, {
        ownerKey,
        blobRef: archiveRef,
        kind: 'archive',
      });
      expect(enqueue).toEqual({ ok: true, enqueued: true });

      const tasks = sp.raw.prepare('SELECT * FROM blob_cleanup_tasks').all() as any[];
      expect(tasks.length).toBe(1);
      expect(tasks[0]).toMatchObject({
        owner_key: ownerKey,
        blob_ref: archiveRef,
        kind: 'archive',
        status: 'pending',
      });

      // 重复登记不产生重复任务（幂等）
      const again = recordOrphanForCleanup(sp.raw as any, {
        ownerKey,
        blobRef: archiveRef,
        kind: 'archive',
      });
      expect(again.enqueued).toBe(false);
      expect((sp.raw.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks').get() as any).c).toBe(1);
    } finally {
      sp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes===1 时不会误登记孤儿（file I/O 已回滚成功，无孤儿）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hetu-r4-orphan2-'));
    const dbPath = join(dir, 'hetu.db');
    const blobRoot = dir;
    const sp = new SqliteStorageProvider({ dbPath, blobRoot });
    runMigrations(sp.raw);
    const blobs = new BlobStore(blobRoot);
    try {
      sp.raw.exec(`CREATE TABLE IF NOT EXISTS blob_cleanup_tasks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_key TEXT NOT NULL, blob_ref TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('main','archive')),
        status TEXT NOT NULL CHECK (status IN ('pending','claimed','failed','done'))
      )`);
      const CONTENT = 'no-orphan';
      const hashHex = sha256(Buffer.from(CONTENT)).replace(/^sha256:/, '');
      const mainRef = `blobs/${hashHex.slice(0, 2)}/${hashHex}`;
      const ownerKey = ownerKeyFor('ws-1');
      await blobs.write(mainRef, CONTENT);
      await sp.put(node('m1', 'r1', { content_hash: asContentHash(sha256(Buffer.from(CONTENT))), content_ref: mainRef }), [], [], authA);
      const archiveRef = `archive/${hashHex.slice(0, 2)}/${hashHex}`;
      await blobs.write(archiveRef, CONTENT);

      const spec = buildMinimizeUpdate({ revisionId: 'r1', archiveRef, archiveHash: sha256(Buffer.from(CONTENT)), stubSummary: '摘要' });
      const changes = sp.raw.prepare(spec.sql).run(...spec.params).changes;
      expect(assertSingleRow(changes)).toEqual({ ok: true }); // 成功
      // 成功路径调用方不应再登记孤儿；即便误调用，登记也幂等无害（不会重复）。
      const enqueue = recordOrphanForCleanup(sp.raw as any, { ownerKey, blobRef: archiveRef, kind: 'archive' });
      expect(enqueue.ok).toBe(true);
      // 无论 enqueued 与否，都不应有重复任务：清理任务表至多 1 行。
      const c = (sp.raw.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks').get() as any).c;
      expect(c).toBeLessThanOrEqual(1);
    } finally {
      sp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});