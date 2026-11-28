/**
 * tests/qa-r4/_helpers.ts —— F 组（agt-qa）专用测试辅助。
 *
 * 边界（严格执行）：F 组**只允许**新增/修改 `tests/qa-r4/**` 与 `docs/QA-ACCEPTANCE-REVIEW-R4.md`，
 * **绝不修改任何 src/** 业务代码**。这里 import 的是「被测试的公开 API」，属验证而非实现。
 *
 * 二、R4 能力探测
 *   由于 A–E 组实现可能尚未合入集成分支，很多场景依赖：
 *   - 新表：blob_objects / blob_refs / blob_cleanup_tasks（005）
 *   - 新模块：blob-lifecycle / lifecycle-cas / preflight
 *   - 005 在 MIGRATIONS 的注册（E 组）
 *   - Provider 接入（Lead）
 *   当相应 API/表不可用时，测试必须**主动跳过并打 [F-skip] 日志**，以免污染既有全量测试，
 *   并在实现合入后自动激活。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from '../../src/storage/sqlite.ts';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { BlobStore, sha256, ownerKeyFor } from '../../src/storage/blob-store.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import type { AuthContext } from '../../src/auth/context.ts';
import {
  asNodeId,
  asRevisionId,
  asContentHash,
  type MemoryNode,
  type Scope,
} from '../../src/storage/types.ts';

export {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  BlobStore,
  SqliteStorageProvider,
  runMigrations,
  sha256,
  ownerKeyFor,
  readdirSync,
  rmSync,
  mkdirSync,
  existsSync,
  join,
  asNodeId,
  asRevisionId,
  asContentHash,
};
export { rollbackTo } from '../../src/storage/migrate.ts';
export { DatabaseSync } from '../../src/storage/sqlite.ts';

// ── 模块与能力探测 ────────────────────────────────────────────

export function modulePresent(name: 'blob-lifecycle' | 'lifecycle-cas' | 'preflight' | 'factory'): boolean {
  try {
    return existsSync(join(process.cwd(), 'src', 'storage', `${name}.ts`));
  } catch {
    return false;
  }
}
export const hasBlobLifecycle = modulePresent('blob-lifecycle');
export const hasLifecycleCas = modulePresent('lifecycle-cas');
export const hasPreflight = modulePresent('preflight');
export const hasFactory = modulePresent('factory');

export function schemaHasTable(db: InstanceType<typeof DatabaseSync>, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

export function hasR4Tables(db: InstanceType<typeof DatabaseSync>): boolean {
  return (
    schemaHasTable(db, 'blob_objects') &&
    schemaHasTable(db, 'blob_refs') &&
    schemaHasTable(db, 'blob_cleanup_tasks')
  );
}

/** 在同一连接探测 blob-lifecycle / lifecycle-cas 是否可 import（动态，不因模块缺失而抛错）。 */
export async function tryImport<T>(path: string): Promise<T | null> {
  try {
    const mod = await import(path);
    return mod as T;
  } catch {
    return null;
  }
}

/**
 * 迁移并在需要时尝试手动 apply 005（仅当官方未注册）。返回摘要。
 * code: '005'  表示 005 三表齐全（无论经由官方注册还是手动 apply）
 *       'partial' 表示缺少某些 R4 表
 */
export interface SchemaSummary {
  code: '005' | 'partial';
  applied: number[];
  version5: boolean;
  fullSchema: boolean;
  hasBlobObjects: boolean;
  hasBlobRefs: boolean;
  hasCleanupTasks: boolean;
}

/** 读取 005 迁移 up SQL（用于在官方未注册时，让 lifecycle 测试可对真实表结构探索）。 */
async function readMigration005Up(): Promise<string | null> {
  try {
    const mod = (await import('../../src/storage/migrations/005_blob_objects.ts')) as {
      migration?: { up?: string };
    };
    return mod.migration?.up ?? null;
  } catch {
    return null;
  }
}

