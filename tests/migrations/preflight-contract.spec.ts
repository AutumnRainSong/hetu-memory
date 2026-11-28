/** R4-E1：preflight 模块可独立作为入口加载（不与 migrate.ts 形成初始化顺序耦合），
 *  且 PreflightReport 的字段集合与契约 §8 完全一致（不缺项、命名一致）。 */
import { describe, it, expect } from 'vitest';
// 故意让 preflight 成为第一个被加载的实现模块（migrate 由它间接引入）
import { preflight, type PreflightReport } from '../../src/storage/preflight.ts';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';

const CONTRACT_FIELDS: (keyof PreflightReport)[] = [
  'kind',
  'isFreshDatabase',
  'appliedVersions',
  'pendingVersions',
  'nodeCount',
  'unmappedRevisions',
  'supersededConvertible',
  'supersededAmbiguous',
  'supersededDangling',
  'danglingNodeEdges',
  'danglingRevisionEdges',
  'cleanupTasksIncomplete',
  'cycles',
  'blocking',
  'text',
];

describe('E1 — preflight 模块独立性与契约字段完整性', () => {
  it('preflight 作为入口模块导入后仍可正常工作（无循环初始化问题）', () => {
    const db = new DatabaseSync(':memory:');
    const p = preflight(db);
    expect(p.kind).toBe('PREFLIGHT_REPORT');
    // pendingVersions 依赖 migrate 的 MIGRATIONS —— 若循环依赖导致未初始化会在此暴露
    expect(p.pendingVersions).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });

  it('报告字段集合与契约 §8 完全一致', () => {
    const db = new DatabaseSync(':memory:');
    const p = preflight(db);
    expect(Object.keys(p).sort()).toEqual([...CONTRACT_FIELDS].sort());
    for (const f of CONTRACT_FIELDS) expect(p).toHaveProperty(f);
    db.close();
  });

  it('默认参数：不传 opts 也不抛（等价 dryRun 最小调用）', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    expect(() => preflight(db)).not.toThrow();
    expect(() => preflight(db, {})).not.toThrow();
    db.close();
  });
});