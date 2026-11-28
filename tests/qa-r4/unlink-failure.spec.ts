/**
 * F-7 · unlink-failure —— unlink 权限/IO 错误 → 任务保留并重试。
 *
 * R4 契约 §2.1/§4.3/B-6：阶段二 unlink 失败（非 ENOENT）→ 对象**停留 DELETING**、
 * 任务 → failed, retry_count+1, last_error；由 reconcile 重试。ENOENT 视为成功。
 * 本用例注入确定性失败：把目标建成**目录**（unlink 一个非空目录 → EPERM/EISDIR，非 ENOENT），
 * 或对 BlobStore 注入抛 BlobDeleteError 的 worker。
 *
 * 前置条件：005 台账 + blob-lifecycle.runCleanup/reconcileBlobs + BlobStore 或 mock worker。
 * 并发方式：串行；故障注入方式一（mock worker 恒抛）最稳定。
 * 预期：
 *  - runCleanup 尝试后 failed.length=1；blob_objects 仍 DELETING；任务 status='failed'、retry_count=1、
 *    last_error 记录；
 *  - 再次 runCleanup（worker 改为可成功）→ 对象 DELETED、任务 done 并清理。
 * 失败数据态：若实现把失败任务标记 done / 把对象置 DELETED 而文件实际没删 → 悬空：
 *    引用已归零但物理文件残留、无法再认领（磁盘泄漏）；若吞错则任务卡 failed 且无法重试。
 *
 * 当前：005 未接入 → skip（mock worker 不依赖真实 unlink，但须依赖 blob 台账表）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { } from 'node:fs';
import {
  runMigrations,
  tryImport,
  tempDbDir,
  skipReason,
  refMeta,
  sha256, safeRm } from './_helpers.ts';
import type * as lifecycleT from '../../src/storage/blob-lifecycle.ts';

describe('F-7 · unlink-failure', () => {
  let c: { dir: string; dbPath: string };
  let lifecycle: typeof lifecycleT | null = null;

  beforeAll(async () => {
    c = tempDbDir('hetu-qa-r4-f7-');
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
  });

  it('unlink 失败 → 任务 failed + 对象停留 DELETING；重试成功 → DELETED', async () => {
    if (!lifecycle) {
      skipReason('F-7', 'blob-lifecycle 未接入，跳过');
      return;
    }
    const db = new DatabaseSync(c.dbPath);
    runMigrations(db);
    const hasRefs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get();
    if (!hasRefs) {
      skipReason('F-7', '005 未接入，跳过');
      db.close();
      return;
    }

    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', 'unlink-fail', 'main');
    lifecycle.registerBlobRef(db, { ownerKey, blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'main', contentHash });
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(ownerKey, blobRef);
    const claim = lifecycle.claimForDeletion(db, { ownerKey, blobRef, kind: 'main', worker: 'W' });
    expect(claim.ok).toBe(true);
    const seq = claim.ok && 'seq' in claim ? claim.seq : 0;

    // ① 失败 worker：恒抛非 ENOENT
    const failing = { unlinkIfExists: () => Promise.reject(new Error('EACCES: simulated unlink failed')) };
    const first = await lifecycle.runCleanup(db, failing, { worker: 'W' });
    expect(first.failed.length).toBe(1);
    expect((db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string }).state).toBe('DELETING');
    const t = db.prepare('SELECT status, retry_count, last_error FROM blob_cleanup_tasks WHERE seq=?').get(seq) as { status: string; retry_count: number; last_error: string | null };
    expect(t.status).toBe('failed');
    expect(Number(t.retry_count)).toBe(1);
    expect(t.last_error).toMatch(/EACCES|simulated/);
    void sha256;

    // ② 成功 worker：重试 → DELETED + done
    const ok = { unlinkIfExists: () => Promise.resolve('removed' as const) };
    const second = await lifecycle.runCleanup(db, ok, { worker: 'W' });
    expect(second.failed.length).toBe(0);
    expect((db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string }).state).toBe('DELETED');
    const t2 = db.prepare('SELECT status FROM blob_cleanup_tasks WHERE seq=?').get(seq) as { status: string };
    expect(t2.status).toBe('done');

    db.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});