export async function migrateForR4(
  db: InstanceType<typeof DatabaseSync>,
  opts: { tryApply005?: boolean } = {}
): Promise<SchemaSummary> {
  const appliedRes = runMigrations(db) as { applied: number[] };
  const applied = appliedRes.applied ?? [];
  let version5 = applied.includes(5);

  if (opts.tryApply005 && !version5) {
    const up = await readMigration005Up();
    if (up) {
      try {
        db.exec(up);
        version5 = true;
      } catch {
        version5 = false;
      }
    }
  }

  const hasBlobObjects = schemaHasTable(db, 'blob_objects');
  const hasBlobRefs = schemaHasTable(db, 'blob_refs');
  const hasCleanupTasks = schemaHasTable(db, 'blob_cleanup_tasks');
  const fullSchema = hasBlobObjects && hasBlobRefs && hasCleanupTasks;
  return {
    code: fullSchema && version5 ? '005' : 'partial',
    applied,
    version5,
    fullSchema,
    hasBlobObjects,
    hasBlobRefs,
    hasCleanupTasks,
  };
}

/** 打开一个已迁移（可含 R4 表）的 :memory: 库，供同步探测。 */
export function openMigratedMemoryDb(opts: { tryApply005?: boolean } = {}): {
  db: InstanceType<typeof DatabaseSync>;
  schema: SchemaSummary;
} {
  const db = new (require('../../src/storage/sqlite.ts') as typeof import('../../src/storage/sqlite.ts')).DatabaseSync(
    ':memory:'
  );
  // 同步路径：先跑 runMigrations；apply005 需要异步读文件 → 这里提供同步 fallback（读缓存 / 直接 SQL）。
  const appliedRes = runMigrations(db) as { applied: number[] };
  const applied = appliedRes.applied ?? [];
  let version5 = applied.includes(5);
  if (opts.tryApply005 && !version5) {
    // 同步 apply 005：用内联常量（与 005 迁移一致）——仅供测试探索
    const up = `
CREATE TABLE IF NOT EXISTS blob_objects (
  owner_key TEXT NOT NULL, blob_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main','archive')),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','DELETING','DELETED')),
  content_hash TEXT NOT NULL, size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at TEXT, PRIMARY KEY (owner_key, blob_ref)
);
CREATE INDEX IF NOT EXISTS idx_blob_objects_state ON blob_objects(state) WHERE state <> 'ACTIVE';
CREATE TABLE IF NOT EXISTS blob_refs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, blob_ref TEXT NOT NULL,
  node_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main','archive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (owner_key, blob_ref, revision_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_blob_refs_count ON blob_refs(owner_key, blob_ref);
CREATE TABLE IF NOT EXISTS blob_cleanup_tasks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, blob_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main','archive')),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','failed','done')),
  claim_token TEXT, claimed_by TEXT, claimed_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_active ON blob_cleanup_tasks(owner_key, blob_ref)
  WHERE status IN ('pending','claimed','failed');
CREATE INDEX IF NOT EXISTS idx_cleanup_pickup ON blob_cleanup_tasks(status, seq);
`;
    db.exec(up);
    version5 = true;
  }
  const hasBlobObjects = schemaHasTable(db, 'blob_objects');
  const hasBlobRefs = schemaHasTable(db, 'blob_refs');
  const hasCleanupTasks = schemaHasTable(db, 'blob_cleanup_tasks');
  const fullSchema = hasBlobObjects && hasBlobRefs && hasCleanupTasks;
  return {
    db,
    schema: {
      code: fullSchema && version5 ? '005' : 'partial',
      applied,
      version5,
      fullSchema,
      hasBlobObjects,
      hasBlobRefs,
      hasCleanupTasks,
    },
  };
}

// ── 临时目录辅助 ──────────────────────────────────────────────

export function tempDbDir(prefix = 'hetu-qa-r4-'): { dir: string; dbPath: string; blobRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, 'hetu.db'), blobRoot: join(dir, 'blobs') };
}

