/** B-1 · owner namespace：main/archive 引用都按内容寻址，路径带 sha256 owner-key 摘要。
 *  断言：owner_id 绝不原样进路径；同 owner 稳定；跨 owner 不同；hash 按 [0:2] 分片；无 sha256: 前缀。 */
import { describe, it, expect } from 'vitest';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

describe('B-1 · owner namespace', () => {
  it('ownerKeyFor 为 sha256(NFC)[0:32]，与 owner_id 原文无关', () => {
    const k = ownerKeyFor('ws-1');
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    // 不含原样 owner_id
    expect(k).not.toContain('ws-1');
  });

  it('ownerKeyFor 同 owner 稳定、不同 owner 不同', () => {
    expect(ownerKeyFor('ws-1')).toBe(ownerKeyFor('ws-1'));
    expect(ownerKeyFor('ws-1')).not.toBe(ownerKeyFor('ws-2'));
    // NFC 规范化：同一逻辑组合形式映射一致
    expect(ownerKeyFor('\u00e9')).toBe(ownerKeyFor('e\u0301'));
  });

  it('mainRefFor 内容寻址：workspaces/<owner-key>/blobs/<h[0:2]>/<h>，无 sha256: 前缀', () => {
    const hash = sha256(Buffer.from('hello'));
    const hex = hash.replace(/^sha256:/, '');
    const ref = BlobStore.mainRefFor('ws-1', hash);
    expect(ref).toMatch(/^workspaces\/[0-9a-f]{32}\/blobs\//);
    expect(ref).toBe(`workspaces/${ownerKeyFor('ws-1')}/blobs/${hex.slice(0, 2)}/${hex}`);
    expect(ref).not.toContain('sha256:');
    expect(ref).not.toContain('ws-1'); // owner_id 绝不原样进路径
  });

  it('archiveRefFor 也为内容寻址：workspaces/<owner-key>/archive/<h[0:2]>/<h>', () => {
    const hash = sha256(Buffer.from('arch-content'));
    const hex = hash.replace(/^sha256:/, '');
    const ref = BlobStore.archiveRefFor('ws-1', hash);
    expect(ref).toMatch(/^workspaces\/[0-9a-f]{32}\/archive\//);
    expect(ref).toBe(`workspaces/${ownerKeyFor('ws-1')}/archive/${hex.slice(0, 2)}/${hex}`);
  });

  it('同 owner 同 hash → main 与 archive 路径不同空间', () => {
    const hash = sha256(Buffer.from('x'));
    const m = BlobStore.mainRefFor('ws-9', hash);
    const a = BlobStore.archiveRefFor('ws-9', hash);
    expect(m).not.toBe(a);
    expect(m).toContain('/blobs/');
    expect(a).toContain('/archive/');
  });

  it('同 owner 同内容 hash 去重（同路径）；不同内容不同路径', () => {
    const c1 = 'same content';
    const hash1 = sha256(Buffer.from(c1));
    expect(BlobStore.mainRefFor('o1', hash1)).toBe(BlobStore.mainRefFor('o1', hash1));
    const hash2 = sha256(Buffer.from('different'));
    expect(BlobStore.mainRefFor('o1', hash1)).not.toBe(BlobStore.mainRefFor('o1', hash2));
  });
});