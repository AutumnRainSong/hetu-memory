/** 任务 B1：NodeId / RevisionId / ContentHash 在编译期不可混用。
 *  运行期同一字符串，类型系统区分语义；本测试锁定「转换必须显式」。
 */
import { describe, it, expect } from 'vitest';
import {
  asNodeId,
  asRevisionId,
  asContentHash,
  nodeIdStr,
  revisionIdStr,
  type NodeId,
  type RevisionId,
  type Edge,
} from '../../src/storage/types.ts';

describe('Branded ID — 编译期区分', () => {
  it('显式转换后可解包回原字符串', () => {
    const n: NodeId = asNodeId('mem-1');
    const r: RevisionId = asRevisionId('rev-1');
    expect(nodeIdStr(n)).toBe('mem-1');
    expect(revisionIdStr(r)).toBe('rev-1');
  });

  it('ContentHash 独立品牌', () => {
    const h = asContentHash('sha256:' + 'a'.repeat(64));
    expect(String(h)).toBe('sha256:' + 'a'.repeat(64));
  });

  it('NodeId 不可隐式赋给 RevisionId（@ts-expect-error 在编译期生效）', () => {
    // @ts-expect-error NodeId 与 RevisionId 是不同品牌，不能互相赋值
    const r: RevisionId = asNodeId('mem-1');
    expect(String(r)).toBe('mem-1');
  });

  it('Edge 判别联合：supersedes 用 RevisionId，普通边用 NodeId', () => {
    const normal: Edge = {
      type: 'link',
      link_class: 'explicit',
      from: asNodeId('mem-A'),
      to: asNodeId('mem-B'),
      weight: 0.5,
      created_at: '2026-11-25T00:00:00Z',
    };
    const version: Edge = {
      type: 'supersedes',
      from: asRevisionId('rev-B'),
      to: asRevisionId('rev-A'),
      weight: 1,
      created_at: '2026-11-25T00:00:00Z',
    };
    expect(nodeIdStr(normal.from as NodeId)).toBe('mem-A');
    expect(revisionIdStr(version.from as RevisionId)).toBe('rev-B');
  });

  it('supersedes 边不接受 NodeId（@ts-expect-error 在编译期生效）', () => {
    // @ts-expect-error supersedes 边的 from 必须是 RevisionId，传 NodeId 编译期即失败
    const bad: Edge = {
      type: 'supersedes',
      from: asNodeId('mem-A'),
      to: asRevisionId('rev-B'),
      weight: 1,
      created_at: '2026-11-25T00:00:00Z',
    };
    expect(bad.type).toBe('supersedes');
  });
});
