/** B-7 · 跨 owner 物理隔离：同内容 hash + 两不同 ownerId → 不同物理路径；写两文件、删一另一仍在。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

let blobRoot: string;
let blobs: BlobStore;
beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-b7-root-'));
  blobs = new BlobStore(blobRoot);
});
afterEach(() => {
  rmSync(blobRoot, { recursive: true, force: true });
});

const CONTENT = '完全相同的内容，跨 owner 物理隔离';
const CONTENT_ARCHIVE = 'archive 完全相同内容';

describe('B-7 · 跨 owner 物理隔离', () => {
  it('同 hash 两 owner → mainRefFor 路径不同', () => {
    const hash = sha256(Buffer.from(CONTENT));
    const r1 = BlobStore.mainRefFor('owner-a', hash);
    const r2 = BlobStore.mainRefFor('owner-b', hash);
    expect(r1).not.toBe(r2);
    expect(ownerKeyFor('owner-a')).not.toBe(ownerKeyFor('owner-b'));
  });

  it('同 hash 两 owner → archiveRefFor 路径也不同', () => {
    const hash = sha256(Buffer.from(CONTENT_ARCHIVE));
    expect(BlobStore.archiveRefFor('owner-a', hash)).not.toBe(BlobStore.archiveRefFor('owner-b', hash));
  });

  it('写两个物理独立文件：内容相同但文件不共享；删一个另一个仍在', async () => {
    const hash = sha256(Buffer.from(CONTENT));
    const ha = BlobStore.mainRefFor('owner-a', hash);
    const hb = BlobStore.mainRefFor('owner-b', hash);

    const rA = await blobs.writeAtomic(ha, CONTENT);
    const rB = await blobs.writeAtomic(hb, CONTENT);
    expect(rA).toBe(rB); // 内容 hash 相同

    expect(await blobs.exists(ha)).toBe(true);
    expect(await blobs.exists(hb)).toBe(true);
    expect((await blobs.read(ha)).toString('utf8')).toBe(CONTENT);
    expect((await blobs.read(hb)).toString('utf8')).toBe(CONTENT);

    // 物理路径确实不同文件
    const absA = blobs.resolve(ha);
    const absB = blobs.resolve(hb);
    expect(absA).not.toBe(absB);

    // 删 owner-a 的文件，owner-b 仍在
    await blobs.remove(ha);
    expect(await blobs.exists(ha)).toBe(false);
    expect(await blobs.exists(hb)).toBe(true);
    expect((await blobs.read(hb)).toString('utf8')).toBe(CONTENT);
  });

  it('archive 同理：删 owner-a 的归档，owner-b 归档仍在', async () => {
    const hash = sha256(Buffer.from(CONTENT_ARCHIVE));
    const aaE = BlobStore.archiveRefFor('owner-a', hash);
    const abE = BlobStore.archiveRefFor('owner-b', hash);
    await blobs.writeAtomic(aaE, CONTENT_ARCHIVE);
    await blobs.writeAtomic(abE, CONTENT_ARCHIVE);

    await blobs.remove(aaE);
    expect(await blobs.exists(aaE)).toBe(false);
    expect(await blobs.exists(abE)).toBe(true);
  });

  it('同 owner 内同 hash 复用同一对象（跨 Revision 去重）', async () => {
    const hash = sha256(Buffer.from('dedupe-content'));
    expect(BlobStore.mainRefFor('owner-a', hash)).toBe(BlobStore.mainRefFor('owner-a', hash));
    // 两次写同一 ref → 只存在一个物理文件
    await blobs.write(BlobStore.mainRefFor('owner-a', hash), 'dedupe-content');
    await blobs.write(BlobStore.mainRefFor('owner-a', hash), 'dedupe-content');
    expect(await blobs.exists(BlobStore.mainRefFor('owner-a', hash))).toBe(true);
    // 同目录下没有第二个副本（内容寻址位置唯一）
    const hex = hash.replace(/^sha256:/, '');
    const dir = join(blobRoot, 'workspaces', ownerKeyFor('owner-a'), 'blobs', hex.slice(0, 2));
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    expect(readdirSync(dir).filter((f) => f.endsWith(hex))).toEqual([hex]);
    void existsSync;
  });
});