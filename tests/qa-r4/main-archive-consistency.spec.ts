/**
 * F-3 · main-archive-consistency —— Main 与 Archive 的引用登记/清理一致性。
 *
 * R4 契约 §1.1：Main 与 Archive 都是内容寻址，共用同一套 blob_refs / blob_objects 生命周期，
 * 用 kind (main/archive) 区分。同 owner 同一内容 hash 的 main 与 archive 是两条独立生命周期记录，
 * 都须正确登记引用、在引用归零时可被独立认领/清理。
 *
 * 前置条件：005 台账 + blob-lifecycle（registerBlobRef / claimForDeletion / refCountFor）。
 * 并发方式：串行登记 main 与 archive 各 1 引用，再分别验证引用计数与清理。
 * 预期：
 *  - 同内容 hash 的 main 与 archive → 不同 blob_ref（路径不同空间），各自独立 blob_objects 行；
 *  - main 引用 1、archive 引用 1，互不叠加；
 *  - 归零后各自可 claimForDeletion 成功（assert changes===1）。
 * 失败数据态：若实现把 main/archive 混为同一 blob_ref 或共享同一引用计数，会出现
 *   「archive 清理导致 main 误删」或计数串扰 → 数据丢失风险。
 *
 * 当前：005 未接入 → 整体 skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { } from 'node:fs';
import {
  runMigrations,
  tryImport,
  hasR4Tables,
  tempDbDir,
  skipReason,
  refMeta,
  safeRm } from './_helpers.ts';
import type * as lifecycleT from '../../src/storage/blob-lifecycle.ts';

describe('F-3 · main-archive-consistency', () => {
  let db: InstanceType<typeof DatabaseSync>;
  let lifecycle: typeof lifecycleT | null = null;
  let c: { dir: string };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
    c = tempDbDir('hetu-qa-r4-f3-');
  });

  it('main 与 archive 各自独立登记引用，互不串扰', () => {
    if (!hasR4Tables(db) || !lifecycle) {
      skipReason('F-3', '005 台账 / blob-lifecycle 未接入，跳过');
      return;
    }
    const content = 'main-archive 一致性内容';
    const main = refMeta('ws-1', content, 'main');
    const arch = refMeta('ws-1', content, 'archive');
    expect(main.blobRef).not.toBe(arch.blobRef);

    const regM = lifecycle.registerBlobRef(db, { ownerKey: main.ownerKey, blobRef: main.blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'main', contentHash: main.contentHash });
    const regA = lifecycle.registerBlobRef(db, { ownerKey: arch.ownerKey, blobRef: arch.blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'archive', contentHash: arch.contentHash });
    expect(regM.ok).toBe(true);
    expect(regA.ok).toBe(true);

    // 各自独立计数
    const cM = db.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(main.ownerKey, main.blobRef) as { c: number };
    const cA = db.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?').get(arch.ownerKey, arch.blobRef) as { c: number };
    expect(Number(cM.c)).toBe(1);
    expect(Number(cA.c)).toBe(1);

    // 各自独立 blob_objects 行
    const objM = db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(main.ownerKey, main.blobRef) as { state: string };
    const objA = db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(arch.ownerKey, arch.blobRef) as { state: string };
    expect(objM.state).toBe('ACTIVE');
    expect(objA.state).toBe('ACTIVE');
  });

  it('main 引用归零可被独立认领；archive 引用仍在时不受影响', () => {
    if (!hasR4Tables(db) || !lifecycle) {
      skipReason('F-3', '005 台账 / blob-lifecycle 未接入，跳过');
      return;
    }
    const content = 'main-archive 清理一致性';
    const main = refMeta('ws-1', content, 'main');
    const arch = refMeta('ws-1', content, 'archive');

    lifecycle.registerBlobRef(db, { ownerKey: main.ownerKey, blobRef: main.blobRef, nodeId: 'mB', revisionId: 'rB1', kind: 'main', contentHash: main.contentHash });
    lifecycle.registerBlobRef(db, { ownerKey: arch.ownerKey, blobRef: arch.blobRef, nodeId: 'mB', revisionId: 'rB1', kind: 'archive', contentHash: arch.contentHash });

    // 先清 main 引用 → main 可认领
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(main.ownerKey, main.blobRef);
    const claimMain = lifecycle.claimForDeletion(db, { ownerKey: main.ownerKey, blobRef: main.blobRef, kind: 'main', worker: 'test' });
    expect(claimMain.ok).toBe(true);

    // archive 引用未删 → 不可认领（HAS_REFS）
    const claimArchRefHeld = lifecycle.claimForDeletion(db, { ownerKey: arch.ownerKey, blobRef: arch.blobRef, kind: 'archive', worker: 'test' });
    expect(claimArchRefHeld.ok).toBe(false);
    expect(claimArchRefHeld.ok === false && 'reason' in claimArchRefHeld ? (claimArchRefHeld as { reason: string }).reason : '').toBe('HAS_REFS');

    // 清 archive 引用后 → archive 可认领
    db.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(arch.ownerKey, arch.blobRef);
    const claimArch = lifecycle.claimForDeletion(db, { ownerKey: arch.ownerKey, blobRef: arch.blobRef, kind: 'archive', worker: 'test' });
    expect(claimArch.ok).toBe(true);
  });

  afterAll(() => {
    if (db) try { db.close(); } catch { /* ignore */ }
    safeRm(c.dir);
  });
});