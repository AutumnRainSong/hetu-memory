/** R4-E1/E2：preflight() 纯只读骨架 + runMigrations(dryRun) 共用同一函数。
 *
 *  断言：
 *   - 全新空库 dryRun → preflight isFreshDatabase=true、零建表、DRY_RUN_REPORT 兼容字段。
 *   - runMigrations(dryRun) 转发的字段与 preflight() 一致（单一函数，无逻辑漂移）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { preflight } from '../../src/storage/preflight.ts';
import { insertNode } from '../helpers/db.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => { db = new DatabaseSync(':memory:'); });

function tableNames(d: InstanceType<typeof DatabaseSync>): string[] {
  return (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(r => r.name);
}

describe('E1 — 全新空库（尚无 nodes/meta）只读 preflight', () => {
  it('fresh db：isFreshDatabase=true，pending=[1..5]，且不建任何表', () => {
    expect(tableNames(db)).toEqual([]);
    const p = preflight(db);
    expect(p.kind).toBe('PREFLIGHT_REPORT');
    expect(p.isFreshDatabase).toBe(true);
    expect(p.appliedVersions).toEqual([]);
    expect(p.pendingVersions).toEqual([1, 2, 3, 4, 5]);
    expect(p.nodeCount).toBe(0);
    expect(p.unmappedRevisions).toEqual([]);
    expect(p.supersededAmbiguous).toEqual([]);
    expect(p.supersededDangling).toEqual([]);
    expect(p.danglingNodeEdges).toEqual([]);
    expect(p.danglingRevisionEdges).toEqual([]);
    expect(p.cleanupTasksIncomplete).toBe(0);
    expect(p.cycles).toEqual([]);
    expect(p.blocking).toBe(false);
    // 只读铁律：preflight 后仍无任何表
    expect(tableNames(db)).toEqual([]);
  });

  it('已应用 001 后（无 nodes 数据）：cleanupTasksIncomplete=0（005 表不存在）', () => {
    runMigrations(db, { target: 1 });
    const p = preflight(db);
    expect(p.isFreshDatabase).toBe(false);
    expect(p.appliedVersions).toEqual([1]);
    expect(p.pendingVersions).toEqual([2, 3, 4, 5]);
    expect(p.nodeCount).toBe(0);
    // 005 表不存在 → 计数为 0，而不是抛错
    expect(p.cleanupTasksIncomplete).toBe(0);
  });
});

describe('E2 — runMigrations(dryRun) 复用 preflight 且兼容旧 DRY_RUN_REPORT 字段', () => {
  it('fresh db dryRun → 字段与 preflight 一致，schema_migrations 都未建', () => {
    const report = runMigrations(db, { dryRun: true }) as any;
    expect(report.kind).toBe('DRY_RUN_REPORT');
    expect(report.isFreshDatabase).toBe(true);
    expect(report.appliedVersions).toEqual([]);
    expect(report.pendingVersions).toEqual([1, 2, 3, 4, 5]);
    expect(report.nodeCount).toBe(0);
    expect(report.unmapped).toEqual([]);
    expect(report.text).toMatch(/PREFLIGHT_REPORT/);
    expect(tableNames(db)).toEqual([]);
    // dryRun 的 unmapped 与 preflight 同源
    db.close();
  });

  it('有数据 + 缺 owner → nodeCount>0、blocking=true（preflight 与 dryRun 报告一致）', () => {
    runMigrations(db);
    insertNode(db);
    const p = preflight(db, {});
    expect(p.nodeCount).toBe(1);
    expect(p.blocking).toBe(true); // nodeCount>0 && !legacyOwnerId

    const report = runMigrations(db, { dryRun: true }) as any;
    expect(report.kind).toBe('DRY_RUN_REPORT');
    expect(report.nodeCount).toBe(1);
    expect(report.unmapped).toEqual(['rev-1001-1']);
    expect(report.mappedCount).toBe(0);
  });

  it('mappedCount 保持旧语义（= manifest 条数，含未命中的多余键）', () => {
    runMigrations(db);
    insertNode(db);
    insertNode(db, { node_id: 'n2', revision_id: 'rev-n2-1', revision_sequence: 2, content_hash: 'sha256:' + 'b'.repeat(64) });
    const report = runMigrations(db, {
      dryRun: true,
      legacyScopeManifest: {
        'rev-1001-1': { layer: 'global', visibility: 'all_agents' },
        'rev-does-not-exist': { layer: 'global', visibility: 'all_agents' },
      },
    }) as any;
    expect(report.nodeCount).toBe(2);
    // 旧语义：mappedCount = Object.keys(manifest).length（不是 nodeCount - unmapped）
    expect(report.mappedCount).toBe(2);
    expect(report.unmapped).toEqual(['rev-n2-1']);
    // preflight 侧报告的是"未映射 revision 清单"，语义与旧 unmapped 一致
    const p = preflight(db, {
      legacyScopeManifest: { 'rev-1001-1': { layer: 'global', visibility: 'all_agents' } },
    });
    expect(p.unmappedRevisions).toEqual(['rev-n2-1']);
  });
});