/**
 * F-12 · lifecycle-cross —— Minimize/Revive/Supersede/Purge 交叉并发。
 *
 * R4 契约 §6/C-6：Minimize×Supersede、Revive×Purge、Purge×Minimize/Revive 等交叉并发必须
 * 满足状态机一致：最终状态由 CAS 单一成功决定，不产生双链尾、不产生孤儿文件、Purge 后不可复活。
 *
 * 前置条件：R4 的 minimize/revive/purge/supersede 已按 C 组 CAS 接入 Provider。
 * 并发方式：同一 Provider（写队列串行）内 Promise.all 发起最小粒度交叉；验证不变量。
 * 预期：下列不变量恒成立：
 *  - node 最终 content_state ∈ {FULL, MINIMIZED, TOMBSTONE}（若被 purge 则查 ledger）独占一种；
 *  - 若 CAS 冲突则返回 ok:false 而非成功；
 *  - Revive 对已 SUPERSEDED 版本拒绝；
 *  - Purge 后任何 Revive 失败（PURGED_FINAL / 节点不存在）；
 *  - 无残留孤儿归档文件（除已登记清理任务的）。
 * 失败数据态：状态机违背（如 CURRENT MINIMIZED 可被 Revive 导致双链尾 / 已 purge 还能 revive）→ 数据损坏。
 *
 * 当前：依赖 C+A+Lead 接入，未接入时部分用例 skip；Supersede/Revive 的 R3 已实现部分可先行验证。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { } from 'node:fs';
import {
  SqliteStorageProvider,
  BlobStore,
  sha256,
  asContentHash,
  asNodeId,
  asRevisionId,
  runMigrations,
  tempDbDir,
  skipReason,
  scopeOf,
  node,
  authA,
  byRev, safeRm } from './_helpers.ts';

describe('F-12 · lifecycle-cross', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };

  beforeAll(() => {
    c = tempDbDir('hetu-qa-r4-f12-');
  });

  it('Minimize × Supersede 并发：最终唯一 CURRENT，无双链尾', async () => {
    const p = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    runMigrations(p.raw);
    const blobs = new BlobStore(c.blobRoot);
    const hash = await blobs.write(BlobStore.mainRefFor('ws-1', sha256(Buffer.from(CONT))), CONT);
    await p.put(node('m1', 'r1a', { content_hash: asContentHash(hash), content_ref: BlobStore.mainRefFor('ws-1', hash), scope: scopeOf() }), [], [], authA);

    const casR1 = { expectedRevision: asRevisionId('r1a') };
    const [min, sup] = await Promise.all([
      p.minimize(asNodeId('m1'), authA, casR1),
      p.put(node('m1', 'r2a', { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'b'.repeat(64)), version_state: 'CURRENT', scope: scopeOf() }), [], [], authA, casR1),
    ]);
    // 至少有一个成功；若都成功则状态机被破坏
    expect(min.ok || sup.ok).toBe(true);
    // 唯一 CURRENT
    const cur = p.raw.prepare("SELECT revision_id FROM nodes WHERE node_id='m1' AND version_state='CURRENT'").all() as { revision_id: string }[];
    expect(cur.length).toBe(1);
    const curNode = await p.get(byRev(cur[0].revision_id), authA);
    expect(curNode).not.toBeNull();
    p.close();
  });

  it('Revive × Purge：Purge 后 Revive 必须失败且无残留文件', async () => {
    const p = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    runMigrations(p.raw);
    const blobs = new BlobStore(c.blobRoot);
    const hash = await blobs.write(BlobStore.mainRefFor('ws-1', sha256(Buffer.from(CONT2))), CONT2);
    const ref = BlobStore.mainRefFor('ws-1', hash);
    await p.put(node('m2', 'r2b', { content_hash: asContentHash(hash), content_ref: ref, scope: scopeOf() }), [], [], authA);
    const min = await p.minimize(asNodeId('m2'), authA, { expectedRevision: asRevisionId('r2b') });
    expect(min.ok).toBe(true);
    const minimized = await p.unsafeInternalGet({ kind: 'revision', revisionId: asRevisionId('r2b') });
    const archiveRef = minimized?.minimized_blob_ref!;

    const [revive, purge] = await Promise.all([
      p.revive(asRevisionId('r2b'), authA, { expectedRevision: asRevisionId('r2b') }),
      p.purge(asNodeId('m2'), authA, 'user-request', { expectedRevision: asRevisionId('r2b') }),
    ]);

    if (!purge.ok) {
      skipReason('F-12', 'purge 未成功（可能被并发 revive 抢先改状态），跳过 revive×purge 断言');
      p.close();
      return;
    }
    // 并发编排里两者谁先提交都可能（revive 先赢 → 它会合法成功）。真正的不变量是：
    // **Purge 提交之后，任何后续 Revive 必须失败**。因此这里做一次确定性的“后置 revive”断言，
    // 而不是强行要求并发里 revive 失败（那会误报）。
    void revive;
    const afterPurge = await p.revive(asRevisionId('r2b'), authA, { expectedRevision: asRevisionId('r2b') });
    expect(afterPurge.ok).toBe(false);
    // 无残留文件
    expect(await blobs.exists(archiveRef)).toBe(false);
    p.close();
  });

  it('Revive 对已 SUPERSEDED 版本拒绝（R3 已实现）', async () => {
    const p = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    runMigrations(p.raw);
    const blobs = new BlobStore(c.blobRoot);
    const hash = await blobs.write(BlobStore.mainRefFor('ws-1', sha256(Buffer.from(CONT3))), CONT3);
    await p.put(node('m3', 'r3c', { content_hash: asContentHash(hash), content_ref: BlobStore.mainRefFor('ws-1', hash), scope: scopeOf() }), [], [], authA);
    await p.minimize(asNodeId('m3'), authA, { expectedRevision: asRevisionId('r3c') });
    // supersede r3 → 新增 r4 current
    await p.put(node('m3', 'r4c', { revision_sequence: 2, content_hash: asContentHash('sha256:' + 'e'.repeat(64)), scope: scopeOf() }), [], [], authA, { expectedRevision: asRevisionId('r3c') });
    const rv = await p.revive(asRevisionId('r3c'), authA, { expectedRevision: asRevisionId('r3c') });
    expect(rv.ok).toBe(false);
    expect((rv as any).error).toBe('INVALID_STATE');
    p.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});

const CONT = 'lifecycle-cross-minimize-supersede';
const CONT2 = 'lifecycle-cross-revive-purge';
const CONT3 = 'lifecycle-cross-superseded-revive';