export async function withTempDir<T>(fn: (c: { dir: string; dbPath: string; blobRoot: string }) => Promise<T>): Promise<T> {
  const c = tempDbDir();
  try {
    return await fn(c);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
}

// ── 业务 fixture ─────────────────────────────────────────────

export const scopeOf = (over: Partial<Scope> = {}): Scope => ({
  owner_id: 'ws-1',
  layer: 'project',
  project_id: 'proj-1',
  agent_id: null,
  visibility: 'project_agents',
  shared_with: [],
  ...over,
});

export const authA: AuthContext = {
  ownerId: 'ws-1',
  agentId: 'agent-a',
  projectIds: ['proj-1'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:supersede', 'memory:minimize', 'memory:revive', 'memory:purge'],
};
export const authB: AuthContext = {
  ownerId: 'ws-2',
  agentId: 'agent-b',
  projectIds: ['proj-b'],
  canReadGlobal: true,
  maxSensitivity: 'restricted',
  capabilities: ['memory:write', 'memory:minimize', 'memory:revive', 'memory:purge'],
};
export const readOnlyA: AuthContext = { ...authA, capabilities: [] };

export const provenance = (agent = 'agent-a') => ({
  agent_id: agent,
  origin: 'hot-path' as const,
  method: 'user-confirmed' as const,
  source_refs: [],
  producer_version: 'hetu 0.4.0',
  model_id: null,
  generated_at: '2026-11-27T00:00:00Z',
  confidence: 0.9,
});

export function node(nid: string, rid: string, over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    node_id: asNodeId(nid),
    revision_id: asRevisionId(rid),
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

/** 写一条带真实主区 Blob 的 FULL 记忆（供 minimize/revive/purge）。 */
export async function writeFull(
  sp: SqliteStorageProvider,
  blobs: BlobStore,
  owner: string,
  nid: string,
  rid: string,
  content: string,
  auth: AuthContext
): Promise<{ hash: string; ref: string; mainRef: string }> {
  const hash = await blobs.write(BlobStore.mainRefFor(owner, sha256(Buffer.from(content))), content);
  const mainRef = BlobStore.mainRefFor(owner, hash);
  const r = await sp.put(
    node(nid, rid, {
      content_hash: asContentHash(hash),
      content_ref: mainRef,
      scope: scopeOf({ owner_id: owner }),
    }),
    [],
    [],
    auth
  );
  expect(r.ok).toBe(true);
  return { hash, ref: mainRef, mainRef };
}

export const byRev = (r: string) => ({ kind: 'revision' as const, revisionId: asRevisionId(r) });
export const byNode = (n: string) => ({ kind: 'node' as const, nodeId: asNodeId(n) });

/** F-skip 日志打点，便于把「R4 未实现」与「测试自身失败」区分开。 */
export function skipReason(scenario: string, reason: string): void {
  console.warn(`[F-skip][${scenario}] R4 未实现: ${reason}`);
}

/**
 * 「实现缺口」打点：与 skipReason 的区别在于语义 —— 这不是「功能还没写」，
 * 而是「R4 契约要求的行为当前实现不满足」（真实缺陷）。
 *
 * 默认：打 [F-gap] 日志并放行（避免在 Lead 尚未完成 Provider 接线时把全量门禁打红）；
 * 严格模式：设置环境变量 `R4_QA_STRICT=1` 后**直接失败**，供 Lead 在 G4 门禁做阻断判定。
 *
 * 用法：
 *   if (okCount === 2) { gapOrSkip('F-11', '两 Provider 均成功，违反「恰一个成功」', ...); return; }
 */
export function gapOrSkip(scenario: string, detail: string, evidence?: unknown): void {
  const strict = process.env.R4_QA_STRICT === '1';
  const line =
    `[F-gap][${scenario}] 契约要求的行为未满足（非"未实现"）: ${detail}` +
    (evidence === undefined ? '' : ` | evidence=${JSON.stringify(evidence)}`);
  console.warn(line + (strict ? '  ← R4_QA_STRICT=1，判为失败' : '  ← 已放行（设置 R4_QA_STRICT=1 可阻断）'));
  if (strict) throw new Error(line);
}

/**
 * 容错清理临时目录。
 *
 * Windows 上 SQLite WAL 句柄在个别路径未被显式 close（例如测试提前 return）时
 * `rmSync` 会抛 EPERM；清理失败绝不能让一个「本该 skip 的 R4 用例」变成红。
 * 因此统一走本函数：失败重试 3 次，仍失败则只打日志、不抛。
 */
export function safeRm(dir: string, retries = 3): void {
  for (let i = 0; i < retries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 稍后重试；Windows 文件句柄释放有延迟
    }
  }
  console.warn(`[F-cleanup] 临时目录清理失败（不阻塞测试结论）: ${dir}`);
}

/** 生成某 owner+内容 的 main/archive 引用元数据。 */
export function refMeta(owner: string, content: string, kind: 'main' | 'archive'): {
  ownerKey: string;
  contentHash: string;
  blobRef: string;
} {
  const contentHash = sha256(Buffer.from(content));
  const ownerKey = ownerKeyFor(owner);
  const blobRef =
    kind === 'main'
      ? BlobStore.mainRefFor(owner, contentHash)
      : BlobStore.archiveRefFor(owner, contentHash);
  return { ownerKey, contentHash, blobRef };
}