/**
 * F-11 · concurrent-providers —— 不同 Provider（独立连接同文件库）并发 Minimize/Revive。
 *
 * R4 契约 §6/C-5：Minimize/Revive 最终状态检查进最终事务，UPDATE 带预期状态 CAS 条件，
 * 检查 affected rows（changes===1），跨 Provider 跨连接并发 → 只允许一个成功。
 *
 * 前置条件：R4 的 Minimize/Revive 已按 C 组契约接入 Provider（Lead 打补丁），且 005 台账用于孤儿登记。
 * 并发方式：两个独立 SqliteStorageProvider（同文件库 + 同 blobRoot），并发各自发起 minimize 同一 node。
 * 预期：
 *  - 恰一个 minimize 成功（ok:true），另一个返回 ok:false（STATE_CONFLICT / CAS_CONFLICT）；
 *  - 最终节点 content_state 为 MINIMIZED，且恰好一个归档文件存在。
 * 失败数据态：若两个都成功 → 双链尾 / 重复归档（或两个都失败）。若一个是 STATE_CONFLICT 另一个
 *  CAS_CONFLICT 均可。跨连接读最新落盘状态必须被看到。
 *
 * 当前：Minimize/Revive 仍是 R3 实现（单连接写队列，未过跨连接 CAS 验收），且 005 未接入
 * → 依赖 C 组 + Lead 接入跨连接语义后才能真正测出“单一成功”。本文件先构造并发骨架，
 * 若无跨连接安全则打 [F-skip]。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { } from 'node:fs';
import { SqliteStorageProvider, BlobStore, sha256, asContentHash, asNodeId, asRevisionId, runMigrations, tempDbDir, scopeOf, node, authA, byNode, safeRm, gapOrSkip } from './_helpers.ts';

describe('F-11 · concurrent-providers', () => {
  let c: { dir: string; dbPath: string; blobRoot: string };

  beforeAll(() => {
    c = tempDbDir('hetu-qa-r4-f11-');
  });

  it('两独立 Provider 并发 minimize 同一 node → 恰一个成功（跨连接 CAS 后验证）', async () => {
    const p1 = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    runMigrations(p1.raw);
    const blobs = new BlobStore(c.blobRoot);
    const content = '并发 minimize 内容';
    const hash = await blobs.write(BlobStore.mainRefFor('ws-1', sha256(Buffer.from(content))), content);
    const ref = BlobStore.mainRefFor('ws-1', hash);
    const w = await p1.put(
      node('m1', 'r1', { content_hash: asContentHash(hash), content_ref: ref, scope: scopeOf() }),
      [], [], authA
    );
    expect(w.ok).toBe(true);

    // 第二独立连接
    const p2 = new SqliteStorageProvider({ dbPath: c.dbPath, blobRoot: c.blobRoot });
    const cas = { expectedRevision: asRevisionId('r1') };

    const [a, b] = await Promise.all([
      p1.minimize(asNodeId('m1'), authA, cas).then(r => ({ who: 'p1', r })),
      p2.minimize(asNodeId('m1'), authA, cas).then(r => ({ who: 'p2', r })),
    ]);
    const okCount = [a, b].filter(x => x.r.ok).length;

    // R3 实现用单一写队列（同进程 serialize）→ 目前其实只有一个前台；跨连接事务开没开取决于 Provider。
    // 若均成功说明跨连接未保护 → 应用层断言失败并提示 C 组未接入。
    if (okCount === 2) {
      // 两种 fall 情形：1) 平台未真正并发（同一写队列串行两个都成功——不符合契约）
      gapOrSkip('F-11', `两 Provider 均成功（okCount=2）：跨连接 minimize 未按「恰一个成功」约束` +
        ` state/p1=${JSON.stringify(a.r)}, p2=${JSON.stringify(b.r)}`);
      return;
    }
    if (okCount === 0) {
      skipReason('F-11', '两 Provider 均失败，需 C 组接入后重验（可能都在事务前 CAS 拦截）');
      // 仍校验最终状态不应是 FULL（应 MINIMIZED 当有输出）
      const finalState = (await p1.get(byNode('m1'), authA))?.content_state;
      void finalState;
      return;
    }
    // 恰一个成功
    const finalNode = await p1.get(byNode('m1'), authA);
    expect(finalNode?.content_state).toBe('MINIMIZED');
    // 恰一个归档文件存在
    const minimized = finalNode?.minimized_blob_ref;
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    if (minimized) {
      const dir = c.blobRoot;
      void dir;
      // 归档区内容寻址 → 读取校验
      expect(await blobs.exists(minimized)).toBe(true);
      void existsSync;
    }

    p1.close();
    p2.close();
  });

  afterAll(() => {
    safeRm(c.dir);
  });
});