/** A-9 · 跨 owner 隔离：两 owner 写相同内容 hash → 两个独立物理文件；
 *  purge 一个 owner → 另一个文件仍在。
 *  真实 BlobStore 落盘断言（路径由 B 组 ownerKeyFor + mainRefFor 生成，契约 §1.1）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, stateOf } from './helpers/a-group.ts';
import { planPurge, registerBlobRef, runCleanup, refCountFor } from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

const CONTENT = 'cross-owner-same-content';
const HASH = sha256(CONTENT); // 'sha256:<64hex>'
const H = HASH.replace(/^sha256:/, '');
const OWNER_A = 'workspace-A';
const OWNER_B = 'workspace-B';

let db: ReturnType<typeof createDb>;
let root: string;
let blobs: BlobStore;
let refA: string;
let refB: string;

beforeEach(async () => {
  db = createDb();
  root = mkdtempSync(join(tmpdir(), 'hetu-a9-'));
  blobs = new BlobStore(root);
  refA = BlobStore.mainRefFor(OWNER_A, HASH);
  refB = BlobStore.mainRefFor(OWNER_B, HASH);
  await blobs.write(refA, CONTENT);
  await blobs.write(refB, CONTENT);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('A-9 · 跨 owner 隔离（真实文件）', () => {
  it('owner_key 是摘要而非原样 owner_id（owner_id 不进路径）', () => {
    expect(refA).toContain(ownerKeyFor(OWNER_A));
    expect(refA).not.toContain(OWNER_A);
    expect(refB).not.toContain(OWNER_B);
    expect(refA).not.toBe(refB);
  });

  it('同 Hash 两 owner → 两个独立物理文件，内容相同但路径不同', async () => {
    expect(existsSync(join(root, refA))).toBe(true);
    expect(existsSync(join(root, refB))).toBe(true);
    const a = await blobs.read(refA);
    const b = await blobs.read(refB);
    expect(a.toString('utf8')).toBe(CONTENT);
    expect(b.toString('utf8')).toBe(CONTENT);
    expect(sha256(a)).toBe(sha256(b)); // 内容同一 → 同 hash
  });

  it('★ purge ownerA → ownerA 文件被删，ownerB 文件仍在且可读', async () => {
    registerBlobRef(db, { ownerKey: ownerKeyFor(OWNER_A), blobRef: refA, nodeId: 'nA', revisionId: 'rA1', kind: 'main', contentHash: HASH });
    registerBlobRef(db, { ownerKey: ownerKeyFor(OWNER_B), blobRef: refB, nodeId: 'nB', revisionId: 'rB1', kind: 'main', contentHash: HASH });

    const planA = planPurge(db, {
      ownerKey: ownerKeyFor(OWNER_A),
      nodeId: 'nA',
      revisions: [{ revisionId: 'rA1', contentHash: HASH, contentRef: refA, minimizedBlobRef: null }],
      operator: 'agent-a',
      reason: 'user-request',
    });
    expect(planA.scheduled).toEqual([{ ref: refA, kind: 'main' }]);
    expect(planA.retained).toEqual([]);
    expect(stateOf(db, ownerKeyFor(OWNER_A), refA)).toBe('DELETING');
    expect(stateOf(db, ownerKeyFor(OWNER_B), refB)).toBe('ACTIVE');

    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.removed).toBe(1);
    expect(res.failed).toEqual([]);

    expect(stateOf(db, ownerKeyFor(OWNER_A), refA)).toBe('DELETED');
    expect(existsSync(join(root, refA))).toBe(false); // A 的文件已物理删除
    expect(existsSync(join(root, refB))).toBe(true); // B 的文件仍在
    expect((await blobs.read(refB)).toString('utf8')).toBe(CONTENT);
    expect(stateOf(db, ownerKeyFor(OWNER_B), refB)).toBe('ACTIVE');
  });

  it('owner 引用计数互不串台', () => {
    registerBlobRef(db, { ownerKey: ownerKeyFor(OWNER_A), blobRef: refA, nodeId: 'nA', revisionId: 'rA1', kind: 'main', contentHash: HASH });
    registerBlobRef(db, { ownerKey: ownerKeyFor(OWNER_B), blobRef: refB, nodeId: 'nB', revisionId: 'rB1', kind: 'main', contentHash: HASH });
    expect(refCountFor(db, ownerKeyFor(OWNER_A), refA)).toBe(1);
    expect(refCountFor(db, ownerKeyFor(OWNER_B), refB)).toBe(1);
    expect(refCountFor(db, ownerKeyFor(OWNER_A), refB)).toBe(0);
  });

  it('同一 owner 内同 Hash 复用同一物理文件（跨 revision 去重）', () => {
    registerBlobRef(db, { ownerKey: ownerKeyFor(OWNER_A), blobRef: refA, nodeId: 'n1', revisionId: 'r1', kind: 'main', contentHash: HASH });
    registerBlobRef(db, { ownerKey: ownerKeyFor(OWNER_A), blobRef: refA, nodeId: 'n2', revisionId: 'r2', kind: 'main', contentHash: HASH });
    const c = db
      .prepare('SELECT COUNT(*) c FROM blob_objects WHERE owner_key=?')
      .get(ownerKeyFor(OWNER_A)) as { c: number };
    expect(Number(c.c)).toBe(1); // 同 owner 同 hash = 一个对象
    expect(existsSync(join(root, refA))).toBe(true);
  });

  it('archive 也按 owner 隔离（内容寻址 + owner 前缀）', async () => {
    const archA = BlobStore.archiveRefFor(OWNER_A, HASH);
    const archB = BlobStore.archiveRefFor(OWNER_B, HASH);
    expect(archA).not.toBe(archB);
    await blobs.write(archA, CONTENT);
    await blobs.write(archB, CONTENT);
    expect(existsSync(join(root, archA))).toBe(true);
    expect(existsSync(join(root, archB))).toBe(true);
    expect(H).toHaveLength(64);
  });
});
