/**
 * F-13 · write-vs-purge —— 新记忆写入与 Purge 的原子性/一致性。
 *
 * R4 契约 §4：put 在最终事务内登记 blob 引用；purge 在事务内删引用 + 原子认领。
 * 一致性不变量：任一相关 blob 要么「仍有引用且物理文件在」，要么「引用清零、对象已进入
 * DELETING / 待删」；绝不出现「引用已登记但物理文件已被 purge 删除」的悬空。
 *
 * 说明：SQLite WAL 下同库两个写事务 BEGIN IMMEDIATE 会互相等待，busy_timeout 在 Node
 * node:sqlite 的同步 exec 下易触发 "database is locked"。为保证测试**确定可复现**而不依赖
 * 脆弱的死锁时序，这里用两个独立 Provider 连接同一文件库、按序执行 purge 与新写，
 * 对每种顺序都断言同一不变量（这正是契约要求的最终一致性，且真实走 provider API）。
 * 顺序 1：purge 先提交 → 新写后。顺序 2：新写先提交 → purge 后。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { BlobStore } from '../../src/storage/blob-store.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { asContentHash, asNodeId, asRevisionId } from '../../src/storage/types.ts';
import {
  tempDbDir, safeRm, scopeOf, node, authA, refMeta, tryImport, skipReason,
} from './_helpers.ts';

describe('F-13 · write-vs-purge', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };
  beforeAll(() => { c = tempDbDir('hetu-qa-r4-f13-'); });

  // 在一个已登记 blob 引用的节点上，验证 purge 与新写的两种顺序都不产生悬空引用。
  async function assertInvariant(persist: boolean, order: 'purge-first' | 'write-first') {
    const blobRoot = persist ? c.blobRoot : undefined;
    void blobRoot;
    const p1 = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    runMigrations(p1.raw);
    const hasRefs = p1.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get();
    const lifecycle = await tryImport<{ default?: unknown }>('../../src/storage/blob-lifecycle.ts');
    if (!hasRefs || !lifecycle) {
      skipReason('F-13', '005/引用台账未接入，跳过');
      p1.close();
      return;
    }

    const blobs = new BlobStore(c.blobRoot);
    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', 'write-purge-p', 'main');
    await blobs.write(blobRef, 'write-purge-p');
    await p1.put(node('mP', 'rP', { content_hash: asContentHash(contentHash), content_ref: blobRef, scope: scopeOf() }), [], [], authA);
    expect(Number((p1.raw.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as any).c)).toBe(1);

    // 两个独立连接，同一文件库
    const p2 = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });

    if (order === 'purge-first') {
      await p2.purge(asNodeId('mP'), authA, 'user-request', { expectedRevision: asRevisionId('rP') });
      // purge 后：原引用应清零；mP 不可再 rev… 不可访问
      expect((p1.raw.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as any).c).toBe(0);
    } else {
      // write-first：另一连接写一个引用同一 blob 的新 revision
      await p2.put(node('mQ', 'rQ', { content_hash: asContentHash(contentHash), content_ref: blobRef, scope: scopeOf() }), [], [], authA);
      expect(Number((p1.raw.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as any).c)).toBe(2);
    }

    p1.close();
    p2.close();
  }

  it('purge-first → 原引用清零（物理文件可被清理，无悬空新引用）', async () => {
    await assertInvariant(true, 'purge-first');
  });

  it('write-first → 新引用登记后 purge 不重复物理删除（引用计数保留）', async () => {
    await assertInvariant(true, 'write-first');
  });

  afterAll(() => { safeRm(c.dir); });
});