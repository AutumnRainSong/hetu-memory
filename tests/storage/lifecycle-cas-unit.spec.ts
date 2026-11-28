/** C 组 · lifecycle-cas 纯函数单元测试（R4，P0）
 *  前置：仅需 node:sqlite（node 22+）。不触碰 sqlite-provider.ts / blob-store.ts。
 *  验证：buildMinimizeUpdate / buildReviveUpdate 的 SQL 与参数正确；
 *        在真实 DatabaseSync 上执行，条件不满足时 changes===0（不误报成功）；
 *        assertSingleRow 的判定；recordOrphanForCleanup 的幂等登记。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import {
  buildMinimizeUpdate,
  buildReviveUpdate,
  assertSingleRow,
  recordOrphanForCleanup,
  type CasUpdateSpec,
} from '../../src/storage/lifecycle-cas.ts';

const MINIMIZE_SQL = `UPDATE nodes
SET content_state='MINIMIZED',
    stub_summary=COALESCE(stub_summary, ?),
    minimized_blob_ref=?,
    minimized_blob_hash=?
WHERE revision_id=? AND version_state='CURRENT' AND content_state='FULL'`;
const REVIVE_SQL = `UPDATE nodes
SET content_state='FULL',
    content_ref=COALESCE(content_ref, ?),
    minimized_blob_ref=NULL,
    minimized_blob_hash=NULL
WHERE revision_id=? AND version_state='CURRENT' AND content_state='MINIMIZED'
  AND minimized_blob_ref=? AND minimized_blob_hash=?`;

describe('C-1 · buildMinimizeUpdate', () => {
  it('产出符合契约的 SQL 与正确参数顺序', () => {
    const spec: CasUpdateSpec = buildMinimizeUpdate({
      revisionId: 'r1',
      archiveRef: 'workspaces/k/archive/ab/abcdef',
      archiveHash: 'sha256:abc',
      stubSummary: '精简摘要',
    });
    expect(spec.sql.replace(/\s+/g, ' ').trim()).toBe(MINIMIZE_SQL.replace(/\s+/g, ' ').trim());
    expect(spec.params).toEqual([
      '精简摘要',
      'workspaces/k/archive/ab/abcdef',
      'sha256:abc',
      'r1',
    ]);
  });

  it('条件命中（CURRENT+FULL）→ changes===1', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE nodes(revision_id TEXT PRIMARY KEY, content_state TEXT, version_state TEXT,
      stub_summary TEXT, minimized_blob_ref TEXT, minimized_blob_hash TEXT)`);
    db.prepare(`INSERT INTO nodes VALUES('r1','FULL','CURRENT',NULL,NULL,NULL)`).run();
    const spec = buildMinimizeUpdate({
      revisionId: 'r1',
      archiveRef: 'archive/x',
      archiveHash: 'sha256:x',
      stubSummary: '摘要',
    });
    const r = db.prepare(spec.sql).run(...spec.params);
    expect(r.changes).toBe(1);
    const row = db.prepare(`SELECT * FROM nodes WHERE revision_id='r1'`).get() as any;
    expect(row.content_state).toBe('MINIMIZED');
    expect(row.minimized_blob_ref).toBe('archive/x');
    expect(row.minimized_blob_hash).toBe('sha256:x');
    expect(row.stub_summary).toBe('摘要');
  });

  it('非 CURRENT / 非 FULL → changes===0 且状态不变', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE nodes(revision_id TEXT PRIMARY KEY, content_state TEXT, version_state TEXT,
      stub_summary TEXT, minimized_blob_ref TEXT, minimized_blob_hash TEXT)`);
    db.prepare(`INSERT INTO nodes VALUES('r1','MINIMIZED','CURRENT',NULL,'archive/x','sha256:x')`).run();
    db.prepare(`INSERT INTO nodes VALUES('r2','FULL','SUPERSEDED',NULL,NULL,NULL)`).run();
    const spec = buildMinimizeUpdate({
      revisionId: 'r1',
      archiveRef: 'archive/x',
      archiveHash: 'sha256:x',
      stubSummary: '摘要',
    });
    // 已 MINIMIZED 再 minimize → 0 行
    expect(db.prepare(spec.sql).run(...spec.params).changes).toBe(0);
    // SUPERSEDED 的 FULL → 0 行
    expect(
      db
        .prepare(spec.sql)
        .run('摘要', 'archive/x', 'sha256:x', 'r2').changes
    ).toBe(0);
  });
});

describe('C-2 · buildReviveUpdate', () => {
  it('产出符合契约的 SQL 与正确参数顺序', () => {
    const spec = buildReviveUpdate({
      revisionId: 'r1',
      expectedRef: 'archive/x',
      expectedHash: 'sha256:x',
      mainRef: 'blobs/ab/abcdef',
    });
    expect(spec.sql.replace(/\s+/g, ' ').trim()).toBe(REVIVE_SQL.replace(/\s+/g, ' ').trim());
    expect(spec.params).toEqual(['blobs/ab/abcdef', 'r1', 'archive/x', 'sha256:x']);
  });

  it('条件命中（CURRENT+MINIMIZED+ref/hash 一致）→ changes===1', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE nodes(revision_id TEXT PRIMARY KEY, content_state TEXT, version_state TEXT,
      content_ref TEXT, minimized_blob_ref TEXT, minimized_blob_hash TEXT)`);
    db.prepare(`INSERT INTO nodes VALUES('r1','MINIMIZED','CURRENT',NULL,'archive/x','sha256:x')`).run();
    const spec = buildReviveUpdate({
      revisionId: 'r1',
      expectedRef: 'archive/x',
      expectedHash: 'sha256:x',
      mainRef: 'blobs/ab/abcdef',
    });
    expect(db.prepare(spec.sql).run(...spec.params).changes).toBe(1);
    const row = db.prepare(`SELECT * FROM nodes WHERE revision_id='r1'`).get() as any;
    expect(row.content_state).toBe('FULL');
    expect(row.content_ref).toBe('blobs/ab/abcdef');
    expect(row.minimized_blob_ref).toBeNull();
    expect(row.minimized_blob_hash).toBeNull();
  });

  it('ref 或 hash 不一致 → changes===0（防止复活被替换的归档）', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE nodes(revision_id TEXT PRIMARY KEY, content_state TEXT, version_state TEXT,
      content_ref TEXT, minimized_blob_ref TEXT, minimized_blob_hash TEXT)`);
    db.prepare(`INSERT INTO nodes VALUES('r1','MINIMIZED','CURRENT',NULL,'archive/x','sha256:x')`).run();
    const spec = buildReviveUpdate({
      revisionId: 'r1',
      expectedRef: 'archive/other', // 与库中存档不一致
      expectedHash: 'sha256:x',
      mainRef: 'blobs/ab/abcdef',
    });
    expect(db.prepare(spec.sql).run(...spec.params).changes).toBe(0);
  });
});

describe('C-3 · assertSingleRow', () => {
  it('changes===1 → ok:true', () => {
    expect(assertSingleRow(1)).toEqual({ ok: true });
  });
  it('changes===0 → STATE_CONFLICT（绝不报成功）', () => {
    expect(assertSingleRow(0)).toEqual({ ok: false, error: 'STATE_CONFLICT' });
  });
  it('非 1 的数值/类型 → STATE_CONFLICT', () => {
    expect(assertSingleRow(2)).toEqual({ ok: false, error: 'STATE_CONFLICT' });
    expect(assertSingleRow(NaN)).toEqual({ ok: false, error: 'STATE_CONFLICT' });
    expect(assertSingleRow(-1)).toEqual({ ok: false, error: 'STATE_CONFLICT' });
  });
});

describe('C-4 · recordOrphanForCleanup 幂等登记', () => {
  let db: InstanceType<typeof DatabaseSync>;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE blob_cleanup_tasks (
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
    db.exec(`CREATE UNIQUE INDEX idx_cleanup_active
      ON blob_cleanup_tasks(owner_key, blob_ref) WHERE status IN ('pending','claimed','failed')`);
  });

  it('新孤儿 → 登记成功 enqueued:true 且仅一条', () => {
    const r = recordOrphanForCleanup(db as any, {
      ownerKey: 'owner-key-1',
      blobRef: 'workspaces/owner-key-1/archive/ab/abcdef',
      kind: 'archive',
    });
    expect(r).toEqual({ ok: true, enqueued: true });
    const rows = db.prepare('SELECT * FROM blob_cleanup_tasks').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      owner_key: 'owner-key-1',
      blob_ref: 'workspaces/owner-key-1/archive/ab/abcdef',
      kind: 'archive',
      status: 'pending',
    });
  });

  it('重复登记同一孤儿 → 幂等忽略 enqueued:false，不产生重复任务', () => {
    recordOrphanForCleanup(db as any, {
      ownerKey: 'k',
      blobRef: 'archive/x',
      kind: 'archive',
    });
    const second = recordOrphanForCleanup(db as any, {
      ownerKey: 'k',
      blobRef: 'archive/x',
      kind: 'archive',
    });
    expect(second).toEqual({ ok: true, enqueued: false });
    const rows = db.prepare('SELECT * FROM blob_cleanup_tasks').all() as any[];
    expect(rows.length).toBe(1);
  });
});