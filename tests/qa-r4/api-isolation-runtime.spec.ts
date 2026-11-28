/**
 * F-15 · api-isolation-runtime —— Maintenance API 不可被业务调用方绕过。
 *
 * R4 契约 §7/D-4：运行时 `'x' in obj` 断言 —— service 上不存在 unsafeInternalGet/reconcile/
 * close/blobRef/raw/dangerousRawForTests；maintenance 上不存在 get/put/query/graphTraverse/
 * vectorSearch/putWithRevision/minimize/revive/purge；handles/service/maintenance 均冻结；不暴露底层
 * provider 实例。
 *
 * 前置条件：D 组 createStorage() Facade（factory.ts）已交付。
 * 并发方式：无（接口形状断言）。
 * 预期：运行时互斥成立（'in' 为 false），冻结成立。
 * 失败数据态：service 若残留维护方法 → 业务侧可绕过授权读 raw/reconcile。
 *
 * 当前：factory.ts 已交付（D 已完成）→ 本文件可真实运行，不 skip。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SqliteStorageProvider, runMigrations } from './_helpers.ts';
import { createStorage } from '../../src/storage/factory.ts';

describe('F-15 · api-isolation-runtime', () => {
  let sp: InstanceType<typeof SqliteStorageProvider>;
  let handles: ReturnType<typeof createStorage>;

  beforeAll(() => {
    sp = new SqliteStorageProvider({ dbPath: ':memory:' });
    runMigrations(sp.raw);
    handles = createStorage(sp);
  });

  it('service 运行时不存在任何维护方法（in 断言）', () => {
    for (const m of ['unsafeInternalGet', 'reconcile', 'close', 'blobRef', 'raw', 'dangerousRawForTests']) {
      expect(m in handles.service).toBe(false);
    }
  });

  it('maintenance 运行时不存在任何业务方法（in 断言）', () => {
    for (const m of ['get', 'put', 'query', 'graphTraverse', 'vectorSearch', 'putWithRevision', 'minimize', 'revive', 'purge']) {
      expect(m in handles.maintenance).toBe(false);
    }
  });

  it('handles / service / maintenance 冻结且不暴露底层 provider 实例', () => {
    expect(Object.isFrozen(handles)).toBe(true);
    expect(Object.isFrozen(handles.service)).toBe(true);
    expect(Object.isFrozen(handles.maintenance)).toBe(true);
    expect(handles.service).not.toBe(sp);
    expect(handles.maintenance).not.toBe(sp);
    for (const obj of [handles.service, handles.maintenance]) {
      for (const v of Object.values(obj as unknown as Record<string, unknown>)) {
        expect(v).not.toBe(sp);
      }
    }
  });

  it('注入维护方法到冻结 service 被拒（严格赋值抛 TypeError）', () => {
    expect(() => {
      'use strict';
      (handles.service as unknown as Record<string, unknown>).reconcile = () => ({ fixed: 0 });
    }).toThrow(TypeError);
    expect('reconcile' in handles.service).toBe(false);
  });
});