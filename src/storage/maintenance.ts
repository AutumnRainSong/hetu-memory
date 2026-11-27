/** 内部维护 API（R3-04）：与面向业务的 StorageProvider 分离。
 *
 *  该接口暴露 `unsafeInternalGet` / `reconcile` 等**只供受信任服务层或运维**使用的能力，
 *  **不得**出现在 Agent / MCP / 普通业务调用者的接口面上。
 *
 *  加载 `SqliteStorageProvider` 后，业务服务层只持有 `StorageProvider`；
 *  仅在启动对账、迁移、运维等内部通道上 `as MaintenanceApi` 使用下列方法。
 */
import type { MemoryNode, RevisionId, NodeId } from './types.ts';

/** 查询标识（读取用） */
export type NodeRef =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'revision'; revisionId: RevisionId };

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
}