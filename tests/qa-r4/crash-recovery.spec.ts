/**
 * F-6 · crash-recovery —— 删除中进程中断 → 重启后 reconcile 恢复。
 *
 * R4 契约 §4.3/§5/A-6：阶段二（物理删除）是可重入的；进程在「领取任务 → unlink → 推进 DELETED」
 * 中途崩溃，重启后 blob_objects 仍处 DELETING、blob_cleanup_tasks 处 claimed（或 pending/failed），
 * 由 reconcileBlobs 补偿完成物理删除并推进到 DELETED。
 *
 * 前置条件：005 台账 + blob-lifecycle(reconcileBlobs) + 真实 BlobStore + 文件库。
 * 并发方式：模拟崩溃 —— 建态（登记+认领+已 unlink 但未推进状态）→ 关闭（close）→ 重开新连接
 *   → reconcile() 恢复。
 * 预期：
 *  - 崩溃前会话：claimForDeletion 建 DELETING + 任务 claimed；物理文件仍存在；
 *  - 重开新连接（同库同 blobRoot）调用 reconcileBlobs()：物理文件被删除、对象 → DELETED、
 *    任务 done（随后被清理）；
 *  - hadPending=true、filesRemoved>=1。
 * 失败数据态：若崩溃后无补偿，物理文件残留、对象长期 DELETING、任务 stuck claimed
 *   （claimed_at 未超时）→ 无法被再次领取，磁盘泄漏。
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

describe('F-6 · crash-recovery', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };
  let lifecycle: typeof lifecycleT | null = null;

  beforeAll(async () => {
    c = tempDbDir('hetu-qa-r4-f6-');
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
  });

  it('崩溃中断后重新打开并 reconcile → 物理文件清除、对象 DELETED、任务 done', async () => {
    if (!lifecycle) {
      skipReason('F-6', 'blob-lifecycle 未接入，跳过');
      return;
    }
    const cl1 = fileDb(c.dbPath);
    runMigrations(cl1);
    const hasRefs = cl1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get();
    if (!hasRefs) {
      skipReason('F-6', '005 未接入，无法建立 blob 台账，跳过');
      cl1.close();
      return;
    }

    const blobs = new BlobStore(c.blobRoot);
    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', 'crash-content', 'main');

    // ① 登记 + 真实写盘
    lifecycle.registerBlobRef(cl1, { ownerKey, blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'main', contentHash });
    await blobs.write(blobRef, 'crash-content');
    expect(await blobs.exists(blobRef)).toBe(true);
    // ② 归零 + 认领 → DELETING + claimed 任务
    cl1.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(ownerKey, blobRef);
    const claim = lifecycle.claimForDeletion(cl1, { ownerKey, blobRef, kind: 'main', worker: 'W' });
    expect(claim.ok).toBe(true);
    expect(claim.ok && 'seq' in claim ? claim.seq : 0).toBeGreaterThan(0);
    const task = cl1.prepare('SELECT status FROM blob_cleanup_tasks WHERE seq=?').get(
      claim.ok && 'seq' in claim ? claim.seq : 0
    ) as { status: string };
    expect(task.status).toBe('claimed');
    // ③ 模拟崩溃：不执行 unlink、直接关闭连接（物理文件仍在）
    cl1.close();

    // ④ 重启：新连接 + 同一 BlobStore
    const cl2 = fileDb(c.dbPath);
    runMigrations(cl2);
    const blobs2 = new BlobStore(c.blobRoot);
    // reconcile 补偿
    const res = await lifecycle.reconcileBlobs(cl2, blobs2, { worker: 'W' });
    expect(res.hadPending).toBe(true);
    expect(res.filesRemoved).toBeGreaterThanOrEqual(1);
    expect(await blobs2.exists(blobRef)).toBe(false);
    const obj = cl2.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string };
    expect(obj.state).toBe('DELETED');
    // done 任务被清理
    const remaining = cl2.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { c: number };
    expect(Number(remaining.c)).toBe(0);

    cl2.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});