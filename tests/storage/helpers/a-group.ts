/** A 组测试辅助（契约 §1.1 路径约定）。
 *
 *  ownerKey 在真实实现中由 B 组 `ownerKeyFor(ownerId)` 生成（sha256 前 32 位）；
 *  测试里直接使用可读字符串，路径模板完全按契约拼接：
 *    main    = workspaces/<ownerKey>/blobs/<hash[0:2]>/<hash>
 *    archive = workspaces/<ownerKey>/archive/<hash[0:2]>/<hash>
 */
import { DatabaseSync } from '../../../src/storage/sqlite.ts';
import { runMigrations } from '../../../src/storage/migrate.ts';
import { migration as m005 } from '../../../src/storage/migrations/005_blob_objects.ts';
import { BlobStore, ownerKeyFor } from '../../../src/storage/blob-store.ts';

export type Db = InstanceType<typeof DatabaseSync>;

export function createDb(): Db {
  const db = new DatabaseSync(':memory:');
  runMigrations(db); // 001-005（E 组已把 005 注册进 MIGRATIONS）
  db.exec(m005.up as string); // 幂等（IF NOT EXISTS）——容忍 005 尚未注册的场景
  return db;
}

export const hashOf = (seed: string): string => seed.repeat(64).slice(0, 64);

/** 与 B 组实现同源的 ref 生成（契约 §1.1 路径模板）。
 *  这里按模板直接拼接 owner_key，便于用任意 ownerKey 字符串布景；
 *  真实调用方应使用 BlobStore.mainRefFor(ownerId, hash)。 */
export const mainRefFor = (ownerKey: string, hash: string): string =>
  `workspaces/${ownerKey}/blobs/${hash.slice(0, 2)}/${hash}`;

export const archiveRefFor = (ownerKey: string, hash: string): string =>
  `workspaces/${ownerKey}/archive/${hash.slice(0, 2)}/${hash}`;

/** 一致性自检：模板拼接 == B 组 BlobStore 生成器（ownerKey = ownerKeyFor(ownerId)） */
export const refsMatchBlobStore = (ownerId: string, hashHex: string): boolean => {
  const ok = ownerKeyFor(ownerId);
  return (
    mainRefFor(ok, hashHex) === BlobStore.mainRefFor(ownerId, hashHex) &&
    archiveRefFor(ok, hashHex) === BlobStore.archiveRefFor(ownerId, hashHex)
  );
};

/** 登记对象 + 引用（等价 registerBlobRef 的 SQL 路径，供测试快速布景） */
export function seedBlobRef(
  db: Db,
  o: {
    ownerKey: string;
    blobRef: string;
    kind: 'main' | 'archive';
    contentHash: string;
    nodeId: string;
    revisionId: string;
  }
): void {
  db.prepare(
    `INSERT INTO blob_objects(owner_key, blob_ref, kind, state, content_hash)
     VALUES(?,?,?,'ACTIVE',?)
     ON CONFLICT(owner_key, blob_ref) DO UPDATE SET state='ACTIVE'`
  ).run(o.ownerKey, o.blobRef, o.kind, o.contentHash);
  db.prepare(
    `INSERT OR IGNORE INTO blob_refs(owner_key, blob_ref, node_id, revision_id, kind)
     VALUES(?,?,?,?,?)`
  ).run(o.ownerKey, o.blobRef, o.nodeId, o.revisionId, o.kind);
}

export const stateOf = (db: Db, ownerKey: string, blobRef: string): string | undefined => {
  const r = db
    .prepare('SELECT state FROM blob_objects WHERE owner_key=? AND blob_ref=?')
    .get(ownerKey, blobRef) as { state: string } | undefined;
  return r?.state;
};

export const taskSeqFor = (db: Db, ownerKey: string, blobRef: string): number | undefined => {
  const r = db
    .prepare(
      'SELECT seq FROM blob_cleanup_tasks WHERE owner_key=? AND blob_ref=? ORDER BY seq DESC LIMIT 1'
    )
    .get(ownerKey, blobRef) as { seq: number } | undefined;
  return r?.seq;
};
