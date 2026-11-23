/** 河图核心数据类型（主规格 v1.4 收敛定稿 §2）
 *  双维度状态机：版本 CURRENT/SUPERSEDED × 内容 FULL/MINIMIZED/STUB/TOMBSTONE
 *  PURGED 不存在于节点行——由 Purge Ledger 承载（§3.3）
 */
export type VersionState = 'CURRENT' | 'SUPERSEDED';
export type ContentState = 'FULL' | 'MINIMIZED' | 'STUB' | 'TOMBSTONE';
/** PURGED 仅在 Purge Ledger 中记录，节点物理不存在 */
export type ContentStateIncludingPurged = ContentState | 'PURGED';

export type NodeId = string;
export type RevisionId = string;
export type ContentHash = string; // sha256:...

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
  superseded_by: NodeId | null;
}

export interface Edge {
  type: 'cooccur' | 'supersedes' | 'annotation' | 'link';
  link_class?: 'pinned' | 'explicit' | 'inferred';
  from: NodeId;
  to: NodeId;
  weight: number;
  created_at: string;
}

export interface OutboxEntry {
  kind: 'digest' | 'index' | 'gc';
  entity_id: string;
  seq: number;
  payload?: unknown;
}

export type TxResult =
  | { ok: true; revision_id: RevisionId }
  | { ok: false; error: keyof typeof ErrorCodes; currentRevision?: RevisionId };
