/**
 * F-4 · refzero-newref-race —— 引用归零后，另一连接尝试登记新引用。
 *
 * R4 契约 §4.1/4.2：reference 归零 & 认领（ACTIVE→DELETING）必须在同一条 SQL 原子完成
 * （UPDATE ... WHERE NOT EXISTS(refs)）。DELETING 期间禁止登记新引用（返回 BLOB_BUSY）。
 * 本用例用**两个独立连接**（文件库）模拟：连接 1 归零认领；连接 2 在归零后尝试登记新引用
 * → 必须 BLOB_BUSY，不得把对象登记进 DELETING 状态。
 *
 * 前置条件：005 台账 + blob-lifecycle.registerBlobRef + claimForDeletion + 文件库（两连接同库）。
 * 并发方式：串行编排两连接（cl 引零 → cl2 登记），验证原子归零后的行为。
 * 预期：
 *  - cl1 claimForDeletion 成功（changes===1，对象 → DELETING，插入 claimed 任务）
 *  - cl2 registerBlobRef 返回 { ok:false, error:'BLOB_BUSY' }；对象停留 DELETING
 *  - DB 事务屏障：cl2 无法看到半提交状态（实际由 SQLite 保证），故 cl2 读到的是 cl1 已提交的 DELETING
 * 失败数据态：若实现把「再查一次引用数」当 TOCTOU 解（先查后写），cl2 可能在 cl1 认领前/后读到 ACTIVE，
 *  从而把新引用登记进 DELETING → 违反契约（DELETING 禁新增引用），且可能造成 cl1 已 unlink 后新引用指向空气。
 *
 * 当前：005 未接入（两连接无法建 blob 台账）→ skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { } from 'node:fs';
import { } from 'node:path';
import {
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

describe('F-4 · refzero-newref-race', () => {
  let c: { dir: string; dbPath: string };
  let lifecycle: typeof lifecycleT | null = null;

  beforeAll(async () => {
    c = tempDbDir('hetu-qa-r4-f4-');
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
  });

  it('cl1 归零认领后，cl2 登记同 blob 新引用必须 BLOB_BUSY', () => {
    if (!lifecycle) {
      skipReason('F-4', 'blob-lifecycle 未接入，跳过');
      return;
    }
    const cl1 = fileDb(c.dbPath);
    runMigrations(cl1);
    // 保证 blob_objects/blob_refs 存在（若 005 未注册则手动建）——否则两连接下也无法测
    const tbls = [
      (cl1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_refs'").get()),
    ];
    if (!tbls[0]) {
      skipReason('F-4', '005 未接入（无法在文件库建立 blob 台账），跳过');
      cl1.close();
      return;
    }

    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', 'race-content', 'main');
    // cl1 先登记一个引用，再归零并认领
    lifecycle.registerBlobRef(cl1, { ownerKey, blobRef, nodeId: 'mA', revisionId: 'rA1', kind: 'main', contentHash });
    cl1.prepare('DELETE FROM blob_refs WHERE owner_key=? AND blob_ref=?').run(ownerKey, blobRef);
    const claim = lifecycle.claimForDeletion(cl1, { ownerKey, blobRef, kind: 'main', worker: 'cl1' });
    expect(claim.ok).toBe(true);

    // cl2 独立连接读同一库，此时对象 DELETING → 登记新引用必须 BLOB_BUSY
    const cl2 = fileDb(c.dbPath);
    const r2 = lifecycle.registerBlobRef(cl2, { ownerKey, blobRef, nodeId: 'mB', revisionId: 'rB1', kind: 'main', contentHash });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('BLOB_BUSY');

    // 对象仍 DELETING（不会被 cl2 复活）
    const st = cl2.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?').get(ownerKey, blobRef) as { state: string };
    expect(st.state).toBe('DELETING');

    cl1.close();
    cl2.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});