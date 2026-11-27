/** Blob 存储：主区 + 归档区，真实文件读写 + Hash 校验 + 路径逃逸防护。
 *
 *  R2 P0-C 修复要点：
 *  - Minimize 必须真正把内容写入归档文件（而不是要求调用方预先写好）
 *  - Revive 必须真正读回归档内容、校验 Hash、恢复到主区
 *  - 所有路径必须限制在 root 内（拒绝 ../ 与符号链接逃逸）
 */
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  realpath,
  access,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

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

export const sha256 = (buf: Buffer | string): string =>
  'sha256:' + createHash('sha256').update(buf).digest('hex');

export class BlobStore {
  constructor(private readonly root: string) {}

  /** 把相对引用解析为绝对路径，并保证不逃逸出 root */
  resolve(ref: string): string {
    if (!ref || isAbsolute(ref)) throw new BlobPathError(`BLOB_PATH_REJECTED: 非法引用 ${ref}`);
    const normalized = normalize(ref).replace(/\\/g, '/');
    if (normalized.startsWith('../') || normalized.includes('/../')) {
      throw new BlobPathError(`BLOB_PATH_REJECTED: 引用包含路径穿越 ${ref}`);
    }
    const abs = join(this.root, normalized);
    // 静态检查：abs 必须位于 root 之下
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new BlobPathError(`BLOB_PATH_REJECTED: 引用逃逸出 Blob 根目录 ${ref}`);
    }
    return abs;
  }

  /** 写入内容并返回其 Hash（主区/归档区共用） */
  async write(ref: string, content: Buffer | string): Promise<string> {
    const abs = this.resolve(ref);
    await mkdir(dirname(abs), { recursive: true });
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await writeFile(abs, buf);
    return sha256(buf);
  }

  /** 读取内容；不存在抛 BlobMissingError */
  async read(ref: string): Promise<Buffer> {
    const abs = this.resolve(ref);
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
      await access(this.resolve(ref));
      return true;
    } catch {
      return false;
    }
  }

  /** 删除（忽略不存在） */
  async remove(ref: string): Promise<void> {
    try {
      await unlink(this.resolve(ref));
    } catch {
      /* 不存在视为已删除 */
    }
  }

  /** 主区引用：blobs/<hash前缀>/<hex> */
  static mainRefFor(hash: string): string {
    const hex = hash.replace(/^sha256:/, '');
    return `blobs/${hex.slice(0, 2)}/${hex}`;
  }

  /** 归档引用：archive/<node_id>/<revision_id>.txt
   *  安全化：只保留字母数字下划线横线；点号一律替换，避免 `..` 形成路径段 */
  static archiveRefFor(nodeId: string, revisionId: string): string {
    const safe = (s: string) =>
      s.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
    return `archive/${safe(nodeId)}/${safe(revisionId)}.txt`;
  }

  /** 校验一个路径真实解析后仍在 root 内（防符号链接逃逸） */
  async assertInsideRoot(ref: string): Promise<void> {
    const abs = this.resolve(ref);
    try {
      const real = await realpath(abs);
      const realRoot = await realpath(this.root);
      const rel = relative(realRoot, real);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new BlobPathError(`BLOB_PATH_REJECTED: 符号链接逃逸 ${ref}`);
      }
    } catch (e) {
      if (e instanceof BlobPathError) throw e;
      // 文件不存在时只需静态检查（已在 resolve 完成）
    }
  }
}
