/** Blob 存储：主区 + 归档区，真实文件读写 + Hash 校验 + 路径逃逸防护。
 *
 *  R4-B（P0）BlobStore 安全与工作空间隔离：
 *  - B-1 owner namespace：main/archive 都内容寻址，路径带 sha256 owner-key 摘要（owner_id 绝不原样进路径）
 *  - B-2 目标文件本身是 symlink → write/remove 拒绝，绝不跟随写入/误删
 *  - B-3 父目录 symlink 逐级 lstat + realpath 防护
 *  - B-4 构造时 realpath(root) 落盘为 realRootPath；所有 relative() 判定基于真实路径
 *  - B-5 writeAtomic：临时文件 + rename 原子替换；rename 前再次 secureResolve（缩小 TOCTOU）
 *  - B-6 remove() 仅 ENOENT 幂等；其余（EACCES/EIO/EPERM/…）抛 BlobDeleteError；unlinkIfExists 供清理 worker
 */
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  realpath,
  access,
  lstat,
  rename,
} from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

const BENIGN_RENAME_CODES = new Set(['EPERM', 'EEXIST']);

export class BlobPathError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(msg: string) {
    super(msg);
    this.name = 'BlobPathError';
  }
}

export class BlobMissingError extends Error {
  readonly code = 'ARCHIVE_MISSING';
  constructor(msg: string) {
    super(msg);
    this.name = 'BlobMissingError';
  }
}

export class BlobHashMismatchError extends Error {
  readonly code = 'ARCHIVE_MISSING';
  constructor(msg: string) {
    super(msg);
    this.name = 'BlobHashMismatchError';
  }
}

/** 删除失败：非 ENOENT 的真实错误（权限 / IO / 占用等）。绝不吞掉。 */
export class BlobDeleteError extends Error {
  readonly code = 'BLOB_DELETE_FAILED' as const;
  constructor(
    readonly ref: string,
    readonly cause: unknown
  ) {
    super(`BLOB_DELETE_FAILED: ${ref}`);
    this.name = 'BlobDeleteError';
  }
}

export const sha256 = (buf: Buffer | string): string =>
  'sha256:' + createHash('sha256').update(buf).digest('hex');

/** B-1 owner 命名空间：owner_id 的稳定摘要（sha256 NFC）[0:32]。
 *  owner_id 绝不原样进路径；同 owner 稳定映射，跨 owner 冲突概率可忽略。 */
export const ownerKeyFor = (ownerId: string): string =>
  createHash('sha256').update(ownerId.normalize('NFC')).digest('hex').slice(0, 32);

export class BlobStore {
  private readonly realRootPath: string;

  constructor(private readonly root: string) {
    // B-4：root 真实路径。若不存在则先创建，再 realpath 落盘。
    // 所有 relative()/路径判定基于真实路径，避免 root 自身为符号链接导致的逃逸判定失真。
    mkdirSync(root, { recursive: true });
    this.realRootPath = realpathSync(root);
  }

  /** B-1 主区引用：workspaces/<owner-key>/blobs/<hash[0:2]>/<hex>（内容寻址，跨 Revision 去重） */
  static mainRefFor(ownerId: string, hash: string): string {
    const hex = String(hash).replace(/^sha256:/, '');
    return `workspaces/${ownerKeyFor(ownerId)}/blobs/${hex.slice(0, 2)}/${hex}`;
  }

  /** B-1 归档引用：workspaces/<owner-key>/archive/<hash[0:2]>/<hex>（统一内容寻址） */
  static archiveRefFor(ownerId: string, hash: string): string {
    const hex = String(hash).replace(/^sha256:/, '');
    return `workspaces/${ownerKeyFor(ownerId)}/archive/${hex.slice(0, 2)}/${hex}`;
  }

  /** 词法检查：相对引用不得逃逸（不含符号链接解析）。基于 realRootPath 判定。 */
  resolve(ref: string): string {
    if (!ref || isAbsolute(ref)) throw new BlobPathError(`BLOB_PATH_REJECTED: 非法引用 ${ref}`);
    const normalized = normalize(ref).replace(/\\/g, '/');
    if (normalized.startsWith('../') || normalized.includes('/../')) {
      throw new BlobPathError(`BLOB_PATH_REJECTED: 引用包含路径穿越 ${ref}`);
    }
    const abs = join(this.realRootPath, normalized);
    const rel = relative(this.realRootPath, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new BlobPathError(`BLOB_PATH_REJECTED: 引用逃逸出 Blob 根目录 ${ref}`);
    }
    return abs;
  }

