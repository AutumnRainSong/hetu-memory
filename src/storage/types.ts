/** 河图核心数据类型（主规格 v1.4 收敛定稿 §2）
 *  双维度状态机：版本 CURRENT/SUPERSEDED × 内容 FULL/MINIMIZED/STUB/TOMBSTONE
 *  PURGED 不存在于节点行——由 Purge Ledger 承载（§3.3）
 */
export type VersionState = 'CURRENT' | 'SUPERSEDED';
export type ContentState = 'FULL' | 'MINIMIZED' | 'STUB' | 'TOMBSTONE';
/** PURGED 仅在 Purge Ledger 中记录，节点物理不存在 */
export type ContentStateIncludingPurged = ContentState | 'PURGED';

/** Branded ID：编译期区分「逻辑记忆身份」与「具体版本」，防止混用（任务 B1）。
 *  NodeId = 逻辑记忆身份（跨版本不变）；RevisionId = 具体内容版本。
 */
declare const nodeIdBrand: unique symbol;
declare const revisionIdBrand: unique symbol;

export type NodeId = string & { readonly [nodeIdBrand]: true };
export type RevisionId = string & { readonly [revisionIdBrand]: true };

/** 构造与解包（边界处唯一允许 string ↔ branded 转换的地方） */
export const asNodeId = (s: string): NodeId => s as NodeId;
export const asRevisionId = (s: string): RevisionId => s as RevisionId;
export const nodeIdStr = (id: NodeId): string => id;
export const revisionIdStr = (id: RevisionId): string => id;

/** 内容哈希（sha256:...） */
declare const contentHashBrand: unique symbol;
export type ContentHash = string & { readonly [contentHashBrand]: true };
export const asContentHash = (s: string): ContentHash => s as ContentHash;

export interface Scope {
  owner_id: string;
  layer: 'user_identity' | 'agent_persona' | 'global' | 'project' | 'private_annotation';
  project_id: string | null;
  agent_id: string | null;
  visibility: 'owner' | 'project_agents' | 'all_agents' | 'shared_list';
  shared_with: string[];
}

export interface Provenance {
  agent_id: string;
  origin: 'hot-path' | 'session-digest' | 'reflection';
  method: 'rule' | 'model-assisted' | 'user-confirmed';
  source_refs: string[];
  producer_version: string;
  model_id: string | null;
  generated_at: string;
  confidence: number;
}

export interface MemoryNode {
  node_id: NodeId;
  revision_id: RevisionId;
  revision_sequence: number;
  content_hash: ContentHash;
  version_state: VersionState;
  content_state: ContentState;
  content_ref: string | null;       // blob 引用（STUB 时为 null，MINIMIZED 时指向归档区）
  stub_summary: string | null;      // STUB/MINIMIZED 摘要
  minimized_blob_ref: string | null; // 归档包内相对路径
  minimized_blob_hash: string | null;
  modality: 'text';
  confidence: number;
  provenance: Provenance;
  scope: Scope;
  sensitivity: 'normal' | 'sensitive' | 'restricted'; // 覆盖层当前值
  valid_from: string;
  valid_until: string | null;
  ingested_at: string;
  superseded_by: RevisionId | null; // 指向被替代的具体 revision（M1-A：NodeId/RevisionId 分离）
}

/** 边为判别联合：普通关系边引用 NodeId（逻辑记忆身份），
 *  supersedes 版本替代边引用 RevisionId（具体版本）——语义不可混用（M1-A 任务 E）。 */
export type Edge =
  | {
      type: 'cooccur' | 'annotation' | 'link';
      link_class?: 'pinned' | 'explicit' | 'inferred';
      from: NodeId;
      to: NodeId;
      weight: number;
      created_at: string;
    }
  | {
      type: 'supersedes';
      from: RevisionId;   // 新 revision
      to: RevisionId;     // 被替代的旧 revision
      weight: number;
      created_at: string;
    };

export interface OutboxEntry {
  kind: 'digest' | 'index' | 'gc';
  entity_id: string;
  seq: number;
  payload?: unknown;
}

export type ErrorCodeName = 'STATE_CONFLICT' | 'PURGED_FINAL' | 'STUB_IMMUTABLE' | 'ARCHIVE_MISSING' | 'INVALID_STATE' | 'QUOTA_HARD_LIMIT' | 'PERMISSION_DENIED' | 'WRITE_PAUSED' | 'MARKER_CONFLICT' | 'CAS_CONFLICT';
export type TxResult =
  | { ok: true; revision_id: RevisionId }
  | { ok: false; error: ErrorCodeName; currentRevision?: RevisionId };
