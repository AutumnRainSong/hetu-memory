/**
 * F-2 · cross-owner-isolation —— 跨 owner 同 Hash → 物理文件完全隔离。
 *
 * R4 契约 §1/§3/裁决3：owner_id 绝不原样进路径，用 ownerKeyFor 摘要；
 * 不同 owner 同内容 Hash → 不同物理文件（main/archive 都内容寻址但路径带 owner-key）。
 * Purge/清理只操作自己的文件，绝不触碰他人 owner 的同 Hash 文件。
 *
 * 前置条件：R4 BlobStore owner 化路径（mainRefFor(ownerId,hash)/archiveRefFor(ownerId,hash)）
 *   + blob 台账已接入（blob_lifecycle / blob_refs）。
 * 并发方式：串行写两 owner 同内容 → 各自物理存在；再串行把 one owner 的引用归零并清理。
 * 预期：
 *  - 两 owner 的 mainRefFor 路径不同（owner-key 摘要不同）；
 *  - 两文件都真实存在；读内容一致；
 *  - 清理 ownerA 该 blob 后，ownerB 文件仍在且内容不变；
 *  - 各 owner 的 blob_refs / blob_objects 各行并存互不串扰。
 * 失败数据态：若路径未按 owner 隔离（如仍用老的一参数 mainRefFor），两 owner 会共享同一物理文件，
 *  导致「删 A 使 B 数据丢失」，是 P0 安全风险。
 *
 * 当前：BlobStore 已是 owner 化（B 已实现），但 005 台账未接入 → 台账部分 skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlobStore,
  sha256,
  ownerKeyFor,
  runMigrations,
  tempDbDir,
  skipReason,
  refMeta,
  hasR4Tables, safeRm } from './_helpers.ts';

describe('F-2 · cross-owner-isolation', () => {
  const c = tempDbDir('hetu-qa-r4-f2-');
  const blobs = new BlobStore(c.blobRoot);
  let db: InstanceType<typeof DatabaseSync>;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
  });

  it('同内容同 hash → mainRefFor/archiveRefFor 两 owner 路径不同（owner 摘要隔离）', () => {
    const { ownerKey: okA, contentHash, blobRef: refA } = refMeta('owner-a', 'SAME', 'main');
    const { ownerKey: okB, blobRef: refB } = refMeta('owner-b', 'SAME', 'main');
    expect(refA).not.toBe(refB);
    expect(ownerKeyFor('owner-a')).toBe(okA);
    expect(ownerKeyFor('owner-b')).toBe(okB);
    expect(okA).not.toBe(okB);

    const aA = BlobStore.archiveRefFor('owner-a', contentHash);
    const aB = BlobStore.archiveRefFor('owner-b', contentHash);
    expect(aA).not.toBe(aB);
  });

  it('写两 owner 同内容 → 两文件独立存在、内容一致；删 ownerA → ownerB 仍在', async () => {
    const refA = BlobStore.mainRefFor('owner-a', sha256(Buffer.from(SAME)));
    const refB = BlobStore.mainRefFor('owner-b', sha256(Buffer.from(SAME)));
    await blobs.write(refA, SAME);
    await blobs.write(refB, SAME);
    expect(refA).not.toBe(refB);
    expect(await blobs.exists(refA)).toBe(true);
    expect(await blobs.exists(refB)).toBe(true);
    expect((await blobs.read(refA)).toString('utf8')).toBe(SAME);
    expect((await blobs.read(refB)).toString('utf8')).toBe(SAME);

    await blobs.remove(refA);
    expect(await blobs.exists(refA)).toBe(false);
    expect(await blobs.exists(refB)).toBe(true); // ownerB 不受影响
    expect((await blobs.read(refB)).toString('utf8')).toBe(SAME);
  });

  it('台账层面：两 owner 各自 blob_objects/blob_refs 存在互不串扰（005 接入后验证）', async () => {
    if (!hasR4Tables(db)) {
      skipReason('F-2', '005 台账未接入，跳过台账级跨 owner 隔离验证');
      return;
    }
    const { ownerKey: okA, contentHash, blobRef: refA } = refMeta('owner-a', SAME, 'main');
    const { ownerKey: okB, blobRef: refB } = refMeta('owner-b', SAME, 'main');

    // 直接经由 blob-lifecycle.registerBlobRef 各登记一笔（若可用）
    const lifecycle = (await import('../../src/storage/blob-lifecycle.ts')) as typeof import('../../src/storage/blob-lifecycle.ts');
    lifecycle.registerBlobRef(db, { ownerKey: okA, blobRef: refA, nodeId: 'mA', revisionId: 'rA', kind: 'main', contentHash });
    lifecycle.registerBlobRef(db, { ownerKey: okB, blobRef: refB, nodeId: 'mB', revisionId: 'rB', kind: 'main', contentHash });

    const objA = db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(okA, refA) as { state: string };
    expect(objA.state).toBe('ACTIVE');
    const refCountA = db.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(okA, refA) as { c: number };
    expect(Number(refCountA.c)).toBe(1);
    // ownerB 台账不受 A 影响
    const refCountB = db.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(okB, refB) as { c: number };
    expect(Number(refCountB.c)).toBe(1);
    const objB = db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(okB, refB) as { state: string };
    expect(objB.state).toBe('ACTIVE');
    void existsSync;
  });

  afterAll(() => {
    if (db) try { db.close(); } catch { /* ignore */ }
    safeRm(c.dir);
  });
});

const SAME = '完全相同的内容，跨 owner 必须物理隔离。';
// 仅在 005 已建且用到 mkdirSync 时保留（避免未用告警）
void mkdirSync;
void join;