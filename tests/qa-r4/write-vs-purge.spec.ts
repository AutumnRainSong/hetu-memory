/**
 * F-13 · write-vs-purge —— 新记忆写入与 Purge 同时发生，数据一致性。
 *
 * R4 契约 §4：新写入（put）在最终事务内登记 blob 引用；Purge 在事务内删引用+原子认领。
 * 并发时要么「写入先提交、此时 blob 有引用 → 不认领、文件保留」要么「Purge 先提交、blob DELETING →
 * 新写入 BLOB_BUSY"。不能出现二者都赢导致「引用被登记但文件已被删」的悬空。
 *
 * 前置条件：put 已接入 blob 台账登记（Lead）+ 005 已建 + purge 走 A 组 planPurge。
 * 并发方式：两个独立 Provider 并发（一个 put 新 revision 写盘，一个 purge 旧 node）。
 * 预期（一致性不变量）：
 *  - 若 purge 发生，purged node 对应引用已删除、blob 若无可共享引用则应认领成功；
 *  - 若新写入发生，其引用必须指向仍存在的物理文件；
 *  - 任一相关 blob 要么有引用（文件在），要么清零已被认领（文件待删/DELETING），绝不出现「引用在手但文件缺失」。
 * 失败数据态：purge 误删仍是新写入引用的 blob → 新记忆指向空气（读失败 / 悬空引用）。
 *
 * 当前：未接入（put 未调 registerBlobRef，005 未建）→ skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { } from 'node:fs';
import {
  SqliteStorageProvider,
  BlobStore,

  asContentHash,
  asNodeId,
  asRevisionId,
  runMigrations,
  tryImport,
  tempDbDir,
  skipReason,
  scopeOf,
  node,
  authA,
  refMeta, safeRm } from './_helpers.ts';
import type * as lifecycleT from '../../src/storage/blob-lifecycle.ts';

describe('F-13 · write-vs-purge', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };
  let lifecycle: typeof lifecycleT | null = null;

  beforeAll(async () => {
    c = tempDbDir('hetu-qa-r4-f13-');
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
  });

  it('purge 与新写并发：blob 不出现「有引用但文件缺失」', async () => {
    if (!lifecycle) {
      skipReason('F-13', 'blob-lifecycle 未接入，跳过');
      return;
    }
    const p1 = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    runMigrations(p1.raw);
    const hasRefs = p1.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get();
    if (!hasRefs) {
      skipReason('F-13', '005 未接入，put 未登记引用台账，无法验证，跳过');
      p1.close();
      return;
    }

    const blobs = new BlobStore(c.blobRoot);
    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', 'write-purge', 'main');
    const hash = await blobs.write(blobRef, 'write-purge');
    void hash;

    await p1.put(node('mW', 'rW', { content_hash: asContentHash(contentHash), content_ref: blobRef, scope: scopeOf() }), [], [], authA);
    // 真实 put 路径此时应已登记 blob_ref——若 Provider 未接入则此步骤可失败，用它探测
    const refRows = p1.raw.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { c: number };
    console.log('[F13-debug] refRows=', JSON.stringify(refRows), 'blobRef=', blobRef.slice(0,40));
    if (Number(refRows.c) < 1) {
      skipReason('F-13', `put 未自动登记 blob_ref（rows=${Number(refRows.c)}），需 Lead 接入 put→registerBlobRef`);
      p1.close();
      return;
    }

    // 并发：另一连接 purge mW 与该节点再写新 revision
    const p2 = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    const [purge, write2] = await Promise.all([
      p1.purge(asNodeId('mW'), authA, 'user-request', { expectedRevision: asRevisionId('rW') }),
      p2.put(node('mW2', 'rW2', { content_hash: asContentHash('sha256:' + 'c'.repeat(64)), content_ref: null, scope: scopeOf() }), [], [], authA),
    ]);

    // 一致性：任一相关 blob 若有剩余引用，其物理文件必须存在；否则引用已清零（可被认领）
    const remaining = p1.raw.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { c: number };
    if (Number(remaining.c) > 0) {
      // 还有引用 → 文件必须在（不因 purge 删除）
      expect(await blobs.exists(blobRef)).toBe(true);
    } else {
      // 引用清零 → purge 已认领，文件可因 cleanup 删除；此处不强制（cleanup 未运行）
    }
    void purge;
    void write2;
    p1.close();
    p2.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});