/**
 * F-16 · regression-inventory —— 178 项既有回归「零弱化」清单校验（清单类用例）。
 *
 * 目的：不是重跑行为，而是**程序化证明既有测试文件一个都没被删**、且每个文件仍保有
 * 最低用例数（防止「删测试换绿灯」）。基线来自 R3 验收报告
 * （docs/QA-ACCEPTANCE-REVIEW-R3.md：15 文件 / 178 项）+ R4 各组新增文件的既有成员。
 *
 * 前置条件：仓库内存在基线测试文件（R3 的 15 个 + R4 各组交付物）。
 * 并发方式：无（静态清单 + 源码文本断言）。
 * 预期：
 *  - 基线文件全部存在，且非空；
 *  - 每个基线文件的 `it(`/`test(` 计数 ≥ 基线声明的最小值（只允许增，不允许减）；
 *  - 既有断言未被注释掉（不出现 `// expect(` 大面积注释化）。
 * 失败数据态：若有文件缺失或用例数低于下限 → 说明回归被弱化，必须阻断合并。
 *
 * 本用例不依赖 R4 运行时能力（只读文件系统），因此**永远真实运行**。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** 基线：R3 收官的 15 个测试文件（docs/QA-ACCEPTANCE-REVIEW-R3.md「15 文件 / 178 项」）。 */
const R3_BASELINE: Record<string, number> = {
  'tests/smoke.spec.ts': 1,
  'tests/storage/provider.spec.ts': 34,
  'tests/e2e/r3-security.spec.ts': 15,
  'tests/e2e/r3-auth-edge-dryrun.spec.ts': 10,
  'tests/e2e/multi-agent-security.spec.ts': 17,
  'tests/types/branded-ids.spec.ts': 5,
  'tests/scope/scope-contract.spec.ts': 14,
  'tests/migrations/migrate.spec.ts': 5,
  'tests/migrations/002-scope.spec.ts': 17,
  'tests/migrations/002-rollback-immutability.spec.ts': 15,
  'tests/migrations/002-legacy-upgrade.spec.ts': 6,
  'tests/migrations/002-rev4-safety.spec.ts': 13,
  'tests/luoshu/schema.spec.ts': 10,
  'tests/luoshu/semantic.spec.ts': 10,
  'tests/matrix/fixture.spec.ts': 6,
};

/** R4 各组已交付的测试文件（Lead 逐条 diff 时同样不得删除）。 */
const R4_GROUP_FILES: string[] = [
  'tests/api/factory.spec.ts',
  'tests/api/isolation.spec.ts',
  'tests/api/maintenance-shape.spec.ts',
  'tests/api/service-shape.spec.ts',
  'tests/storage/blob-atomic.spec.ts',
  'tests/storage/blob-claim.spec.ts',
  'tests/storage/blob-isolation.spec.ts',
  'tests/storage/blob-namespace.spec.ts',
  'tests/storage/blob-register.spec.ts',
  'tests/storage/blob-remove-errors.spec.ts',
  'tests/storage/blob-root-realpath.spec.ts',
  'tests/storage/blob-schema.spec.ts',
  'tests/storage/blob-symlink-parent.spec.ts',
  'tests/storage/blob-symlink-target.spec.ts',
  'tests/storage/blob-toctou.spec.ts',
  'tests/migrations/004-rollback.spec.ts',
  'tests/migrations/preflight-basic.spec.ts',
  'tests/migrations/preflight-blocking.spec.ts',
  'tests/migrations/preflight-consistency.spec.ts',
  'tests/migrations/preflight-edges.spec.ts',
  'tests/migrations/preflight-wiring.spec.ts',
  'tests/storage/lifecycle-cas-unit.spec.ts',
  'tests/storage/lifecycle-concurrent.spec.ts',
  'tests/storage/lifecycle-cross.spec.ts',
  'tests/storage/lifecycle-orphan.spec.ts',
  'tests/storage/purge-cleanup.spec.ts',
  'tests/storage/purge-cross-owner.spec.ts',
  'tests/storage/purge-plan.spec.ts',
  'tests/storage/purge-reconcile.spec.ts',
  'tests/storage/purge-shared.spec.ts',
];

