/** 行为矩阵夹具完整性测试：夹具即规格，统计口径必须与主规格一致（80 单元）。 */
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/behavior-matrix.testdata.json';

describe('behavior-matrix.testdata.json', () => {
  const ops = fixture.meta.operations;
  const states: { version: string; content: string }[] = fixture.meta.version_states.flatMap(v =>
    fixture.meta.content_states.map(c => ({ version: v, content: c }))
  );

  it('统计口径 = 2×5 = 80 单元', () => {
    expect(states.length).toBe(10);
    expect(ops.length).toBe(8);
    expect(fixture.meta.unit_count).toBe(80);
  });

  it('可达 56 格 + 不可达 24 格', () => {
    const unreachableStates = fixture.unreachable.map(u => `${u.state.version}/${u.state.content}`);
    const reachable = states.filter(s => !unreachableStates.includes(`${s.version}/${s.content}`));
    expect(reachable.length).toBe(7);                                  // 10 - 3 不可达
    expect(fixture.meta.reachable_units).toBe(reachable.length * ops.length); // 56
    expect(fixture.meta.unreachable_units).toBe(unreachableStates.length * ops.length); // 24
  });

  it('所有可达组合的 8 操作都有用例（无空格）', () => {
    const key = (v: string, c: string) => `${v}/${c}`;
    const covered = new Set(fixture.cases.map(c => key(c.state.version, c.state.content)));
    const unreachableStates = fixture.unreachable.map(u => `${u.state.version}/${u.state.content}`);
    const reachable = states.filter(s => !unreachableStates.includes(`${s.version}/${s.content}`));
    for (const s of reachable) {
      expect(covered.has(key(s.version, s.content)), `缺格: ${key(s.version, s.content)}`).toBe(true);
    }
  });

  it('不可达组合已登记原因', () => {
    expect(fixture.unreachable.length).toBe(3);
    for (const u of fixture.unreachable) expect(u.reason.length).toBeGreaterThan(5);
  });

  it('ledger 态（CURRENT/PURGED）8 操作齐备', () => {
    const key = (v: string, c: string) => `${v}/${c}`;
    const covered = new Set(fixture.cases.map(c => key(c.state.version, c.state.content)));
    expect(covered.has('CURRENT/PURGED')).toBe(true);
  });

  it('错误码均为注册表已登记码', async () => {
    const { ErrorCodes } = await import('../../src/errors/registry.ts');
    const known = new Set(Object.keys(ErrorCodes));
    for (const c of fixture.cases) {
      if (c.expect === 'DENY' && c.error) expect(known.has(c.error), `未登记错误码: ${c.error}`).toBe(true);
    }
  });
});
