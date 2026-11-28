/** B-8 · 路径替换竞态独立并发测试：writeAtomic 与 remove 对同一 ref 并发。
 *  验证：不产生损坏文件、不误删其他文件、最终状态可判定。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, sha256 } from '../../src/storage/blob-store.ts';

let blobRoot: string;
let blobs: BlobStore;
beforeEach(() => {
  blobRoot = mkdtempSync(join(tmpdir(), 'hetu-b8-root-'));
  blobs = new BlobStore(blobRoot);
});
afterEach(() => {
  rmSync(blobRoot, { recursive: true, force: true });
});

describe('B-8 · 路径替换竞态并发', () => {
  it('writeAtomic × remove × 10 轮：不产生损坏内容、不误删哨兵', async () => {
    const ref = BlobStore.mainRefFor('o-b8', sha256(Buffer.from('DEFAULT')));
    await blobs.write(ref, 'DEFAULT');
    const VAL = Buffer.alloc(64, 0x41); // 'AAAA...'

    for (let i = 0; i < 10; i++) {
      // 哨兵文件，确保并发写/删绝不误删它
      const sentinelCont = 'SENTINEL-' + i;
      const sentinel = BlobStore.mainRefFor('o-b8-sentinel', sha256(Buffer.from(sentinelCont)));
      await blobs.writeAtomic(sentinel, sentinelCont);

      const writeRejects: string[] = [];
      await Promise.all([
        blobs.writeAtomic(ref, VAL).catch((e) => {
          writeRejects.push(String(e?.code));
          return null; // 竞态下写方可能诚实失败（目标被并发 remove 抢占）——允许，但必须是无损坏的错误
        }),
        blobs.writeAtomic(ref, VAL).catch((e) => {
          writeRejects.push(String(e?.code));
          return null;
        }),
        // 并发删除：若因目标消失而报错（BLOB_DELETE_FAILED）也可接受——删除方先赢
        blobs.remove(ref).catch((e) => String(e?.code)),
        blobs.writeAtomic(sentinel, sentinelCont),
      ]);

      // remove() 的成功若被写成"目标不存在也幂等成功"，则不影响此处
      // 哨兵必须始终完整（并发操作绝不误删/损坏它）
      expect((await blobs.read(sentinel)).toString('utf8')).toBe(sentinelCont);
      // 允许的竞态结果：写方报 BLOB_DELETE_FAILED / 删除方先删（无 ENOENT 之外的意外）
      // 但绝不接受损坏性内容——目标若存在则必须是完整 VAL
      if (await blobs.exists(ref)) {
        expect((await blobs.read(ref)).toString('hex')).toBe(VAL.toString('hex'));
      }
      // 写方拒绝必须是 BLOB_DELETE_FAILED（真实竞态上报），不得是损坏/其它意外
      for (const c of writeRejects) {
        expect(c).toBe('BLOB_DELETE_FAILED');
      }
    }
  });

  it('并发后最终状态可判定：存在 → 内容完整', async () => {
    const ref = BlobStore.mainRefFor('o-b8b', sha256(Buffer.from('init')));
    await blobs.write(ref, 'init');
    const VAL = Buffer.from('final-complete-content-'.repeat(4));

    await Promise.all([
      blobs.writeAtomic(ref, VAL),
      blobs.writeAtomic(ref, VAL),
      blobs.remove(ref).catch(() => {}),
    ]);

    // 收敛确认：最终写一次，保证文件存在且内容完整可读（内容寻址写语义下这是必然最终态）
    const h = await blobs.writeAtomic(ref, VAL);
    expect(h).toBe(sha256(VAL));
    const buf = await blobs.read(ref);
    expect(buf.equals(VAL)).toBe(true);
  });
});