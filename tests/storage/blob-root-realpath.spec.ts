/** B-4 · Root 真实路径校验：构造时 realpath(root) 落盘为 realRootPath。
 *   - root 不存在 → 自动创建后 realpath
 *   - root 自身是 symlink → realRootPath 指向其真实目标
 *   - 所有 relative() 判定基于真实路径 → 即使 root 是 symlink，写入也在真实目录内、不逃逸 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, ownerKeyFor, sha256 } from '../../src/storage/blob-store.ts';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hetu-b4-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('B-4 · root 真实路径校验', () => {
  it('root 不存在时：构造自动创建并解析真实路径，写入正常落盘', async () => {
    const root = join(base, 'a', 'b', 'blobs');
    expect(existsSync(root)).toBe(false);
    const blobs = new BlobStore(root);
    expect(existsSync(root)).toBe(true);
    const ref = BlobStore.mainRefFor('o-b4', sha256(Buffer.from('data')));
    await blobs.write(ref, 'data');
    expect((await blobs.read(ref)).toString('utf8')).toBe('data');
  });

  it('root 自身是 symlink：realRootPath 指向真实目标，写入落于目标目录', async () => {
    const realDir = join(base, 'real');
    const linkDir = join(base, 'link');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir, 'dir'); // linkDir -> realDir
    const blobs = new BlobStore(linkDir);

    const ref = BlobStore.mainRefFor('o-b4b', sha256(Buffer.from('via-symlink')));
    await blobs.write(ref, 'via-symlink');
    // 文件落在真实目录（realDir）层级下
    const hex = sha256(Buffer.from('via-symlink')).replace(/^sha256:/, '');
    const expected = join(realDir, 'workspaces', ownerKeyFor('o-b4b'), 'blobs', hex.slice(0, 2), hex);
    expect(existsSync(expected)).toBe(true);
    expect(require('node:fs').readFileSync(expected, 'utf8')).toBe('via-symlink');
    // root 真实路径 = realpath(linkDir)
    expect(require('node:fs').realpathSync(linkDir)).toBe(realpathSync(realDir));
  });

  it('resolve 基于真实路径：root 为 symlink 时引用 base=real 不逃逸', async () => {
    const realDir = join(base, 'real2');
    const linkDir = join(base, 'link2');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir, 'dir');
    const blobs = new BlobStore(linkDir);
    const ref = BlobStore.mainRefFor('o-b4c', sha256(Buffer.from('x')));
    const abs = blobs.resolve(ref);
    // 绝对路径必须以真实目录开头
    expect(abs.startsWith(realpathSync(realDir))).toBe(true);
    expect(abs.startsWith(linkDir)).toBe(false);
  });
});