/** A-2 · registerBlobRef（契约 §4.2）：
 *  ACTIVE → 正常登记；DELETING → BLOB_BUSY；DELETED → 复活 ACTIVE 后登记；UNIQUE 幂等。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, stateOf } from './helpers/a-group.ts';
import { registerBlobRef, refCountFor } from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

const OWNER = 'register-owner';
const OK = ownerKeyFor(OWNER);
const HASH = sha256('register-content');
const REF = BlobStore.mainRefFor(OWNER, HASH);
const ARCH = BlobStore.archiveRefFor(OWNER, HASH);

let db: ReturnType<typeof createDb>;
beforeEach(() => {
  db = createDb();
});

const reg = (over: Partial<Parameters<typeof registerBlobRef>[1]> = {}) =>
  registerBlobRef(db, {
    ownerKey: OK,
    blobRef: REF,
    nodeId: 'n1',
    revisionId: 'r1',
    kind: 'main',
    contentHash: HASH,
    ...over,
  });

describe('A-2 · registerBlobRef', () => {
  it('新对象：登记为 ACTIVE 并写入 blob_refs', () => {
    expect(reg({ sizeBytes: 12 })).toEqual({ ok: true });
    expect(stateOf(db, OK, REF)).toBe('ACTIVE');
    expect(refCountFor(db, OK, REF)).toBe(1);
    const row = db
      .prepare(
        'SELECT kind, content_hash, size_bytes, deleted_at FROM blob_objects WHERE owner_key=? AND blob_ref=?'
      )
      .get(OK, REF) as {
      kind: string;
      content_hash: string;
      size_bytes: number;
      deleted_at: string | null;
    };
    expect(row.kind).toBe('main');
    expect(row.content_hash).toBe(HASH);
    expect(Number(row.size_bytes)).toBe(12);
    expect(row.deleted_at).toBeNull();
  });

  it('★ DELETING 状态 → BLOB_BUSY，拒绝登记且不复活', () => {
    db.prepare(
      `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
       VALUES(?,?,'main','DELETING',?)`
    ).run(OK, REF, HASH);
    expect(reg()).toEqual({ ok: false, error: 'BLOB_BUSY' });
    expect(stateOf(db, OK, REF)).toBe('DELETING');
    expect(refCountFor(db, OK, REF)).toBe(0); // 未登记
  });

  it('DELETED 状态 → 复活为 ACTIVE + 清空 deleted_at，然后登记', () => {
    db.prepare(
      `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash, deleted_at)
       VALUES(?,?,'main','DELETED',?, datetime('now'))`
    ).run(OK, REF, HASH);
    expect(reg()).toEqual({ ok: true });
    expect(stateOf(db, OK, REF)).toBe('ACTIVE');
    const row = db
      .prepare('SELECT deleted_at FROM blob_objects WHERE owner_key=? AND blob_ref=?')
      .get(OK, REF) as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
    expect(refCountFor(db, OK, REF)).toBe(1);
  });

  it('幂等：同一 revision 重复登记不增长引用数', () => {
    for (let i = 0; i < 3; i++) expect(reg()).toEqual({ ok: true });
    expect(refCountFor(db, OK, REF)).toBe(1);
  });

  it('不同 revision 登记同一 blob → 引用累加（共享引用）', () => {
    reg({ nodeId: 'n1', revisionId: 'r1' });
    reg({ nodeId: 'n2', revisionId: 'r2' });
    expect(refCountFor(db, OK, REF)).toBe(2);
  });

  it('main / archive 各自独立登记与计数', () => {
    reg({ kind: 'main' });
    reg({ kind: 'archive', blobRef: ARCH });
    expect(refCountFor(db, OK, REF)).toBe(1);
    expect(refCountFor(db, OK, ARCH)).toBe(1);
    expect(stateOf(db, OK, ARCH)).toBe('ACTIVE');
  });

  it('owner 隔离：同 owner_id 不同 owner_key 不共享对象（跨 owner 永不共享）', () => {
    const OK2 = ownerKeyFor('register-owner-2');
    reg();
    const r = registerBlobRef(db, {
      ownerKey: OK2,
      blobRef: REF, // 同 ref 字符串
      nodeId: 'nX',
      revisionId: 'rX',
      kind: 'main',
      contentHash: HASH,
    });
    expect(r).toEqual({ ok: true });
    const c = db.prepare('SELECT COUNT(*) c FROM blob_objects').get() as { c: number };
    expect(Number(c.c)).toBe(2); // 两个 owner 各一行
    expect(refCountFor(db, OK, REF)).toBe(1);
    expect(refCountFor(db, OK2, REF)).toBe(1);
  });
});
