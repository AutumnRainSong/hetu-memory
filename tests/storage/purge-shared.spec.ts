/** A-8 · 共享 Blob 保护（契约 §5：retained 必须体现 refCount）。
 *
 *  前置：同 owner 内两个 revision（不同 node）引用同一主区 blob。
 *  预期：purge 其中一个 → blob 不入队、状态保持 ACTIVE、物理文件不删，
 *        另一个 revision 的引用仍在且文件可读。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, stateOf } from './helpers/a-group.ts';
import {
  planPurge,
  registerBlobRef,
  runCleanup,
  refCountFor,
} from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

const OWNER = 'shared-owner';
const OK = ownerKeyFor(OWNER);
const CONTENT = 'shared-blob-content';
const HASH = sha256(CONTENT);

let db: ReturnType<typeof createDb>;
let root: string;
let blobs: BlobStore;
let ref: string;

beforeEach(async () => {
  db = createDb();
  root = mkdtempSync(join(tmpdir(), 'hetu-a8-'));
  blobs = new BlobStore(root);
  ref = BlobStore.mainRefFor(OWNER, HASH);
  await blobs.write(ref, CONTENT);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('A-8 · 共享 Blob 保护', () => {
  it('★ 共享 blob：purge 其一后文件不删、另一 revision 引用仍在且可读', async () => {
    registerBlobRef(db, { ownerKey: OK, blobRef: ref, nodeId: 'n1', revisionId: 'r1', kind: 'main', contentHash: HASH });
    registerBlobRef(db, { ownerKey: OK, blobRef: ref, nodeId: 'n2', revisionId: 'r2', kind: 'main', contentHash: HASH });
    expect(refCountFor(db, OK, ref)).toBe(2);

    const plan = planPurge(db, {
      ownerKey: OK,
      nodeId: 'n1',
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: ref, minimizedBlobRef: null }],
      operator: 'agent-a',
      reason: 'user-request',
    });

    // 契约 §5：被保留的 blob 必须出现在 retained 并给 refCount
    expect(plan.scheduled).toEqual([]);
    expect(plan.retained).toEqual([{ ref, refCount: 1 }]);
    expect(stateOf(db, OK, ref)).toBe('ACTIVE');

    // 阶段二没有任务可跑 → 物理文件绝不被删
    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.attempted).toBe(0);
    expect(res.removed).toBe(0);
    expect(existsSync(join(root, ref))).toBe(true);
    expect(stateOf(db, OK, ref)).toBe('ACTIVE');

    // 另一 revision 仍可读同一 blob（引用仍在台账）
    const still = db
      .prepare('SELECT revision_id FROM blob_refs WHERE owner_key=? AND blob_ref=?')
      .all(OK, ref) as { revision_id: string }[];
    expect(still.map((s) => s.revision_id)).toEqual(['r2']);
    expect((await blobs.read(ref)).toString('utf8')).toBe(CONTENT);
  });

  it('引用归零后才可删除（两次 purge 依次进行）', async () => {
    registerBlobRef(db, { ownerKey: OK, blobRef: ref, nodeId: 'n1', revisionId: 'r1', kind: 'main', contentHash: HASH });
    registerBlobRef(db, { ownerKey: OK, blobRef: ref, nodeId: 'n2', revisionId: 'r2', kind: 'main', contentHash: HASH });

    const p1 = planPurge(db, {
      ownerKey: OK,
      nodeId: 'n1',
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: ref, minimizedBlobRef: null }],
      operator: 'x',
      reason: 'r',
    });
    expect(p1.retained).toEqual([{ ref, refCount: 1 }]);
    expect(stateOf(db, OK, ref)).toBe('ACTIVE');

    const p2 = planPurge(db, {
      ownerKey: OK,
      nodeId: 'n2',
      revisions: [{ revisionId: 'r2', contentHash: HASH, contentRef: ref, minimizedBlobRef: null }],
      operator: 'x',
      reason: 'r',
    });
    expect(p2.scheduled).toEqual([{ ref, kind: 'main' }]);
    expect(stateOf(db, OK, ref)).toBe('DELETING');

    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.removed).toBe(1);
    expect(stateOf(db, OK, ref)).toBe('DELETED');
    expect(existsSync(join(root, ref))).toBe(false);
  });

  it('3 个引用逐个归零（retained.refCount 精确递减）', async () => {
    const refs: [string, string][] = [
      ['n1', 'r1'],
      ['n2', 'r2'],
      ['n3', 'r3'],
    ];
    for (const [node, rev] of refs)
      registerBlobRef(db, { ownerKey: OK, blobRef: ref, nodeId: node, revisionId: rev, kind: 'main', contentHash: HASH });
    expect(refCountFor(db, OK, ref)).toBe(3);

    for (let i = 0; i < 2; i++) {
      const [node, rev] = refs[i];
      const p = planPurge(db, {
        ownerKey: OK,
        nodeId: node,
        revisions: [{ revisionId: rev, contentHash: HASH, contentRef: ref, minimizedBlobRef: null }],
        operator: 'x',
        reason: 'r',
      });
      expect(p.retained).toEqual([{ ref, refCount: 2 - i }]);
      expect(stateOf(db, OK, ref)).toBe('ACTIVE');
    }

    const p3 = planPurge(db, {
      ownerKey: OK,
      nodeId: 'n3',
      revisions: [{ revisionId: 'r3', contentHash: HASH, contentRef: ref, minimizedBlobRef: null }],
      operator: 'x',
      reason: 'r',
    });
    expect(p3.scheduled).toEqual([{ ref, kind: 'main' }]);
    expect(refCountFor(db, OK, ref)).toBe(0);
  });

  it('DELETING 期间新引用登记被拒绝（BLOB_BUSY，不复活）', async () => {
    const { registerBlobRef: reg } = await import('../../src/storage/blob-lifecycle.ts');
    registerBlobRef(db, { ownerKey: OK, blobRef: ref, nodeId: 'n1', revisionId: 'r1', kind: 'main', contentHash: HASH });
    const p = planPurge(db, {
      ownerKey: OK,
      nodeId: 'n1',
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: ref, minimizedBlobRef: null }],
      operator: 'x',
      reason: 'r',
    });
    expect(p.scheduled).toHaveLength(1);
    expect(stateOf(db, OK, ref)).toBe('DELETING');
    // 认领后、物理删除前的窗口内，新写入必须被拒（契约 §2.1 禁止 DELETING 登记新引用）
    expect(
      reg(db, { ownerKey: OK, blobRef: ref, nodeId: 'n9', revisionId: 'r9', kind: 'main', contentHash: HASH })
    ).toEqual({ ok: false, error: 'BLOB_BUSY' });
    expect(refCountFor(db, OK, ref)).toBe(0);
  });
});
