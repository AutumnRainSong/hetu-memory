/** Storage SPI v2（Review R2 修订）
 *
 *  与 R1 的差异：
 *  - **所有读写方法都必须携带 AuthContext**（无授权即失败关闭，P0-A/P0-B）
 *  - `get` 的 auth 不再可选；内部无授权读取改由 `unsafeInternalGet` 显式命名（不对外暴露）
 *  - 写操作按能力位校验（P0-B）
 */
import type { MemoryNode, Edge, OutboxEntry, NodeId, RevisionId, ContentHash, TxResult } from './types.ts';
import type { AuthContext } from '../auth/context.ts';

export interface Cas {
  expectedRevision: RevisionId;
}

export interface TraverseBudget {
  maxNodes: number;
  maxEdges: number;
  maxTimeMs: number;
  maxFanOut: number;
}

export interface Subgraph {
  nodes: MemoryNode[];
  edges: Edge[];
}

export interface Hit {
  node_id: NodeId;
  revision_id: RevisionId;
  score: number;
  scope: MemoryNode['scope'];
}

export interface BlobHandle {
  ref: string;
  hash: ContentHash;
  inArchive: boolean;
}

/** 查询标识：按逻辑记忆取 CURRENT，或按具体版本精确取 */
export type NodeRef =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'revision'; revisionId: RevisionId };

/** StorageProvider（服务层调用；**不直接暴露给 Agent/MCP**）
 *
 *  授权契约：
 *  - 每个方法都接收 AuthContext，由服务层在 Token 验证后构造
 *  - 存储层只依据 AuthContext 判定，不信任任何调用方自述的 owner/agent
 */
export interface StorageProvider {
  /** 读取（需授权）：不可见 → null（等同不存在，不泄漏存在性） */
  get(ref: NodeRef, auth: AuthContext, opts?: { includeArchived?: boolean }): Promise<MemoryNode | null>;

  /** 写入（需专门能力位）：owner/agent 必须与 auth 一致 */
  put(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    auth: AuthContext,
    cas?: Cas
  ): Promise<TxResult>;

  /** 查询（需授权）：权限 + 敏感级在 SQL 层前置过滤 */
  query(q: { text?: string; scope?: Partial<MemoryNode['scope']> }, auth: AuthContext): Promise<Hit[]>;

  graphTraverse(from: NodeRef, budget: TraverseBudget, auth: AuthContext): Promise<Subgraph>;
  vectorSearch(v: Float32Array, budget: number, auth: AuthContext): Promise<Hit[]>;
  blobRef(hash: ContentHash): Promise<BlobHandle>;

  /** 仅供存储层内部与迁移使用；**不暴露给服务层以上任何调用者** */
  unsafeInternalGet(ref: NodeRef, opts?: { includeArchived?: boolean }): Promise<MemoryNode | null>;
}

/** StorageTx：事务与生命周期（全部需要授权） */
export interface StorageTx extends StorageProvider {
  putWithRevision(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    auth: AuthContext,
    cas?: Cas
  ): Promise<TxResult>;

  /** 精简：需 memory:minimize 能力 + 对目标可见 */
  minimize(nodeId: NodeId, auth: AuthContext, cas: Cas): Promise<TxResult>;

  /** 恢复：需 memory:revive 能力 + 对目标可见 */
  revive(revisionId: RevisionId, auth: AuthContext, cas: Cas): Promise<TxResult>;

  /** 硬擦除：需 memory:purge 能力；操作者写入 Ledger */
  purge(nodeId: NodeId, auth: AuthContext, reasonCategory: string, cas: Cas): Promise<TxResult>;

  /** 启动对账：清理节点、两类边、sensitivity_overlay、Outbox 残留 */
  reconcile(): Promise<{ fixed: number }>;
}
