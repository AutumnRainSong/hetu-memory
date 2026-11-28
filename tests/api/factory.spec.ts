/** D-3：createStorage() Facade —— 冻结、互斥、不暴露底层实例 */
import { describe, it, expect } from 'vitest';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { createStorage } from '../../src/storage/factory.ts';

function makeHandles() {
  const sp = new SqliteStorageProvider({ dbPath: ':memory:' });
  runMigrations(sp.raw);
  return { sp, handles: createStorage(sp) };
}

describe('D-3 · createStorage() Facade', () => {
  it('返回 handles 含 service + maintenance 两个只读引用', () => {
    const { handles } = makeHandles();
    expect(handles.service).toBeDefined();
    expect(handles.maintenance).toBeDefined();
  });

  it('handles / service / maintenance 均为 Object.isFrozen === true', () => {
    const { handles } = makeHandles();
    expect(Object.isFrozen(handles)).toBe(true);
    expect(Object.isFrozen(handles.service)).toBe(true);
    expect(Object.isFrozen(handles.maintenance)).toBe(true);
  });

  it('冻结对象无法注入新维护方法（非严格模式赋值被忽略、严格赋值抛 TypeError）', () => {
    const { handles } = makeHandles();
    const attempt = () => {
      'use strict';
      (handles.service as unknown as Record<string, unknown>).reconcile = () => ({ fixed: 0, filesRemoved: 0 });
    };
    expect(attempt).toThrow(TypeError);
    // 即使宽松模式下被静默忽略，运行时仍不可见
    expect('reconcile' in handles.service).toBe(false);
    expect((handles.service as unknown as { reconcile?: unknown }).reconcile).toBeUndefined();
  });

  it('不暴露底层 provider 实例：service/maintenance 自身不等于 provider，且无 provider 引用字段', () => {
    const { sp, handles } = makeHandles();
    expect(handles.service).not.toBe(sp);
    expect(handles.maintenance).not.toBe(sp);
    // handles 上不应有 provider 字段
    for (const k of Object.keys(handles)) {
      expect((handles as unknown as Record<string, unknown>)[k]).not.toBe(sp);
    }
    // service / maintenance 暴露的每个键都不是 provider 实例本身
    for (const obj of [handles.service, handles.maintenance]) {
      for (const v of Object.values(obj as unknown as Record<string, unknown>)) {
        expect(v).not.toBe(sp);
      }
    }
  });

  it('service 与 maintenance 是不同对象（互斥、独立封装）', () => {
    const { handles } = makeHandles();
    expect(handles.service).not.toBe(handles.maintenance);
  });
});