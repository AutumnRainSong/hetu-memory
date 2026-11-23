/** Storage SPI v1（主规格 §1.1 StorageTx 契约的实现接口）
 *  不变量（存储层强制，非应用层）：
 *  1. 链尾唯一：supersede 通过条件写保证单链
 *  2. 节点不可变：无 UPDATE content 路径，只有 INSERT 新 revision
 *  3. Purge Ledger 先行提交（提交点），级联删除崩溃后由启动对账补删
 *  4. Writer 队列单写者；多进程一致性由 SQLite WAL + busy_timeout + 条件写承载
 */
import type { MemoryNode, Edge, OutboxEntry, NodeId, RevisionId, ContentHash, TxResult } from './types.ts';

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
  ref: string;      // 主区 blobs/<hash前缀>/<hash> 或归档区 archive/<node_id>/rev_N.txt
  hash: ContentHash;
  inArchive: boolean;
}

/** 六原语（v1.4 §1） */
export interface StorageProvider {
  get(id: NodeId, opts?: { includeArchived?: boolean }): Promise<MemoryNode | null>;
  put(node: MemoryNode, edges: Edge[], outbox: OutboxEntry[], cas?: Cas): Promise<TxResult>;
  query(q: { text?: string; scope: Partial<MemoryNode['scope']> }): Promise<Hit[]>;
  graphTraverse(from: NodeId, budget: TraverseBudget): Promise<Subgraph>; // MVP 阶段一: throw UNIMPLEMENTED
  vectorSearch(v: Float32Array, budget: number): Promise<Hit[]>;          // MVP 阶段一: throw UNIMPLEMENTED
  blobRef(hash: ContentHash): Promise<BlobHandle>;
}

/** StorageTx：事务与原子操作（收敛 P0-3 补充，主规格 §1.1）
 *  - putWithRevision：Node+Revision+Edge+Outbox 同一事务原子提交
 *  - minimize：归档 blob 先写 → 单事务改 content_state/minimized_blob_ref → 主区 blob 延迟 GC
 *  - purge：两阶段——Ledger insert（提交点）→ 级联删除；崩溃后启动对账补删
 *  - revive：TOMBSTONE→FULL（归档校验）/ MINIMIZED→FULL（同）；语义见主规格 §3.1
 *  - 启动对账：reconcile() 幂等，任意崩溃序列收敛
 */
export interface StorageTx extends StorageProvider {
  putWithRevision(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    cas?: Cas
  ): Promise<TxResult>;
  minimize(id: NodeId, archive: BlobHandle, cas: Cas): Promise<TxResult>;
  purge(id: NodeId, reasonCategory: string, cas: Cas): Promise<TxResult>;
  revive(id: NodeId, cas: Cas): Promise<TxResult>;
  /** 启动对账：Ledger 有而节点表有 → 补删；归档存在但状态非 MINIMIZED → 补完成。幂等。 */
  reconcile(): Promise<{ fixed: number }>;
}