/** F 组自身的 16 个场景文件（F-1..F-16），也不得被删除。 */
const F_GROUP_FILES = [
  'tests/qa-r4/reuse-same-owner.spec.ts',
  'tests/qa-r4/cross-owner-isolation.spec.ts',
  'tests/qa-r4/main-archive-consistency.spec.ts',
  'tests/qa-r4/refzero-newref-race.spec.ts',
  'tests/qa-r4/deleting-write-race.spec.ts',
  'tests/qa-r4/crash-recovery.spec.ts',
  'tests/qa-r4/unlink-failure.spec.ts',
  'tests/qa-r4/shared-ref-protection.spec.ts',
  'tests/qa-r4/migration-004-rollback.spec.ts',
  'tests/qa-r4/symlink-race.spec.ts',
  'tests/qa-r4/concurrent-providers.spec.ts',
  'tests/qa-r4/lifecycle-cross.spec.ts',
  'tests/qa-r4/write-vs-purge.spec.ts',
  'tests/qa-r4/preflight-zero-write.spec.ts',
  'tests/qa-r4/api-isolation-runtime.spec.ts',
  'tests/qa-r4/regression-inventory.spec.ts',
];

function countCases(src: string): number {
  // 统计 it( / test( 声明（含 it.skip / it.each 等变体）
  const m = src.match(/\b(it|test)(\.(skip|only|todo|concurrent|each))?\s*\(/g) ?? [];
  return m.length;
}

describe('F-16 · regression-inventory', () => {
  it('R3 基线 15 个测试文件全部存在且用例数不低于基线（只许增不许减）', () => {
    const missing: string[] = [];
    const weakened: string[] = [];
    for (const [rel, min] of Object.entries(R3_BASELINE)) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      const src = readFileSync(abs, 'utf8');
      const n = countCases(src);
      if (n < min) weakened.push(`${rel}: ${n} < 基线 ${min}`);
    }
    expect(missing, `既有测试文件被删除：${missing.join(', ')}`).toEqual([]);
    expect(weakened, `既有测试用例数被削减：${weakened.join('; ')}`).toEqual([]);
    const total = Object.values(R3_BASELINE).reduce((a, b) => a + b, 0);
    expect(total).toBe(178); // 基线声明即 178 项
  });

  it('R4 各组交付的测试文件全部存在（不得被删）', () => {
    const missing = R4_GROUP_FILES.filter(rel => !existsSync(join(ROOT, rel)));
    expect(missing, `R4 组测试文件缺失：${missing.join(', ')}`).toEqual([]);
  });

  it('F 组 16 个场景文件齐全（F-1..F-16）', () => {
    const missing = F_GROUP_FILES.filter(rel => !existsSync(join(ROOT, rel)));
    expect(missing, `F 组测试文件缺失：${missing.join(', ')}`).toEqual([]);
    expect(F_GROUP_FILES.length).toBe(16);
  });

  it('既有测试断言未被整体注释掉（检测 expect 注释化弱化）', () => {
    const offenders: string[] = [];
    for (const rel of Object.keys(R3_BASELINE)) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, 'utf8');
      const commented = (src.match(/^\s*\/\/\s*(expect|assert)\s*\(/gm) ?? []).length;
      const active = (src.match(/^\s*(expect|assert)\s*\(/gm) ?? []).length;
      // 不允许「有断言写但全被注释掉」
      if (commented > 0 && active === 0) offenders.push(`${rel}: ${commented} 条断言被注释`);
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  it('测试配置文件仍扫描 tests/**（防止通过 include 缩小测试面）', () => {
    const cfg = join(ROOT, 'vitest.config.ts');
    expect(existsSync(cfg)).toBe(true);
    const src = readFileSync(cfg, 'utf8');
    expect(src).toContain("tests/**/*.spec.ts");
  });
});
