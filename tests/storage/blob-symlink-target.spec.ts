/** B-2 · 目标文件本身是 symlink → write/remove 拒绝。
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
import { createHash } from 'node:crypto';
import { BlobStore, ownerKeyFor } from '../../src/storage/blob-store.ts';

let blobRoot: string;
let outside: string;
let marker: string;
let blobs: BlobStore;

beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-b2-root-'));
  outside = mkdtempSync(join(tmpdir(), 'hetu-b2-out-'));
  marker = join(outside, 'victim.txt');
  writeFileSync(marker, 'ORIGINAL');
  blobs = new BlobStore(blobRoot);
});
afterEach(() => {
  rmSync(blobRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function seedTargetSymlink(): void {
  const ok = ownerKeyFor('owner-b2');
  mkdirSync(join(blobRoot, 'workspaces'), { recursive: true });
  mkdirSync(join(blobRoot, 'workspaces', ok, 'blobs', 'aa'), { recursive: true });
  const target = join(blobRoot, 'workspaces', ok, 'blobs', 'aa', 'a'.repeat(64));
  symlinkSync(marker, target, 'file');
  void createHash; // used elsewhere indirectly
}

describe('B-2 · 目标文件为 symlink 防护', () => {
  it('write() 拒绝覆盖 symlink 目标，外部文件内容/存在性不变', async () => {
    seedTargetSymlink();
    let threw = false;
    try {
      await blobs.write(BlobStore.mainRefFor('owner-b2', 'sha256:' + 'a'.repeat(64)), 'HACK');
    } catch (e: any) {
      threw = /BLOB_PATH_REJECTED/.test(String(e.message));
    }
    expect(threw).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('ORIGINAL'); // 内容不变
    expect(existsSync(marker)).toBe(true); // 存在性不变
    expect(readdirSync(outside)).toEqual(['victim.txt']); // 未新增文件
  });

  it('remove() 拒绝删除 symlink 目标，外部文件内容/存在性不变', async () => {
    seedTargetSymlink();
    let threw = false;
    try {
      await blobs.remove(BlobStore.mainRefFor('owner-b2', 'sha256:' + 'a'.repeat(64)));
    } catch (e: any) {
      threw = /BLOB_PATH_REJECTED/.test(String(e.message));
    }
    expect(threw).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(outside)).toEqual(['victim.txt']);
  });

  it('unlinkIfExists 同样拒绝 symlink 目标', async () => {
    seedTargetSymlink();
    await expect(
      blobs.unlinkIfExists(BlobStore.mainRefFor('owner-b2', 'sha256:' + 'a'.repeat(64)))
    ).rejects.toThrow(/BLOB_PATH_REJECTED/);
    expect(readFileSync(marker, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(outside)).toEqual(['victim.txt']);
  });
});