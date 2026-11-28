/** D-4：运行时隔离断言（关键验收）
 *
 *  非类型层面，而是 `'x' in obj` 运行时检查：
 *  - service 上不存在任何维护方法（unsafeInternalGet/reconcile/close/blobRef/raw/…）
 *  - maintenance 上不存在任何业务方法（get/put/query/graphTraverse/vectorSearch/…）
 *  - handles 冻结，无法注入维护能力
 */
import { describe, it, expect } from 'vitest';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { createStorage } from '../../src/storage/factory.ts';

function makeHandles() {
  const sp = new SqliteStorageProvider({ dbPath: ':memory:' });
  runMigrations(sp.raw);
  return createStorage(sp);
}

describe('D-4 · 运行时隔离（in 断言）', () => {
  it('service 上不存在维护方法（运行时，非仅类型）', () => {
    const { service } = makeHandles();
    const maintenanceMethods = [
      'unsafeInternalGet',
      'reconcile',
      'close',
      'raw',
      'blobRef',
      'dangerousRawForTests',
    ];
    for (const m of maintenanceMethods) {
      expect(m in service).toBe(false);
      expect((service as unknown as Record<string, unknown>)[m]).toBeUndefined();
    }
    // 关键证据：reconcile 在 service 上运行时不存在
    expect('reconcile' in service).toBe(false);
  });

  it('maintenance 上不存在业务方法（运行时缺失）', () => {
    const { maintenance } = makeHandles();
    const businessMethods = ['get', 'put', 'query', 'graphTraverse', 'vectorSearch'];
    for (const m of businessMethods) {
      expect(m in maintenance).toBe(false);
      expect((maintenance as unknown as Record<string, unknown>)[m]).toBeUndefined();
    }
    // 事务/生命周期方法同样不在维护面上
    for (const m of ['putWithRevision', 'minimize', 'revive', 'purge']) {
      expect(m in maintenance).toBe(false);
    }
  });

  it('handles 被冻结，无法注入维护方法（严格赋值抛错）', () => {
    const h = makeHandles();
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.service)).toBe(true);
    expect(Object.isFrozen(h.maintenance)).toBe(true);
    expect(() => {
      'use strict';
      (h.service as unknown as Record<string, unknown>).reconcile = () => ({ fixed: 0, filesRemoved: 0 });
    }).toThrow();
  });

  it('service 无法通过 Object.assign / 原型链获得维护方法', () => {
    const { service } = makeHandles();
    // 冻结后 assign 也不生效
    expect(() => {
      'use strict';
      Object.assign(service as unknown as Record<string, unknown>, { reconcile: () => ({}) });
    }).toThrow();
    expect('reconcile' in service).toBe(false);
  });

  it('maintenance 面同样无法获得业务方法', () => {
    const { maintenance } = makeHandles();
    expect('get' in maintenance).toBe(false);
    expect('put' in maintenance).toBe(false);
  });
});