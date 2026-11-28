/**
 * F-8 · shared-ref-protection —— 共享引用未归零 → Purge 不删物理文件。
 *
 * R4 契约 §5/A-8/A-4：Purge 阶段一在事务内「删本 node 的引用 + 对候选 blob 原子认领」；
 * 若某 blob 仍有**其它** node/revision 的引用（共享），claimForDeletion 的 NOT EXISTS 判定必须失败
 * （HAS_REFS）→ 该 blob 不被认领、不进清理队列；物理文件保留；在 PurgeOutcome.retained 明确列出。
 *
 * 前置条件：005 台账 + blob-lifecycle(planPurge/claimForDeletion/refCountFor) + 文件库。
 * 并发方式：串行 —— 让两个 node 共享同一 blob_ref，Purge 其中 node 后共享 blob 必须被 protected。
 * 预期：
 *  - purge node A（其 revision 持有 blob X 引用）→ 其它 node B 仍持 X 引用 → claim X 失败 HAS_REFS；
 *  - X 的 blob_objects 保持 ACTIVE；文件仍存在；未产生 X 的 cleanup_task；
 *  - purge 结果 retained 含 { ref:X, refCount>=1 }。
 * 失败数据态：若实现不检查索引直接删，共享 blob 会被 unlink → node B 的引用指向已删除文件，
 *  数据丢失（P0）。
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

describe('F-8 · shared-ref-protection', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };
  let lifecycle: typeof lifecycleT | null = null;

  beforeAll(async () => {
    c = tempDbDir('hetu-qa-r4-f8-');
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
  });

  it('共享 blob：Purge 其一引用 → 另一引用仍持有时不可认领、文件保留', async () => {
    if (!lifecycle) {
      skipReason('F-8', 'blob-lifecycle 未接入，跳过');
      return;
    }
    const cl1 = new DatabaseSync(c.dbPath);
    runMigrations(cl1);
    if (!skipIfNoSchema(cl1)) return;

    const blobs = new BlobStore(c.blobRoot);
    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', SHARED, 'main');
    const regA = lifecycle.registerBlobRef(cl1, { ownerKey, blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'main', contentHash });
    const regB = lifecycle.registerBlobRef(cl1, { ownerKey, blobRef, nodeId: 'mB', revisionId: 'rB1', kind: 'main', contentHash });
    expect(regA.ok).toBe(true);
    expect(regB.ok).toBe(true);
    await blobs.write(blobRef, SHARED);

    // Purge node A：planPurge(in-memory revisions 结构)
    const plan = lifecycle.planPurge(cl1, {
      ownerKey,
      nodeId: 'mA',
      operator: 'agent-test',
      reason: 'user-request',
      revisions: [{ revisionId: 'rA1', contentHash, contentRef: blobRef, minimizedBlobRef: null }],
      worker: 'W',
    });
    // 应 retained：因为 mB 仍持引用
    expect(plan.retained.some((r) => r.ref === blobRef)).toBe(true);
    expect(plan.scheduled.some((s) => s.ref === blobRef)).toBe(false);
    // 无该 blob 清理任务
    const tasks = cl1.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks WHERE blob_ref=?').get(blobRef) as { c: number };
    expect(Number(tasks.c)).toBe(0);
    // 对象仍 ACTIVE，物理文件仍在
    const st = cl1.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string };
    expect(st.state).toBe('ACTIVE');
    expect(await blobs.exists(blobRef)).toBe(true);

    cl1.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});

const SHARED = '这一份内容被两个 node 共享，绝不能因其中一个被 Purge 而物理删除。';

function skipIfNoSchema(db: InstanceType<typeof DatabaseSync>): boolean {
  const hasRefs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get();
  if (!hasRefs) {
    skipReason('F-8', '005 未接入，跳过');
    db.close();
    return false;
  }
  return true;
}