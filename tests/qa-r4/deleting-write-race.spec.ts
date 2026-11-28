/**
 * F-5 · deleting-write-race —— Blob DELETING 后，另一 Agent 写相同内容 → 必须 BLOB_BUSY。
 *
 * R4 契约 §2/§4.2：DELETING 期间禁止登记新引用（也不得复活对象）。
 * 当一个 blob 进入 DELETING（已被认领、物理删除未完成前），另一 Agent 尝试把它用于新记忆
 * （登记引用并写盘）→ 必须返回 BLOB_BUSY（调用方等待并重试 3×50ms，仍不可用则失败）。
 *
 * 前置条件：005 台账 + blob-lifecycle + 真实 BlobStore（跨物理文件验证）+ 文件库两连接。
 * 并发方式：串行编排（先 claim → 再让另一连接 registerBlobRef + write）。
 * 预期：
 *  - cl1 claimForDeletion 成功；
 *  - cl2 registerBlobRef → BLOB_BUSY；cl2 的 blob.write 不得执行（或即便执行也不登记）；
 *  - blob_objects 停留 DELETING；物理文件未因 cl2 影响而复活。
 * 失败数据态：若实现未检查 state 就登记，cl2 会把新引用写进 DELETING 对象，造成
 *  「cleanup unlink 后，新引用指向已被删除的文件」→ 悬空引用 / 数据可读性损坏。
 *
 * 当前：005 未接入 → skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { } from 'node:fs';
import {
  BlobStore,
  runMigrations,
  tryImport,
  tempDbDir,
  skipReason,
  refMeta,
  safeRm } from './_helpers.ts';
import type * as lifecycleT from '../../src/storage/blob-lifecycle.ts';

function fileDb(path: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(path);
}

describe('F-5 · deleting-write-race', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };
  let lifecycle: typeof lifecycleT | null = null;

  beforeAll(async () => {
    c = tempDbDir('hetu-qa-r4-f5-');
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
  });

  it('DELETING 后另一 Agent 写同内容 → BLOB_BUSY 且对象不复活', async () => {
    if (!lifecycle) {
      skipReason('F-5', 'blob-lifecycle 未接入，跳过');
      return;
    }
    const cl1 = fileDb(c.dbPath);
    runMigrations(cl1);
    const hasRefs = cl1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get();
    if (!hasRefs) {
      skipReason('F-5', '005 未接入，无法在文件库建立 blob 台账，跳过');
      cl1.close();
      return;
    }

    const blobs = new BlobStore(c.blobRoot);
    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', 'deleting-race', 'main');

    // Agent A 登记引用 + 真实写盘
    lifecycle.registerBlobRef(cl1, { ownerKey, blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'main', contentHash });
    await blobs.write(blobRef, 'deleting-race');
    // A 归零 + 认领（进入 DELETING）
    cl1.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(ownerKey, blobRef);
    const claim = lifecycle.claimForDeletion(cl1, { ownerKey, blobRef, kind: 'main', worker: 'A' });
    expect(claim.ok).toBe(true);
    expect((cl1.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string }).state).toBe('DELETING');

    // Agent B 另一连接写相同内容
    const cl2 = fileDb(c.dbPath);
    const r = lifecycle.registerBlobRef(cl2, { ownerKey, blobRef, nodeId: 'mB', revisionId: 'rB1', kind: 'main', contentHash });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BLOB_BUSY');

    // 对象不复活
    const st = cl2.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string };
    expect(st.state).toBe('DELETING');

    cl1.close();
    cl2.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});