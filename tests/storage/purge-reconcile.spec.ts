/** A-6 · reconcileBlobs 补偿：重跑清理（pending/failed/超时 claimed）+ 清理 done 陈旧任务。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, stateOf } from './helpers/a-group.ts';
import { reconcileBlobs, runCleanup, type WorkerLike } from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

const OWNER = 'reconcile-owner';
const OK = ownerKeyFor(OWNER);
const HASH = sha256('reconcile-content');
const REF = BlobStore.mainRefFor(OWNER, HASH);

let db: ReturnType<typeof createDb>;
let root: string;
let blobs: BlobStore;

beforeEach(async () => {
  db = createDb();
  root = mkdtempSync(join(tmpdir(), 'hetu-a6-'));
  blobs = new BlobStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedDeleting(ref: string, status = 'pending', claimedBy: string | null = null): void {
  db.prepare(
    `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
     VALUES(?,?,'main','DELETING',?)`
  ).run(OK, ref, HASH);
  db.prepare(
    `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status, claimed_by, claimed_at)
     VALUES(?,?,'main',?,?, datetime('now'))`
  ).run(OK, ref, status, claimedBy);
}

describe('A-6 · reconcileBlobs 补偿', () => {
  it('重跑清理并删除 done 陈旧任务行', async () => {
    await blobs.write(REF, 'x');
    seedDeleting(REF, 'pending');
    db.prepare(
      `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status)
       VALUES(?,?,'main','done')`
    ).run(OK, 'stale-done-ref');

    const res = await reconcileBlobs(db, blobs, { limit: 10 });
    expect(res.hadPending).toBe(true);
    expect(res.filesRemoved).toBe(1);
    expect(res.pendingRetry).toBe(0);

    expect(stateOf(db, OK, REF)).toBe('DELETED');
    expect(existsSync(join(root, REF))).toBe(false);
    // done 陈旧行已清
    expect(
      db.prepare('SELECT 1 FROM blob_cleanup_tasks WHERE blob_ref=?').get('stale-done-ref')
    ).toBeUndefined();
    const doneLeft = db
      .prepare(`SELECT COUNT(*) c FROM blob_cleanup_tasks WHERE status='done'`)
      .get() as { c: number };
    expect(Number(doneLeft.c)).toBe(0);
  });

  it('无未完成任务 → hadPending=false，无副作用', async () => {
    const res = await reconcileBlobs(db, blobs, { limit: 10 });
    expect(res.hadPending).toBe(false);
    expect(res.filesRemoved).toBe(0);
    expect(res.pendingRetry).toBe(0);
  });

  it('崩溃残留的 claimed 超时任务被 reconcile 接管并完成', async () => {
    await blobs.write(REF, 'x');
    seedDeleting(REF, 'claimed', 'crashed-worker');
    db.prepare(
      `UPDATE blob_cleanup_tasks SET claimed_at=datetime('now','-30 minutes') WHERE blob_ref=?`
    ).run(REF);

    const res = await reconcileBlobs(db, blobs, { limit: 10 });
    expect(res.filesRemoved).toBe(1);
    expect(stateOf(db, OK, REF)).toBe('DELETED');
  });

  it('failed 任务在 runCleanup 中重试成功（retry_count 保留历史，任务置 done）', async () => {
    await blobs.write(REF, 'x');
    seedDeleting(REF, 'failed');
    db.prepare('UPDATE blob_cleanup_tasks SET retry_count=2, last_error=? WHERE blob_ref=?').run(
      'EACCES',
      REF
    );
    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.removed).toBe(1);
    expect(stateOf(db, OK, REF)).toBe('DELETED');
    const t = db
      .prepare('SELECT retry_count, status FROM blob_cleanup_tasks WHERE blob_ref=?')
      .get(REF) as { retry_count: number; status: string };
    expect(Number(t.retry_count)).toBe(2); // 重试历史不丢
    expect(t.status).toBe('done');
  });

  it('reconcileBlobs 在重试成功后将 done 行一并清理（不残留）', async () => {
    await blobs.write(REF, 'x');
    seedDeleting(REF, 'failed');
    db.prepare('UPDATE blob_cleanup_tasks SET retry_count=2 WHERE blob_ref=?').run(REF);
    const res = await reconcileBlobs(db, blobs, { limit: 10 });
    expect(res.filesRemoved).toBe(1);
    expect(stateOf(db, OK, REF)).toBe('DELETED');
    // done 行已被 reconcile 清理（对象状态仍保留 DELETED，不丢事实）
    expect(db.prepare('SELECT 1 FROM blob_cleanup_tasks WHERE blob_ref=?').get(REF)).toBeUndefined();
    const obj = db
      .prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?')
      .get(OK, REF) as { state: string };
    expect(obj.state).toBe('DELETED');
  });

  it('仍失败 → pendingRetry 反映剩余重试数，任务保持 failed 可追踪', async () => {
    await blobs.write(REF, 'x');
    seedDeleting(REF, 'failed');
    const failing: WorkerLike = {
      async unlinkIfExists() {
        throw new Error('EIO: disk error');
      },
      async remove() {
        throw new Error('EIO');
      },
    };
    const res = await reconcileBlobs(db, failing, { limit: 10 });
    expect(res.filesRemoved).toBe(0);
    expect(res.pendingRetry).toBe(1);
    const t = db
      .prepare('SELECT status, retry_count, last_error FROM blob_cleanup_tasks WHERE blob_ref=?')
      .get(REF) as { status: string; retry_count: number; last_error: string };
    expect(t.status).toBe('failed');
    expect(Number(t.retry_count)).toBe(1);
    expect(t.last_error).toContain('EIO');
    expect(stateOf(db, OK, REF)).toBe('DELETING'); // 对象保持 DELETING 等下次重试
  });
});
