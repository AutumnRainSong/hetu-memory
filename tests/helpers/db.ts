/** 测试辅助：插入 nodes 行（Migration 002 之后 scope 为必需字段）。 */
import type { DatabaseSync } from '../../src/storage/sqlite.ts';

export interface NodeOverrides {
  node_id?: string;
  revision_id?: string;
  revision_sequence?: number;
  content_hash?: string;
  version_state?: 'CURRENT' | 'SUPERSEDED';
  content_state?: 'FULL' | 'MINIMIZED' | 'STUB' | 'TOMBSTONE';
  content_ref?: string | null;
  stub_summary?: string | null;
  minimized_blob_ref?: string | null;
  minimized_blob_hash?: string | null;
  provenance?: string;
  superseded_by?: string | null;
  superseded_by_revision?: string | null;
  owner_id?: string;
  layer?: string;
  project_id?: string | null;
  agent_id?: string | null;
  visibility?: string;
  shared_with?: string;
}

let counter = 0;

export function hashOf(seed?: string): string {
  const s = seed ?? String(++counter);
  return 'sha256:' + s.repeat(64).slice(0, 64);
}

export function insertNode(
  db: InstanceType<typeof DatabaseSync>,
  over: NodeOverrides = {}
): Required<Pick<NodeOverrides, 'node_id' | 'revision_id' | 'revision_sequence'>> {
  const row: NodeOverrides = {
    node_id: 'mem-1001',
    revision_id: 'rev-1001-1',
    revision_sequence: 1,
    content_hash: hashOf('a'),
    version_state: 'CURRENT',
    content_state: 'FULL',
    content_ref: 'blobs/aa/mem-1001-rev1.txt',
    stub_summary: null,
    minimized_blob_ref: null,
    minimized_blob_hash: null,
    provenance: JSON.stringify({
      agent_id: 'agent-a',
      origin: 'hot-path',
      method: 'user-confirmed',
      source_refs: [],
      producer_version: 'hetu 0.1.0',
      model_id: null,
      generated_at: '2026-11-24T00:00:00Z',
      confidence: 0.9,
    }),
    superseded_by: null,
    superseded_by_revision: null,
    owner_id: 'user-default',
    layer: 'project',
    project_id: 'proj-1',
    agent_id: null,
    visibility: 'project_agents',
    shared_with: '[]',
    ...over,
  };

  db.prepare(
    `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
      content_state, content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash,
      modality, confidence, provenance, valid_from, valid_until, ingested_at,
      superseded_by, superseded_by_revision,
      owner_id, layer, project_id, agent_id, visibility, shared_with)
     VALUES(@node_id,@revision_id,@revision_sequence,@content_hash,@version_state,
      @content_state,@content_ref,@stub_summary,@minimized_blob_ref,@minimized_blob_hash,
      'text',0.8,@provenance,'2026-11-24T00:00:00Z',NULL,'2026-11-24T00:00:00Z',
      @superseded_by,@superseded_by_revision,
      @owner_id,@layer,@project_id,@agent_id,@visibility,@shared_with)`
  ).run(row as never);

  return {
    node_id: row.node_id!,
    revision_id: row.revision_id!,
    revision_sequence: row.revision_sequence!,
  };
}

/** 读取单行（按 revision_id） */
export function getRevision(db: InstanceType<typeof DatabaseSync>, revisionId: string): any {
  return db.prepare('SELECT * FROM nodes WHERE revision_id=?').get(revisionId);
}

/** 表结构快照：{ table: [columns...] } */
export function columnSnapshot(db: InstanceType<typeof DatabaseSync>): Record<string, string[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(r => r.name)
    .filter(n => !n.startsWith('sqlite_'))
    .sort();
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    out[t] = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[])
      .map(c => c.name)
      .sort();
  }
  return out;
}
