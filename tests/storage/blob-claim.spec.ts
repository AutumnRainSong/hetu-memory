/** A-3 · claimForDeletion：原子删除认领（契约 §4.1）。
 *
 *  唯一正确解法：`UPDATE … WHERE … AND NOT EXISTS(subquery)` 单条 SQL 内完成
 *  「读引用数 + 改状态」，用 `changes===1` 作为唯一成功判据。
 *  ★ 必须有失败用例：引用未归零时认领失败（EXECUTION-PLAN §八 风险项）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, stateOf, seedBlobRef, taskSeqFor } from './helpers/a-group.ts';
import { claimForDeletion, registerBlobRef, refCountFor } from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

const OWNER = 'claim-owner';
const OK = ownerKeyFor(OWNER);
const HASH = sha256('claim-content');
const REF = BlobStore.mainRefFor(OWNER, HASH);

let db: ReturnType<typeof createDb>;
beforeEach(() => {
  db = createDb();
});

describe('A-3 · claimForDeletion 原子认领', () => {
  it('引用归零 + ACTIVE → 认领成功：对象 DELETING + 同事务插入 claimed 任务', () => {
    registerBlobRef(db, { ownerKey: OK, blobRef: REF, nodeId: 'n1', revisionId: 'r1', kind: 'main', contentHash: HASH });
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(OK, REF);

    const r = claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.claimToken).toBeTruthy();
    expect(stateOf(db, OK, REF)).toBe('DELETING');

    const t = db
      .prepare(
        'SELECT status, claim_token, claimed_by, claimed_at FROM blob_cleanup_tasks WHERE seq=?'
      )
      .get(r.seq) as {
      status: string;
      claim_token: string;
      claimed_by: string;
      claimed_at: string;
    };
    expect(t.status).toBe('claimed');
    expect(t.claim_token).toBe(r.claimToken);
    expect(t.claimed_by).toBe('w1');
    expect(t.claimed_at).toBeTruthy();
  });

  it('★ 引用未归零 → 认领失败 HAS_REFS，对象保持 ACTIVE，任务不残留', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: 'n1', revisionId: 'r1' });
    const r = claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('HAS_REFS');
    expect(stateOf(db, OK, REF)).toBe('ACTIVE'); // 绝不误删
    expect(taskSeqFor(db, OK, REF)).toBeUndefined();
    expect(refCountFor(db, OK, REF)).toBe(1);
  });

  it('★ 两 revision 共享：只删一条引用仍 HAS_REFS；两条都删才可认领', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: 'n1', revisionId: 'r1' });
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: 'n2', revisionId: 'r2' });
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=? AND revision_id=?').run(OK, REF, 'r1');

    const r1 = claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('HAS_REFS');
    expect(stateOf(db, OK, REF)).toBe('ACTIVE');

    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=? AND revision_id=?').run(OK, REF, 'r2');
    const r2 = claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' });
    expect(r2.ok).toBe(true);
    expect(stateOf(db, OK, REF)).toBe('DELETING');
  });

  it('对象为 DELETED → NOT_ACTIVE（不复活、不改状态）', () => {
    db.prepare(
      `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
       VALUES(?,?,'main','DELETED',?)`
    ).run(OK, REF, HASH);
    const r = claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_ACTIVE');
    expect(stateOf(db, OK, REF)).toBe('DELETED');
  });

  it('对象不存在 → NOT_ACTIVE（不臆造对象）', () => {
    const r = claimForDeletion(db, {
      ownerKey: OK,
      blobRef: 'workspaces/none/blobs/aa/bb',
      kind: 'main',
      worker: 'w1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_ACTIVE');
    expect(
      db.prepare('SELECT 1 FROM blob_objects WHERE blob_ref=?').get('workspaces/none/blobs/aa/bb')
    ).toBeUndefined();
  });

  it('已 DELETING → 二次认领 NOT_ACTIVE（changes===0 且无引用），不重复插任务', () => {
    registerBlobRef(db, { ownerKey: OK, blobRef: REF, nodeId: 'n1', revisionId: 'r1', kind: 'main', contentHash: HASH });
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(OK, REF);
    expect(claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' }).ok).toBe(true);
    const r2 = claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('NOT_ACTIVE');
    const c = db
      .prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks WHERE owner_key=? AND blob_ref=?')
      .get(OK, REF) as { c: number };
    expect(Number(c.c)).toBe(1); // 只有第一次认领插入的任务
  });

  it('认领是 owner 维度的：A owner 已 DELETING 不影响 B owner 同名 ref 的认领', () => {
    const OWNER_B = 'claim-owner-b';
    const OKB = ownerKeyFor(OWNER_B);
    const REFB = BlobStore.mainRefFor(OWNER_B, HASH);
    // 同 hash → ref 字符串相同（内容寻址），但 owner_key 不同
    const HASH_SAME = HASH;
    registerBlobRef(db, { ownerKey: OK, blobRef: REF, nodeId: 'nA', revisionId: 'rA', kind: 'main', contentHash: HASH_SAME });
    registerBlobRef(db, { ownerKey: OKB, blobRef: REFB, nodeId: 'nB', revisionId: 'rB', kind: 'main', contentHash: HASH_SAME });
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(OK, REF);

    expect(claimForDeletion(db, { ownerKey: OK, blobRef: REF, kind: 'main', worker: 'w1' }).ok).toBe(true);
    expect(stateOf(db, OKB, REFB)).toBe('ACTIVE'); // B 不受影响
    expect(refCountFor(db, OKB, REFB)).toBe(1);
  });

  it('原子性断言：单条 SQL 同时含 state 判据与 NOT EXISTS 子查询、用 changes 判定', () => {
    const src = claimForDeletion.toString();
    expect(src).toMatch(/state='ACTIVE'/);
    expect(src).toMatch(/NOT EXISTS/);
    expect(src).toMatch(/changes/);
  });
});
