/** D-2：StorageProvider（service 面）接口形状 —— 只含业务方法，编译期断言 */
import { describe, it, expect } from 'vitest';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { createStorage } from '../../src/storage/factory.ts';
import type { StorageProvider } from '../../src/storage/spi.ts';

function makeHandles() {
  const sp = new SqliteStorageProvider({ dbPath: ':memory:' });
  runMigrations(sp.raw);
  return createStorage(sp);
}

describe('D-2 · StorageProvider（service 面）只含业务方法', () => {
  it('service 满足 StorageProvider 接口（编译期）', () => {
    const { service } = makeHandles();
    const s: StorageProvider = service; // 编译期：service 必须实现 StorageProvider
    void s;
  });

  it('service 恰好含 5 个业务方法键：get/put/query/graphTraverse/vectorSearch', () => {
    const { service } = makeHandles();
    const keys = new Set(Object.keys(service));
    expect(keys).toEqual(
      new Set(['get', 'put', 'query', 'graphTraverse', 'vectorSearch'])
    );
    for (const k of ['get', 'put', 'query', 'graphTraverse', 'vectorSearch']) {
      expect(typeof (service as Record<string, unknown>)[k]).toBe('function');
    }
  });

  it('service 对象自身不含任何维护私有字段（raw/db/内部方法名）', () => {
    const { service } = makeHandles();
    const keys = Object.keys(service);
    // 底层 SqliteStorageProvider 私有字段均不进 service 面
    for (const priv of ['db', 'blobs', 'writeChain']) {
      expect(keys).not.toContain(priv);
    }
  });
});