/** StorageProvider 运行时隔离 Facade（R4-D）
 *
 *  目标：业务面（service）与维护面（maintenance）在**运行时**互斥，
 *  不只是类型层面区分。
 *
 *  - `service` 对象只暴露 StorageProvider 的五个业务方法；
 *    维护方法 `unsafeInternalGet` / `reconcile` / `close` / `blobRef`
 *    及其余私有能力在运行时**不存在**（`'x' in service === false`）。
 *  - `maintenance` 对象只暴露 MaintenanceApi，业务方法在运行时不存在。
 *  - 两个对象 + handles 均 `Object.freeze`，且不暴露底层 provider 实例
 *    （不把 SqliteStorageProvider 引用透出，无法解冻后注入维护方法）。
 */
import type { SqliteStorageProvider } from './sqlite-provider.ts';
import type { StorageProvider, NodeRef } from './spi.ts';
import type { MaintenanceApi } from './maintenance.ts';

export interface StorageHandles {
  readonly service: StorageProvider;
  readonly maintenance: MaintenanceApi;
}

/**
 * 从底层 SqliteStorageProvider 构造互斥的 service / maintenance 两个封装对象。
 * 每个方法用绑定闭包转接到底层实例；不把 provider 本身放入返回结构。
 */
export function createStorage(provider: SqliteStorageProvider): StorageHandles {
  const service: StorageProvider = {
    get: (ref, auth, opts) => provider.get(ref, auth, opts),
    put: (node, edges, outbox, auth, cas) => provider.put(node, edges, outbox, auth, cas),
    query: (q, auth) => provider.query(q, auth),
    graphTraverse: (from, budget, auth) => provider.graphTraverse(from, budget, auth),
    vectorSearch: (v, budget, auth) => provider.vectorSearch(v, budget, auth),
  };

  const maintenance: MaintenanceApi = {
    unsafeInternalGet: (ref: NodeRef, opts?) => provider.unsafeInternalGet(ref, opts),
    reconcile: () => provider.reconcile(),
    close: () => provider.close(),
    blobRef: (ownerId, hash) => provider.blobRef(ownerId, hash),
    dangerousRawForTests: () => provider.raw,
  };

  Object.freeze(service);
  Object.freeze(maintenance);

  const handles: StorageHandles = { service, maintenance };
  return Object.freeze(handles);
}