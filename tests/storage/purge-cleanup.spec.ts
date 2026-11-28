/** A-5 · runCleanup 阶段二：领取任务 → unlink → DELETING→DELETED + 任务 done；失败重试。
 *
 *  物理删除必须在事务外；只有持有 claim_token 的 worker 能推进状态（契约 §4.3）。
 *  真实文件 I/O 用 B 组 BlobStore（unlinkIfExists 为清理 worker 的正式入口）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, stateOf } from './helpers/a-group.ts';
import { runCleanup, PURGE_WORKER, type WorkerLike } from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

const OWNER = 'cleanup-owner';
const OK = ownerKeyFor(OWNER);
const CONTENT = 'cleanup-content';
const HASH = sha256(CONTENT);

let db: ReturnType<typeof createDb>;
let root: string;
let blobs: BlobStore;

beforeEach(() => {
  db = createDb();
  root = mkdtempSync(join(tmpdir(), 'hetu-a5-'));
  blobs = new BlobStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一个「已认领、待物理删除」的对象 + 任务行 */
function seedDeleting(ref: string, status = 'claimed', worker = PURGE_WORKER): number {
  db.prepare(
    `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
     VALUES(?,?,'main','DELETING',?)`
  ).run(OK, ref, HASH);
  return Number(
    db
      .prepare(
        `INSERT INTO blob_cleanup_tasks(owner_key, blob_ref, kind, status, claimed_by, claimed_at)
         VALUES(?,?,'main',?,?, datetime('now'))`
      )
      .run(OK, ref, status, worker).lastInsertRowid
  );
}

describe('A-5 · runCleanup 阶段二', () => {
  it('认领并删除：物理文件消失 + 对象 DELETED + deleted_at + 任务 done', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    await blobs.write(ref, CONTENT);
    seedDeleting(ref);

    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.attempted).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.failed).toEqual([]);

    expect(existsSync(join(root, ref))).toBe(false); // 真的删了
    expect(stateOf(db, OK, ref)).toBe('DELETED');
    const obj = db
      .prepare('SELECT deleted_at FROM blob_objects WHERE owner_key=? AND blob_ref=?')
      .get(OK, ref) as { deleted_at: string | null };
    expect(obj.deleted_at).toBeTruthy();
    const t = db
      .prepare('SELECT status, last_error FROM blob_cleanup_tasks WHERE blob_ref=?')
      .get(ref) as { status: string; last_error: string | null };
    expect(t.status).toBe('done');
    expect(t.last_error).toBeNull();
  });

  it('文件已不存在（ENOENT → absent）也视为删除成功', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH); // 未写盘
    seedDeleting(ref);
    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.removed).toBe(1);
    expect(stateOf(db, OK, ref)).toBe('DELETED');
  });

  it('★ unlink 失败 → 任务 failed + retry_count+1 + last_error，对象保持 DELETING', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    seedDeleting(ref);
    const failing: WorkerLike = {
      async unlinkIfExists() {
        throw new Error('EACCES: simulated permission failure');
      },
      async remove() {
        throw new Error('EACCES');
      },
    };
    const res = await runCleanup(db, failing, { limit: 10 });
    expect(res.attempted).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toContain('EACCES');

    const t = db
      .prepare('SELECT status, retry_count, last_error FROM blob_cleanup_tasks WHERE blob_ref=?')
      .get(ref) as { status: string; retry_count: number; last_error: string };
    expect(t.status).toBe('failed');
    expect(Number(t.retry_count)).toBe(1);
    expect(t.last_error).toContain('EACCES');
    expect(stateOf(db, OK, ref)).toBe('DELETING'); // 保留待重试
  });

  it('failed 任务可在下一次 runCleanup 重试成功（可重试）', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    await blobs.write(ref, CONTENT);
    seedDeleting(ref, 'failed');
    db.prepare('UPDATE blob_cleanup_tasks SET retry_count=1 WHERE blob_ref=?').run(ref);

    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.removed).toBe(1);
    expect(stateOf(db, OK, ref)).toBe('DELETED');
    const t = db
      .prepare('SELECT retry_count FROM blob_cleanup_tasks WHERE blob_ref=?')
      .get(ref) as { retry_count: number };
    expect(Number(t.retry_count)).toBe(1); // 成功后不再累加
  });

  it('pending 任务也能被领取执行', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    await blobs.write(ref, CONTENT);
    seedDeleting(ref, 'pending');
    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.attempted).toBe(1);
    expect(res.removed).toBe(1);
  });

  it('其他 worker 的 claimed 任务不被抢占（未超 5 分钟）', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    await blobs.write(ref, CONTENT);
    seedDeleting(ref, 'claimed', 'someone-else');
    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.attempted).toBe(0);
    expect(existsSync(join(root, ref))).toBe(true);
    expect(stateOf(db, OK, ref)).toBe('DELETING');
  });

  it('claimed 超 5 分钟 → 崩溃恢复时被接管', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    await blobs.write(ref, CONTENT);
    seedDeleting(ref, 'claimed', 'crashed-worker');
    db.prepare(
      `UPDATE blob_cleanup_tasks SET claimed_at=datetime('now','-10 minutes') WHERE blob_ref=?`
    ).run(ref);
    const res = await runCleanup(db, blobs, { limit: 10 });
    expect(res.attempted).toBe(1);
    expect(res.removed).toBe(1);
  });

  it('claim_token 防越权：非本次 token 无法改写终态（changes===0）', async () => {
    const ref = BlobStore.mainRefFor(OWNER, HASH);
    await blobs.write(ref, CONTENT);
    const seq = seedDeleting(ref);
    await runCleanup(db, blobs, { limit: 10 });
    const upd = db
      .prepare(`UPDATE blob_cleanup_tasks SET status='done' WHERE seq=? AND claim_token=?`)
      .run(seq, 'WRONG-TOKEN');
    expect(Number(upd.changes)).toBe(0);
  });

  it('limit 生效：一次最多领取 limit 条', async () => {
    for (let i = 0; i < 4; i++) {
      const h = sha256('bulk-' + i);
      const ref = BlobStore.mainRefFor(OWNER, h);
      await blobs.write(ref, 'bulk-' + i);
      seedDeleting(ref);
      db.prepare('UPDATE blob_objects SET content_hash=? WHERE blob_ref=?').run(h, ref);
    }
    const res = await runCleanup(db, blobs, { limit: 2 });
    expect(res.attempted).toBe(2);
    expect(res.removed).toBe(2);
  });
});
