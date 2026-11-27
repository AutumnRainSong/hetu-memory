/** Blob 存储：主区 + 归档区，真实文件读写 + Hash 校验 + 路径逃逸防护。
 *
 *  R3-02 修复要点（符号链接防护）：
 *  - 不是"操作完成后检查"，而是**写/读/删前**逐级解析父目录，确保每个组件不逃逸 root
 *  - `secureResolve` 在写入前对存在的每个父目录做 realpath，符号链接目标必须在 root 内
 *  - 符号链接一检测到逃逸立即抛错，目标目录不被触碰
 *
 *  R3-01 依赖：新增 `remove` 幂等（purgelist 使用）。
 */
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  realpath,
  access,
  lstat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

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
  private readonly realRootPath: string;

  constructor(private readonly root: string) {
    // 根目录本身的真实路径（避免 root 自身是符号链接）
    this.realRootPath = root;
  }

  /** 词法检查：相对引用不得逃逸（不含符号链接解析） */
  resolve(ref: string): string {
    if (!ref || isAbsolute(ref)) throw new BlobPathError(`BLOB_PATH_REJECTED: 非法引用 ${ref}`);
    const normalized = normalize(ref).replace(/\\/g, '/');
    if (normalized.startsWith('../') || normalized.includes('/../')) {
      throw new BlobPathError(`BLOB_PATH_REJECTED: 引用包含路径穿越 ${ref}`);
    }
    const abs = join(this.root, normalized);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new BlobPathError(`BLOB_PATH_REJECTED: 引用逃逸出 Blob 根目录 ${ref}`);
    }
    return abs;
  }

  /**
   * 安全解析（R3-02）：在**任何文件操作前**调用。
   * 逐级解析目标路径的每个父目录组件，若存在符号链接且其真实目标逃逸出 root 则立即拒绝。
   * 不依赖"操作后再检查"。
   */
  async secureResolve(ref: string): Promise<string> {
    const abs = this.resolve(ref);
    // 从 root 向下逐段解析存在的目录组件
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

  /** 写入内容并返回其 Hash（主区/归档区共用）；写前做符号链接安全解析 */
  async write(ref: string, content: Buffer | string): Promise<string> {
    const abs = await this.secureResolve(ref);
    await mkdir(dirname(abs), { recursive: true });
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await writeFile(abs, buf);
    return sha256(buf);
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

  /** 删除（幂等，忽略不存在）；删前做符号链接安全解析 */
  async remove(ref: string): Promise<void> {
    const abs = await this.secureResolve(ref);
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        // 目标文件本身是符号链接 → 拒绝删除（防止删除外部文件）
        throw new BlobPathError(`BLOB_PATH_REJECTED: 拒绝删除符号链接 ${ref}`);
      }
      await unlink(abs);
    } catch (e) {
      if (e instanceof BlobPathError) throw e;
      /* 其他错误（不存在等）视为已删除 */
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
}