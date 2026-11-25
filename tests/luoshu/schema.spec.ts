/** 洛书 v0.3 Schema 校验（AJV 正式验证器）+ 边 ID 语义对应测试（任务 E6）
 *
 *  任务 E：普通关系边 from/to = NodeId；supersedes 边 from/to = RevisionId。
 *  Schema 用 oneOf 判别；本测试确保 TS 类型、Schema、样例三方一致。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Edge } from '../../src/storage/types.ts';

const VALIDATOR = 'node scripts/validate-luoshu.mjs';
const SAMPLE = 'schemas/luoshu-v0.3.sample.json';

function loadSample(): any {
  return JSON.parse(readFileSync(SAMPLE, 'utf8'));
}

function runValidator(doc: unknown): { ok: boolean; out: string } {
  const p = join(tmpdir(), `luoshu-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(doc));
  try {
    return { ok: true, out: execSync(`${VALIDATOR} ${p}`, { encoding: 'utf8' }) };
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

describe('洛书 v0.3 — 正式样例', () => {
  it('样例通过 AJV 校验', () => {
    const out = execSync(`${VALIDATOR} ${SAMPLE}`, { encoding: 'utf8' });
    expect(out).toContain('洛书包校验通过');
  });
});

describe('洛书 v0.3 — PRIVATE_LEAK 全文件拒绝', () => {
  it('private_annotation 的 visibility≠owner → 拒绝', () => {
    const doc = loadSample();
    doc.nodes[0].scope = {
      owner_id: 'default',
      layer: 'private_annotation',
      project_id: null,
      agent_id: 'a1',
      visibility: 'all_agents',
      shared_with: [],
    };
    const r = runValidator(doc);
    expect(r.ok).toBe(false);
  });
});

describe('洛书 v0.3 — STUB/MINIMIZED 字段要求', () => {
  it('STUB 缺 stub_summary → 拒绝', () => {
    const doc = loadSample();
    doc.nodes[1].content_state = 'stub';
    doc.nodes[1].stub_summary = null;
    expect(runValidator(doc).ok).toBe(false);
  });

  it('MINIMIZED 缺归档字段或路径不合规 → 拒绝', () => {
    const doc = loadSample();
    doc.nodes[0].content_state = 'minimized';
    doc.nodes[0].stub_summary = '摘要';
    doc.nodes[0].minimized_blob_ref = 'not-archive-path';
    doc.nodes[0].minimized_blob_hash = 'sha256:' + 'a'.repeat(64);
    expect(runValidator(doc).ok).toBe(false);
  });

  it('MINIMIZED 字段齐全且路径合规 → 通过', () => {
    const doc = loadSample();
    doc.nodes[0].content_state = 'minimized';
    doc.nodes[0].stub_summary = '摘要';
    doc.nodes[0].minimized_blob_ref = 'archive/mem_01ABC/rev_3.txt';
    doc.nodes[0].minimized_blob_hash = 'sha256:' + 'a'.repeat(64);
    doc.nodes[0].content_ref = null;
    expect(runValidator(doc).ok).toBe(true);
  });
});

describe('洛书 v0.3 — 边 ID 语义（任务 E）', () => {
  it('supersedes 边引用 RevisionId → 通过', () => {
    const doc = loadSample();
    doc.edges = [
      { type: 'supersedes', from: 'rev_01ABC_3', to: 'rev_01ABC_2', weight: 1.0, created_at: '2026-11-20T08:00:00Z' },
    ];
    expect(runValidator(doc).ok).toBe(true);
  });

  it('supersedes 边带 link_class 非法字段 → 拒绝（判别联合不允许额外字段）', () => {
    const doc = loadSample();
    doc.edges = [
      {
        type: 'supersedes',
        link_class: 'explicit',
        from: 'rev_01ABC_3',
        to: 'rev_01ABC_2',
        weight: 1.0,
        created_at: '2026-11-20T08:00:00Z',
      },
    ];
    expect(runValidator(doc).ok).toBe(false);
  });

  it('普通边带 link_class → 通过（cooccur/link 允许分类）', () => {
    const doc = loadSample();
    doc.edges = [
      {
        type: 'link',
        link_class: 'pinned',
        from: 'mem_01ABC',
        to: 'mem_01ABC',
        weight: 0.6,
        created_at: '2026-11-20T08:00:00Z',
      },
    ];
    expect(runValidator(doc).ok).toBe(true);
  });

  it('TS 类型与 Schema 语义一致（编译期约束的可运行确认）', () => {
    // 普通边：NodeId 语义
    const normal: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: 'mem_A',
      to: 'mem_B',
      weight: 0.5,
      created_at: '2026-11-20T08:00:00Z',
    };
    // supersedes 边：RevisionId 语义
    const supersedes: Edge = {
      type: 'supersedes',
      from: 'rev_B',
      to: 'rev_A',
      weight: 1,
      created_at: '2026-11-20T08:00:00Z',
    };
    expect(normal.type).not.toBe('supersedes');
    expect(supersedes.type).toBe('supersedes');
  });
});

describe('洛书 v0.3 — 重复 revision 检测', () => {
  it('同 node_id + revision_sequence 重复 → 拒绝', () => {
    const doc = loadSample();
    doc.nodes.push({ ...doc.nodes[0] }); // 完全重复
    expect(runValidator(doc).ok).toBe(false);
  });
});
