/** A-4 · planPurge 阶段一（必须在调用方事务内执行）：
 *  Ledger → 收集候选 → 删 refs → 原子认领 → 删节点/两类边/覆盖层/outbox。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, stateOf, seedBlobRef } from './helpers/a-group.ts';
import { planPurge, refCountFor } from '../../src/storage/blob-lifecycle.ts';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';
import { insertNode } from '../helpers/db.ts';

const OWNER = 'plan-owner';
const OK = ownerKeyFor(OWNER);
const NODE = 'mem-plan-1';
const CONTENT = 'plan-content';
const HASH = sha256(CONTENT);
const REF = BlobStore.mainRefFor(OWNER, HASH);
const ARCH = BlobStore.archiveRefFor(OWNER, HASH);

let db: ReturnType<typeof createDb>;
beforeEach(() => {
  db = createDb();
});

describe('A-4 · planPurge 阶段一', () => {
  it('Ledger 按 revision 逐条写入，operator = 传入的 agentId', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: null }],
      operator: 'agent-purger',
      reason: 'user-request',
    });
    const rows = db
      .prepare('SELECT node_id, content_hash, operator, reason_category FROM purge_ledger')
      .all() as {
      node_id: string;
      content_hash: string;
      operator: string;
      reason_category: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].node_id).toBe(NODE);
    expect(rows[0].content_hash).toBe(HASH);
    expect(rows[0].operator).toBe('agent-purger');
    expect(rows[0].reason_category).toBe('user-request');
  });

  it('非共享 blob：认领进 scheduled，对象 DELETING', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    const plan = planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: null }],
      operator: 'a',
      reason: 'r',
    });
    expect(plan.scheduled).toEqual([{ ref: REF, kind: 'main' }]);
    expect(plan.retained).toEqual([]);
    expect(plan.operator).toBe('a');
    expect(stateOf(db, OK, REF)).toBe('DELETING');
    expect(refCountFor(db, OK, REF)).toBe(0);
  });

  it('全部 revision（含历史版本）都写 Ledger；引用全删后归零', () => {
    for (const rev of ['r1', 'r2']) {
      seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: rev });
    }
    const plan = planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [
        { revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: null },
        { revisionId: 'r2', contentHash: HASH, contentRef: REF, minimizedBlobRef: null },
      ],
      operator: 'a',
      reason: 'r',
    });
    const c = db.prepare('SELECT COUNT(*) c FROM purge_ledger').get() as { c: number };
    expect(Number(c.c)).toBe(2);
    expect(refCountFor(db, OK, REF)).toBe(0);
    expect(plan.scheduled).toEqual([{ ref: REF, kind: 'main' }]);
  });

  it('★ 跨 node 共享：另一 node 仍引用 → retained 带 refCount，不认领', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: 'mem-other', revisionId: 'r9' });
    const plan = planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: null }],
      operator: 'a',
      reason: 'r',
    });
    expect(plan.scheduled).toEqual([]);
    expect(plan.retained).toEqual([{ ref: REF, refCount: 1 }]);
    expect(stateOf(db, OK, REF)).toBe('ACTIVE');
  });

  it('主区 + 归档区：两者分别认领为 scheduled', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    seedBlobRef(db, { ownerKey: OK, blobRef: ARCH, kind: 'archive', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    const plan = planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: ARCH }],
      operator: 'a',
      reason: 'r',
    });
    expect(plan.scheduled.map((s) => s.ref).sort()).toEqual([REF, ARCH].sort());
    expect(stateOf(db, OK, REF)).toBe('DELETING');
    expect(stateOf(db, OK, ARCH)).toBe('DELETING');
  });

  it('★ 步骤 5：删除节点行 / 两类边 / sensitivity_overlay / outbox', () => {
    // 造两个 node 及其边、覆盖层、outbox
    insertNode(db, { node_id: NODE, revision_id: 'r1', revision_sequence: 1, owner_id: OWNER });
    insertNode(db, { node_id: 'mem-other', revision_id: 'r2', revision_sequence: 1, owner_id: OWNER });
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at) VALUES('cooccur',?,?,1,'2026-01-01')`
    ).run(NODE, 'mem-other');
    db.prepare(
      `INSERT INTO sensitivity_overlay(node_id, value, updated_by) VALUES(?, 'sensitive','tester')`
    ).run(NODE);
    db.prepare(`INSERT INTO outbox(kind, entity_id, seq, payload) VALUES('index',?,1,'{}')`).run(NODE);

    planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: null, minimizedBlobRef: null }],
      operator: 'a',
      reason: 'r',
    });

    expect(db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(NODE)).toBeUndefined();
    expect(
      db.prepare(`SELECT 1 FROM edges WHERE "from"=? OR "to"=?`).get(NODE, NODE)
    ).toBeUndefined();
    expect(
      db.prepare('SELECT 1 FROM sensitivity_overlay WHERE node_id=?').get(NODE)
    ).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM outbox WHERE entity_id=?').get(NODE)).toBeUndefined();
    // 另一个 node 不受影响
    expect(db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get('mem-other')).toBeTruthy();
  });

  it('不触碰其他 owner 的对象与引用（owner_key 隔离）', () => {
    const OTHER = 'plan-owner-2';
    const otherRef = BlobStore.mainRefFor(OTHER, HASH);
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    seedBlobRef(db, { ownerKey: ownerKeyFor(OTHER), blobRef: otherRef, kind: 'main', contentHash: HASH, nodeId: 'nX', revisionId: 'rX' });
    planPurge(db, {
      ownerKey: OK,
      nodeId: NODE,
      revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: null }],
      operator: 'a',
      reason: 'r',
    });
    expect(refCountFor(db, ownerKeyFor(OTHER), otherRef)).toBe(1);
    expect(stateOf(db, ownerKeyFor(OTHER), otherRef)).toBe('ACTIVE');
  });

  it('planPurge 抛出时可由调用方 ROLLBACK（阶段一整体的原子性）', () => {
    seedBlobRef(db, { ownerKey: OK, blobRef: REF, kind: 'main', contentHash: HASH, nodeId: NODE, revisionId: 'r1' });
    db.exec('BEGIN');
    try {
      planPurge(db, {
        ownerKey: OK,
        nodeId: NODE,
        revisions: [{ revisionId: 'r1', contentHash: HASH, contentRef: REF, minimizedBlobRef: null }],
        operator: 'a',
        reason: 'r',
      });
      throw new Error('simulated caller failure');
    } catch {
      db.exec('ROLLBACK');
    }
    // 回滚后一切复原：引用仍在、对象仍 ACTIVE、无 Ledger、无任务
    expect(refCountFor(db, OK, REF)).toBe(1);
    expect(stateOf(db, OK, REF)).toBe('ACTIVE');
    expect((db.prepare('SELECT COUNT(*) c FROM purge_ledger').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM blob_cleanup_tasks').get() as { c: number }).c).toBe(0);
  });
});
