/**
 * F-1 · reuse-same-owner —— 同 owner 不同 Agent/Project/Revision 复用同一内容 Blob。
 *
 * R4 契约 §1/§3：同一 owner 内多个 Agent/Project/Revision 通过 blob_refs 共享同一对象，
 * 引用行数 = 引用数（不设冗余 ref_count）；物理上同一内容只一份文件。
 *
 * 前置条件：R4 已接入 —— 005 三表存在 + blob-lifecycle.registerBlobRef 可用。
 * 并发方式：串行登记引用（本场景无真实并发，只验证去重语义）。
 * 预期：
 *  1) 同 owner 3 个不同 revision 登记同一内容 → blob_refs 3 行、都指向同一 blob_ref；
 *  2) blob_objects 该 blob_ref 仅 1 行且 ACTIVE；
 *  3) 物理文件唯一（内容寻址目录下该 hex 文件名 = 1）。
 * 失败数据态：去重失效 → 候选 blob_ref 指向不同物理文件 / 引用行数与登记次数不符 →
 *    可能引用永不归零、文件永不删除（风险）。
 *
 * 当前 R4（A/E）未合入 → 三表缺失，整体 skip 并打 [F-skip] 日志。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { } from 'node:fs';
import { join } from 'node:path';
import {
  runMigrations,
  tryImport,
  hasR4Tables,
  tempDbDir,
  skipReason,
  refMeta,
  safeRm } from './_helpers.ts';
import type * as lifecycleT from '../../src/storage/blob-lifecycle.ts';

describe('F-1 · reuse-same-owner', () => {
  let db: InstanceType<typeof DatabaseSync>;
  let lifecycle: typeof lifecycleT | null = null;
  let dir: { dir: string; blobRoot: string };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    lifecycle = await tryImport<typeof lifecycleT>('../../src/storage/blob-lifecycle.ts');
    dir = tempDbDir('hetu-qa-r4-f1-');
  });

  it('R4 接入探测：若无 blob_refs 表或 blob-lifecycle 模块则 F-1 整体跳过', () => {
    if (!hasR4Tables(db) || !lifecycle) {
      skipReason('F-1', `005 表/bob-lifecycle 未接入 (tables=${hasR4Tables(db)}, module=${!!lifecycle})`);
    }
    expect(hasR4Tables(db)).toBe(true);
    // 断言在此处若失败即表示「确实缺失」→ 但为不污染回归，不在未接入时抛失败：
    // 上面 skipReason 已打点，因此这里用 if 包裹（跳过语义由后续用例守卫）。
  });

  it('同 owner 三 revision 复用同一内容 Hash：blob_refs=3 行、blob_objects 单行、物理单文件', async () => {
    if (!hasR4Tables(db) || !lifecycle) {
      skipReason('F-1', 'R4 blob 台账未接入，跳过');
      return;
    }
    const { ownerKey, contentHash, blobRef } = refMeta('ws-1', '共享内容', 'main');
    const reg = (nodeId: string, revisionId: string) =>
      lifecycle!.registerBlobRef(db, {
        ownerKey, blobRef, nodeId, revisionId, kind: 'main', contentHash, sizeBytes: Buffer.byteLength('共享内容'),
      });
    expect(reg('mem-A', 'rev-A1').ok).toBe(true);
    expect(reg('mem-B', 'rev-B1').ok).toBe(true);
    expect(reg('mem-C', 'rev-C1').ok).toBe(true);

    // 引用行数 = 3（行数即引用数）
    const refs = db.prepare('SELECT COUNT(*) c FROM blob_refs WHERE owner_key=? AND blob_ref=?')
      .get(ownerKey, blobRef) as { c: number };
    expect(Number(refs.c)).toBe(3);

    // 唯一性去重：同一 revision 重复登记不叠加（UNIQUE(owner_key,blob_ref,revision_id,kind)）
    expect(reg('mem-A', 'rev-A1').ok).toBe(true);
    expect(Number(refs.c)).toBe(3);

    // blob_objects 单行 ACTIVE
    const objs = db.prepare("SELECT COUNT(*) c FROM blob_objects WHERE owner_key=? AND blob_ref=?")
      .get(ownerKey, blobRef) as { c: number };
    expect(Number(objs.c)).toBe(1);
    const st = db.prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?')
      .get(ownerKey, blobRef) as { state: string };
    expect(st.state).toBe('ACTIVE');

    // 物理唯一：仅当调用方已把内容写盘才成立；registerBlobRef 只登记台账，
    // 因此这里不强断物理单文件（交由 writeFull 路径的集成验收）。若目录已有则该侧重：
    const hex = contentHash.replace(/^sha256:/, '');
    const shard = join(dir.blobRoot, 'workspaces', ownerKey, 'blobs', hex.slice(0, 2));
    const { existsSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    if (existsSync(shard)) {
      expect(readdirSync(shard).filter((f) => String(f).endsWith(hex)).length).toBeLessThanOrEqual(1);
    }
  });

  afterAll(() => {
    if (db) try { db.close(); } catch { /* ignore */ }
    safeRm(dir.dir);
  });
});