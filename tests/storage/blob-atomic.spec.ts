/** B-5 · writeAtomic：临时文件 + rename 原子替换；写失败不留半成品；兼容 write 别名。
 *  B-2 交界：目标为 symlink → rename 前拒绝。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, sha256, ownerKeyFor } from '../../src/storage/blob-store.ts';

let blobRoot: string;
let outside: string;
let blobs: BlobStore;
beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-b5-root-'));
  outside = mkdtempSync(join(tmpdir(), 'hetu-b5-out-'));
  blobs = new BlobStore(blobRoot);
});
afterEach(() => {
  rmSync(blobRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function refOf(owner: string, content: string): string {
  const hex = sha256(Buffer.from(content)).replace(/^sha256:/, '');
  return `workspaces/${ownerKeyFor(owner)}/blobs/${hex.slice(0, 2)}/${hex}`;
}

describe('B-5 · writeAtomic 原子写', () => {
  it('写入并返回 hash，无 .tmp 残留', async () => {
    const ref = BlobStore.mainRefFor('o-b5', sha256(Buffer.from('hello')));
    const h = await blobs.writeAtomic(ref, 'hello');
    expect(h).toBe(sha256(Buffer.from('hello')));
    expect((await blobs.read(ref)).toString('utf8')).toBe('hello');
    const dir = join(blobRoot, 'workspaces', ownerKeyFor('o-b5'), 'blobs', '2c');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('write() 是 writeAtomic 别名：等价写入', async () => {
    const ref = BlobStore.mainRefFor('o-b5b', sha256(Buffer.from('via-alias')));
    const h = await blobs.write(ref, 'via-alias');
    expect(h).toBe(sha256(Buffer.from('via-alias')));
    expect((await blobs.read(ref)).toString('utf8')).toBe('via-alias');
  });

  it('目标为 symlink → 拒绝，不留 tmp 不触碰外部', async () => {
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL');
    const hex = 'c'.repeat(64);
    const ok = ownerKeyFor('o-b5c');
    mkdirSync(join(blobRoot, 'workspaces', ok, 'blobs', 'cc'), { recursive: true });
    const target = join(blobRoot, 'workspaces', ok, 'blobs', 'cc', hex);
    symlinkSync(victim, target, 'file');

    const ref = `workspaces/${ok}/blobs/cc/${hex}`;
    await expect(blobs.writeAtomic(ref, 'NEW')).rejects.toThrow(/BLOB_PATH_REJECTED/);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    expect(readdirSync(join(blobRoot, 'workspaces', ok, 'blobs', 'cc')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('覆盖写同一 ref：内容替换为最新', async () => {
    const ref = refOf('o-b5d', 'v1');
    await blobs.write(ref, 'v1');
    await blobs.write(ref, 'v2');
    expect((await blobs.read(ref)).toString('utf8')).toBe('v2');
  });
});