  /**
   * B-3 安全解析：在任何文件操作前调用。
   * 逐级解析目标路径的每个父目录组件：lstat 存在 + realpath，若其真实目标逃逸出 root 立即拒绝；
   * 用真实路径继续解析，防嵌套符号链接。不依赖"操作后再检查"。
   */
  async secureResolve(ref: string): Promise<string> {
    const abs = this.resolve(ref);
    let cursor = this.realRootPath;
    const relParts = normalize(relative(this.realRootPath, abs)).split(sep).filter(Boolean);
    for (const part of relParts.slice(0, -1)) {
      cursor = join(cursor, part);
      try {
        await lstat(cursor);
        const real = await realpath(cursor);
        const relCheck = relative(this.realRootPath, real);
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          throw new BlobPathError(`BLOB_PATH_REJECTED: 目录组件为逃逸符号链接 ${ref} (${cursor})`);
        }
        cursor = real; // 用真实路径继续，防嵌套符号链接
      } catch (e) {
        if (e instanceof BlobPathError) throw e;
        // 目录不存在：继续词法检查（mkdir 会创建）
      }
    }
    return abs;
  }

  /** B-5 原子写：临时文件 + rename 替换。
   *  - tmp 写成功后、rename 前再次 secureResolve（缩小父目录被替换的 TOCTOU 窗口）
   *  - rename 前检查目标：若已存在且为符号链接 → 拒绝（B-2，绝不覆盖外部文件）
   *  - 失败清理 tmp；返回内容 sha256。 */
  async writeAtomic(ref: string, content: Buffer | string): Promise<string> {
    const abs = await this.secureResolve(ref);
    await mkdir(dirname(abs), { recursive: true });
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tmp, buf);
      await this.secureResolve(ref); // rename 前再次校验父目录（缩小 TOCTOU）
      try {
        const st = await lstat(abs);
        if (st.isSymbolicLink()) {
          throw new BlobPathError(`BLOB_PATH_REJECTED: 拒绝覆盖符号链接目标 ${ref}`);
        }
      } catch (e: any) {
        if (e instanceof BlobPathError) throw e;
        if (e?.code !== 'ENOENT') throw e; // 其它 lstat 错误 → 不掩盖
      }
      try {
        await rename(tmp, abs); // 原子替换
      } catch (e: any) {
        if (BENIGN_RENAME_CODES.has(e?.code)) {
          // Windows 对已存在目标 rename 可能 EPERM/EEXIST（并发下尤甚）。
          // 我们刚才已确认目标为普通文件/不存在：并发核对是否已被同内容写入，
          // 若是则吞掉（幂等成功），否则真实上报，避免留下半成品。
          const now = await readFile(abs).catch(() => null);
          if (Buffer.isBuffer(now) && sha256(now) === sha256(buf)) {
            await unlink(tmp).catch(() => {});
            return sha256(buf);
          }
          throw new BlobDeleteError(ref, e);
        }
        throw e;
      }
      return sha256(buf);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** B-5 兼容别名：write = writeAtomic（保留现有调用方语义） */
  async write(ref: string, content: Buffer | string): Promise<string> {
    return this.writeAtomic(ref, content);
  }

  /** 读取内容；不存在抛 BlobMissingError；读前做符号链接安全解析 */
  async read(ref: string): Promise<Buffer> {
    const abs = await this.secureResolve(ref);
    try {
      return await readFile(abs);
    } catch {
      throw new BlobMissingError(`ARCHIVE_MISSING: 归档文件不存在 ${ref}`);
    }
  }

  /** 读取并校验 Hash */
  async readVerified(ref: string, expectedHash: string): Promise<Buffer> {
    const buf = await this.read(ref);
    const actual = sha256(buf);
    if (actual !== expectedHash) {
      throw new BlobHashMismatchError(
        `ARCHIVE_MISSING: Hash 不匹配 ${ref}（期望 ${expectedHash}，实际 ${actual}）`
      );
    }
    return buf;
  }

  async exists(ref: string): Promise<boolean> {
    try {
      await access(await this.secureResolve(ref));
      return true;
    } catch {
      return false;
    }
  }

  /** B-6 remove()：仅 ENOENT 幂等；目标为 symlink → 拒绝；其余错误一律抛 BlobDeleteError。 */
  async remove(ref: string): Promise<void> {
    const abs = await this.secureResolve(ref);
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new BlobPathError(`BLOB_PATH_REJECTED: 拒绝删除符号链接 ${ref}`);
      }
      await unlink(abs);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return; // 幂等
      if (e instanceof BlobPathError) throw e;
      throw new BlobDeleteError(ref, e); // EACCES/EIO/EPERM 等必须真实上报
    }
  }

  /** B-6 unlinkIfExists：供 A 组清理 worker。
   *  - 不存在 → 'absent'；删除成功 → 'removed'；symlink → 拒绝 BlobPathError；其余 → BlobDeleteError */
  async unlinkIfExists(ref: string): Promise<'removed' | 'absent'> {
    const abs = await this.secureResolve(ref);
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new BlobPathError(`BLOB_PATH_REJECTED: 拒绝删除符号链接 ${ref}`);
      }
      await unlink(abs);
      return 'removed';
    } catch (e: any) {
      if (e?.code === 'ENOENT') return 'absent'; // 幂等
      if (e instanceof BlobPathError) throw e;
      throw new BlobDeleteError(ref, e);
    }
  }
}