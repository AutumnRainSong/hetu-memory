/** 任务 B4：洛书语义校验（Schema 之外的跨字段/跨节点一致性）。
 *  覆盖：revision 引用存在性、supersedes 同逻辑记忆、方向与序号、环、Scope 自洽、私有越权。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALIDATOR = 'node scripts/validate-luoshu.mjs';
const SAMPLE = 'schemas/luoshu-v0.3.sample.json';

function load(): any {
  return JSON.parse(readFileSync(SAMPLE, 'utf8'));
}

function validate(doc: unknown): { ok: boolean; out: string } {
  const p = join(tmpdir(), `luoshu-sem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(doc));
  try {
    return { ok: true, out: execSync(`${VALIDATOR} ${p}`, { encoding: 'utf8' }) };
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

/** 构造一对同逻辑记忆的 revision */
function withRevisions(doc: any, fromSeq = 3, toSeq = 2) {
  doc.nodes = [
    {
      ...doc.nodes[0],
      revision_id: 'rev_X_3',
      revision_sequence: fromSeq,
      version_state: 'current',
      content_state: 'full',
      content_ref: 'blobs/xx/r3.txt',
      stub_summary: null,
      minimized_blob_ref: null,
      minimized_blob_hash: null,
    },
    {
      ...doc.nodes[0],
      revision_id: 'rev_X_2',
      revision_sequence: toSeq,
      version_state: 'superseded',
      content_state: 'stub',
      content_ref: null,
      stub_summary: '旧版本摘要',
      minimized_blob_ref: null,
      minimized_blob_hash: null,
      superseded_by: 'rev_X_3',
    },
  ];
  doc.edges = [
    { type: 'supersedes', from: 'rev_X_3', to: 'rev_X_2', weight: 1, created_at: '2026-11-25T00:00:00Z' },
  ];
  return doc;
}

describe('B4 — Revision 图语义', () => {
  it('合法 supersedes（同逻辑记忆、序号递减）→ 通过', () => {
    expect(validate(withRevisions(load())).ok).toBe(true);
  });

  it('supersedes 跨逻辑记忆 → 拒绝', () => {
    const doc = withRevisions(load());
    doc.nodes[1].node_id = 'mem_OTHER';
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/跨逻辑记忆/);
  });

  it('supersedes 序号方向非法（新版本序号不大于旧版本）→ 拒绝', () => {
    const doc = withRevisions(load(), 1, 5);
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/方向\/序号非法/);
  });

  it('supersedes 成环 → 拒绝', () => {
    const doc = withRevisions(load());
    doc.edges.push({
      type: 'supersedes',
      from: 'rev_X_2',
      to: 'rev_X_3',
      weight: 1,
      created_at: '2026-11-25T00:00:00Z',
    });
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/环/);
  });
});

describe('B4 — Scope 自洽性', () => {
  it('layer=project 缺 project_id → 拒绝', () => {
    const doc = load();
    doc.nodes[0].scope.project_id = null;
    const r = validate(doc);
    expect(r.ok).toBe(false); // AJV 层已拒绝（Schema 层有 required 约束），语义层为二道防线
  });

  it('layer=agent_persona 缺 agent_id → 拒绝', () => {
    const doc = load();
    doc.nodes[0].scope = {
      owner_id: 'default',
      layer: 'agent_persona',
      project_id: null,
      agent_id: null,
      visibility: 'owner',
      shared_with: [],
    };
    const r = validate(doc);
    expect(r.ok).toBe(false); // AJV 层已拒绝
  });

  it('visibility=shared_list 但 shared_with 为空 → 拒绝', () => {
    const doc = load();
    doc.nodes[0].scope.visibility = 'shared_list';
    doc.nodes[0].scope.shared_with = [];
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/shared_with 为空/);
  });

  it('private_annotation 的 visibility≠owner → 拒绝（私有越权导出）', () => {
    const doc = load();
    doc.nodes[0].scope = {
      owner_id: 'default',
      layer: 'private_annotation',
      project_id: null,
      agent_id: 'agent-a',
      visibility: 'project_agents',
      shared_with: [],
    };
    const r = validate(doc);
    expect(r.ok).toBe(false);
  });
});

describe('B4 — 边 ID 语义', () => {
  it('supersedes 引用不存在的 revision → 拒绝', () => {
    const doc = withRevisions(load());
    doc.edges[0].to = 'rev_NOT_EXIST';
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/revision_id/);
  });

  it('普通边引用不存在的 node_id → 拒绝', () => {
    const doc = load();
    doc.edges = [
      { type: 'link', from: 'mem_NOT_EXIST', to: 'mem_01ABC', weight: 0.5, created_at: '2026-11-25T00:00:00Z' },
    ];
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/node_id/);
  });
});
