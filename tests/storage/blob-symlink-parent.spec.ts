/** B-3 · 父目录 symlink 防护：目标祖先目录中任一级若为逃逸 symlink → read/write/remove 拒绝。
 *  每用例必须断言：外部现有文件 内容不变 + 存在性不变 + 未新增文件。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, ownerKeyFor } from '../../src/storage/blob-store.ts';

let blobRoot: string;
let outside: string;
let blobs: BlobStore;
let outsideDirMarker: string;

beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-b3-root-'));
  outside = mkdtempSync(join(tmpdir(), 'hetu-b3-out-'));
  outsideDirMarker = join(outside, 'secret.txt');
  writeFileSync(outsideDirMarker, 'SECRET');
  blobs = new BlobStore(blobRoot);
});
afterEach(() => {
  rmSync(blobRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function makeRef() {
  const ok = ownerKeyFor('owner-b3');
  return { ok, hex: 'b'.repeat(64) };
}
function fullParentPaths(ok: string, hex: string) {
  return {
    blobsDir: join(blobRoot, 'workspaces', ok, 'blobs'),
    shardDir: join(blobRoot, 'workspaces', ok, 'blobs', hex.slice(0, 2)),
  };
}
function refOf(ok: string, hex: string): string {
  return `workspaces/${ok}/blobs/${hex.slice(0, 2)}/${hex}`;
}

describe('B-3 · 父目录 symlink 防护', () => {
  it('写：深层父目录(<hash[0:2]>)被替换为逃逸 symlink → 拒绝，外部不变', async () => {
    const { ok, hex } = makeRef();
    const p = fullParentPaths(ok, hex);
    mkdirSync(p.blobsDir, { recursive: true });
    symlinkSync(outside, p.shardDir, 'dir');

    let threw = false;
    try {
      await blobs.write(refOf(ok, hex), 'HACK');
    } catch (e: any) {
      threw = /BLOB_PATH_REJECTED/.test(String(e.message));
    }
    expect(threw).toBe(true);
    expect(readFileSync(outsideDirMarker, 'utf8')).toBe('SECRET');
    expect(existsSync(outsideDirMarker)).toBe(true);
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('读：逃逸 symlink 父目录 → 拒绝，外部 secret 存在性与内容不变', async () => {
    const { ok, hex } = makeRef();
    const p = fullParentPaths(ok, hex);
    mkdirSync(p.blobsDir, { recursive: true });
    symlinkSync(outside, p.shardDir, 'dir');

    await expect(blobs.read(refOf(ok, hex))).rejects.toThrow(/BLOB_PATH_REJECTED/);
    expect(readFileSync(outsideDirMarker, 'utf8')).toBe('SECRET');
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('删：逃逸 symlink 父目录 → 拒绝删除，外部文件内容/存在性不变', async () => {
    const { ok, hex } = makeRef();
    const p = fullParentPaths(ok, hex);
    mkdirSync(p.blobsDir, { recursive: true });
    symlinkSync(outside, p.shardDir, 'dir');

    let threw = false;
    try {
      await blobs.remove(refOf(ok, hex));
    } catch (e: any) {
      threw = /BLOB_PATH_REJECTED/.test(String(e.message));
    }
    expect(threw).toBe(true);
    expect(readFileSync(outsideDirMarker, 'utf8')).toBe('SECRET');
    expect(existsSync(outsideDirMarker)).toBe(true);
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('安全：目录未逃逸（都在 root 内）时正常写/读', async () => {
    const { ok, hex } = makeRef();
    const ref = refOf(ok, hex);
    await blobs.write(ref, 'legit-data');
    expect((await blobs.read(ref)).toString('utf8')).toBe('legit-data');
  });
});