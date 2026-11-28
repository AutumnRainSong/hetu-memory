/** 内部维护 API（R3-04，R4-D 运行时隔离修订）
 *
 *  与面向业务的 StorageProvider 分离：该接口暴露 `unsafeInternalGet` / `reconcile`
 *  / `close` / `blobRef` / `dangerousRawForTests` 等**只供受信任服务层或运维**使用的
 *  能力，**不得**出现在 Agent / MCP / 普通业务调用者的接口面上。
 *
 *  R4-D 运行时隔离：
 *  - 本接口的实例由 `createStorage()` 构造为独立 `maintenance` 对象，
 *    与 `service` 对象**互斥**：maintenance 上不存在任何业务方法。
 *  - `blobRef`（R3-04 原属业务面的主区定位）与 `raw` 原始句柄（测试/运维用）一并
 *    迁入维护面，业务面不再持有它们。
 */
import type { MemoryNode, ContentHash } from './types.ts';
import type { BlobHandle, NodeRef } from './spi.ts';
import type { DatabaseSync } from './sqlite.ts';

export interface MaintenanceApi {
  /** 无授权读取（仅供 reconcile / 迁移 / 内部校验；不对外暴露） */
  unsafeInternalGet(
    ref: NodeRef,
    opts?: { includeArchived?: boolean }
  ): Promise<MemoryNode | null>;

  /** 启动对账：清理数据库残留 + 补偿未完成的 Purge 文件删除（R3-01） */
  reconcile(): Promise<{ fixed: number; filesRemoved: number }>;

  /** 处于维护态时释放资源（仅供内部测试/运维） */
  close(): void;

  /** 返回主区 blob 定位（维护路径 / 归档 / 恢复用；不向不可信调用方暴露） */
  blobRef(ownerId: string, hash: ContentHash): Promise<BlobHandle>;

  /** 原始 SQLite 句柄（仅供测试 / 深度运维 / 迁移使用，切勿外泄） */
  dangerousRawForTests(): InstanceType<typeof DatabaseSync>;
}