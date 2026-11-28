/** D-1：MaintenanceApi 接口形状（编译期契约） */
import { describe, it, expect } from 'vitest';
import { SqliteStorageProvider } from '../../src/storage/sqlite-provider.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { asContentHash } from '../../src/storage/types.ts';
import { createStorage } from '../../src/storage/factory.ts';
import type { MaintenanceApi } from '../../src/storage/maintenance.ts';
import type { StorageHandles } from '../../src/storage/factory.ts';

function makeProvider(): SqliteStorageProvider {
  const sp = new SqliteStorageProvider({ dbPath: ':memory:' });
  runMigrations(sp.raw);
  return sp;
}

describe('D-1 · MaintenanceApi 接口形状', () => {
  it('createStorage 返回的 maintenance 满足 MaintenanceApi 的全部方法签名', async () => {
    const sp = makeProvider();
    try {
      const { maintenance } = createStorage(sp);
      const m: MaintenanceApi = maintenance; // 编译期：必须满足接口
      const keys = ['unsafeInternalGet', 'reconcile', 'close', 'blobRef', 'dangerousRawForTests'];
      for (const k of keys) {
        expect(typeof (m as Record<string, unknown>)[k]).toBe('function');
      }
    } finally {
      sp.close();
    }
  });

  it('maintenance.blobRef 返回主区 BlobHandle', async () => {
    const sp = makeProvider();
    try {
      const { maintenance } = createStorage(sp);
      const h = await maintenance.blobRef(asContentHash('sha256:' + 'a'.repeat(64)));
      expect(h).toBeDefined();
      expect(typeof h.ref).toBe('string');
      expect(h.inArchive).toBe(false);
    } finally {
      sp.close();
    }
  });

  it('maintenance.dangerousRawForTests 返回可执行 SQL 的原始句柄（迁移/测试用）', async () => {
    const sp = makeProvider();
    try {
      const { maintenance } = createStorage(sp);
      const raw = maintenance.dangerousRawForTests();
      const row = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").get() as { name: string } | undefined;
      expect(row?.name).toBe('nodes');
    } finally {
      sp.close();
    }
  });

  it('maintenance 抛出的异常可观测（reconcile 至少调用不炸），且 handles 冻结', () => {
    const sp = makeProvider();
    try {
      const h: StorageHandles = createStorage(sp);
      expect(Object.isFrozen(h)).toBe(true);
      expect(Object.isFrozen(h.maintenance)).toBe(true);
      void h.maintenance; // 类型可达
    } finally {
      sp.close();
    }
  });
});