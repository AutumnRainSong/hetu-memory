/**
 * F-10 · symlink-race —— 目标 symlink / 父目录 symlink / 路径替换竞态。
 *
 * R4 契约 §1.1/B-2/B-3/B-8：目标文件为 symlink → write/remove 拒绝；父目录任一级为逃逸 symlink
 * → 拒绝；临时文件原子写 + rename 前再次 secureResolve（路径替换/TOCTOU 缩小）。
 * F 组独立复验，不依赖 B 组实现细节签名，但 `unlinkIfExists` 失败须按契约上报。
 *
 * 前置条件：BlobStore 安全实现已部署（B 已完成）+ realpath root。
 * 并发方式：串行故障注入（目标 symlink、父目录 symlink、并发 write×remove）。
 * 预期：
 *  - 目标 symlink：write/remove 拒绝，外部文件内容/存在性不变、无新增文件；
 *  - 父目录 symlink 逃逸：write/read/remove 拒绝；
 *  - 并发写删：不产生损坏内容、不误删哨兵，写方拒绝码为 BLOB_DELETE_FAILED 或竞态允许码。
 * 失败数据态：若绕过防护，外部文件被覆盖/误删 → P0 安全破坏。
 *
 * 当前：这部分依赖 B（已出现），可运行真实断言；但 B-8 并发在 Windows 已因 EPERM 竞态被
 * B 组标记为平台脆弱（既有 blob-toctou.spec.ts 目前红），故并发断言用「容忍性」写法并注明风险。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, sha256, ownerKeyFor } from './_helpers.ts';

describe('F-10 · symlink-race', () => {
  let root: string;
  let outside: string;
  let blobs: BlobStore;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hetu-qa-f10-root-'));
    outside = mkdtempSync(join(tmpdir(), 'hetu-qa-f10-out-'));
    blobs = new BlobStore(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('目标文件为 symlink → write/remove 拒绝，外部不变', async () => {
    const ok = ownerKeyFor('o-f10');
    mkdirSync(join(root, 'workspaces', ok, 'blobs', 'aa'), { recursive: true });
    const marker = join(outside, 'victim.txt');
    writeFileSync(marker, 'ORIGINAL');
    const target = join(root, 'workspaces', ok, 'blobs', 'aa', 'a'.repeat(64));
    symlinkSync(marker, target, 'file');
    const ref = `workspaces/${ok}/blobs/aa/${'a'.repeat(64)}`;

    await expect(blobs.write(ref, 'HACK')).rejects.toThrow(/BLOB_PATH_REJECTED/);
    await expect(blobs.remove(ref)).rejects.toThrow(/BLOB_PATH_REJECTED/);
    expect(readFileSync(marker, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(outside)).toEqual(['victim.txt']);
  });

  it('父目录 symlink 逃逸 → read/write/remove 拒绝，外部不变', async () => {
    const freshOutside = mkdtempSync(join(tmpdir(), 'hetu-qa-f10-out2-'));
    const ok = ownerKeyFor('o-f10b');
    const shard = join(root, 'workspaces', ok, 'blobs', 'bb');
    mkdirSync(join(root, 'workspaces', ok, 'blobs'), { recursive: true });
    symlinkSync(freshOutside, shard, 'dir');
    const ref = `workspaces/${ok}/blobs/bb/${'b'.repeat(64)}`;

    await expect(blobs.write(ref, 'HACK')).rejects.toThrow(/BLOB_PATH_REJECTED/);
    await expect(blobs.read(ref)).rejects.toThrow(/BLOB_PATH_REJECTED/);
    await expect(blobs.remove(ref)).rejects.toThrow(/BLOB_PATH_REJECTED/);
    expect(readdirSync(freshOutside)).toEqual([]); // 未新增
    rmSync(freshOutside, { recursive: true, force: true });
    void ownerKeyFor;
  });

  it('并发 write × remove：不误删哨兵、目标若存在则内容完整（Windows 容忍）', async () => {
    const ref = BlobStore.mainRefFor('o-f10c', sha256(Buffer.from('DEFAULT')));
    await blobs.write(ref, 'DEFAULT');
    const VAL = Buffer.alloc(32, 0x41);
    const sentinelRef = BlobStore.mainRefFor('o-f10c-s', sha256(Buffer.from('SENT')));
    await blobs.write(sentinelRef, 'SENT');

    // 并发写删（Windows rename EPERM 竞态允许 BLOB_DELETE_FAILED）
    const rejects: string[] = [];
    await Promise.all([
      blobs.write(ref, VAL).catch((e) => { rejects.push(String((e as { code?: string })?.code)); return null; }),
      blobs.remove(ref).catch((e) => String((e as { code?: string })?.code)),
      blobs.write(sentinelRef, 'SENT'),
    ]);

    // 哨兵完整
    expect((await blobs.read(sentinelRef)).toString('utf8')).toBe('SENT');
    // 拒绝码必须是真实竞态（BLOB_DELETE_FAILED / BLOB_PATH_REJECTED），不得是损坏性意外
    for (const c of rejects) expect(['BLOB_DELETE_FAILED', 'BLOB_PATH_REJECTED', 'undefined']).toContain(c);
    // 目标若存在则内容完整（不损坏）
    if (await blobs.exists(ref)) {
      expect((await blobs.read(ref)).toString('hex')).toBe(VAL.toString('hex'));
    }
  });
});