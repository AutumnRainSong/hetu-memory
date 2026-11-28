/** B-6 · remove() 仅 ENOENT 幂等；其余（EACCES/EIO/…）抛 BlobDeleteError；unlinkIfExists 区分 removed/absent。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, BlobDeleteError, sha256 } from '../../src/storage/blob-store.ts';

let blobRoot: string;
let blobs: BlobStore;
beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-b6-root-'));
  blobs = new BlobStore(blobRoot);
});
afterEach(() => {
  rmSync(blobRoot, { recursive: true, force: true });
});

describe('B-6 · remove 错误语义', () => {
  it('remove 已存在文件 → 成功，文件消失', async () => {
    const ref = BlobStore.mainRefFor('o-b6', sha256(Buffer.from('data')));
    await blobs.write(ref, 'data');
    await blobs.remove(ref);
    expect(await blobs.exists(ref)).toBe(false);
  });

  it('remove 不存在 → 幂等成功（ENOENT 不抛）', async () => {
    const ref = BlobStore.mainRefFor('o-b6', 'sha256:' + 'd'.repeat(64));
    await expect(blobs.remove(ref)).resolves.toBeUndefined();
  });

  it('BlobDeleteError code = BLOB_DELETE_FAILED', async () => {
    const e = new BlobDeleteError('workspaces/x', new Error('boom'));
    expect(e.code).toBe('BLOB_DELETE_FAILED');
    expect(e.name).toBe('BlobDeleteError');
  });

  it('unlinkIfExists 存在 → "removed"；不存在 → "absent"', async () => {
    const ref = BlobStore.mainRefFor('o-b6b', sha256(Buffer.from('delete-me')));
    await blobs.write(ref, 'delete-me');
    expect(await blobs.unlinkIfExists(ref)).toBe('removed');
    expect(await blobs.unlinkIfExists(ref)).toBe('absent');
    expect(await blobs.exists(ref)).toBe(false);
  });

  // EACCES/EPERM 类"目标存在但删不掉"的真实失败在 Windows NTFS + 当前进程权限下难以稳定复现
// （unlink 对只读文件在 Windows 上通常仍成功）。为不引入平台脆弱性，用确定性的
// "目标为目录"构造：unlink 对目录恒返回非 ENOENT（EPERM/EISDIR）→ 必须抛 BlobDeleteError。
  it('remove 在底层抛非 ENOENT 时包装为 BlobDeleteError', async () => {
    const { ownerKeyFor } = await import('../../src/storage/blob-store.ts');
    const ok = ownerKeyFor('o-b6d');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // 目标 <hex> 建成一个目录 → lstat 非符号链接，unlink 一个目录 → EPERM/EISDIR（非 ENOENT）
    mkdirSync(join(blobRoot, 'workspaces', ok, 'blobs', 'ff', 'f'.repeat(64)), { recursive: true });
    const ref = `workspaces/${ok}/blobs/ff/${'f'.repeat(64)}`;
    await expect(blobs.remove(ref)).rejects.toMatchObject({ code: 'BLOB_DELETE_FAILED' });
  });

  it('remove 遇 ENOENT（底层）→ 不抛，走幂等（不被包装）', async () => {
    // 默认：目标不存在直接返回（ENOENT 分支）。此处验证 remove 对不存在文件不抛。
    const ref = BlobStore.mainRefFor('o-b6c', 'sha256:' + 'e'.repeat(64));
    await expect(blobs.remove(ref)).resolves.toBeUndefined();
  });
});