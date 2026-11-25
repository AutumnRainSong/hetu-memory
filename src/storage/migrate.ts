/** Migration 运行器：按版本号顺序回放（幂等），支持 up/down 函数形式与目标版本。
 *
 * up/down 可以是 SQL 字符串，也可以是函数（用于旧数据校验与回填 —— 迁移必须能
 * 在发现无法安全转换的历史数据时**明确中止并列出待处理记录**，而不是静默写入）。
 */
import { DatabaseSync } from './sqlite.ts';
import { migration as m001 } from './migrations/001_init.ts';
import { migration as m002 } from './migrations/002_scope_revision.ts';

export type Db = InstanceType<typeof DatabaseSync>;

export interface MigrationOptions {
  /** 旧数据回填 owner。未提供且存在旧数据时，迁移将中止并要求显式指定。 */
  legacyOwnerId?: string;
}

export interface Migration {
  version: number;
  name: string;
  up: string | ((db: Db, opts: MigrationOptions) => void);
  down?: string | ((db: Db) => void);
}

export const MIGRATIONS: Migration[] = [m001 as Migration, m002 as Migration];

function ensureMetaTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
}

function appliedVersions(db: Db): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map(r => r.version));
}

/** 运行未应用的 migration；target 用于测试（只升级到指定版本）。 */
export function runMigrations(
  db: Db,
  opts: MigrationOptions & { target?: number } = {}
): { applied: number[] } {
  ensureMetaTable(db);
  const applied = appliedVersions(db);
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    if (opts.target !== undefined && m.version > opts.target) break;
    db.exec('BEGIN');
    try {
      if (typeof m.up === 'function') m.up(db, opts);
      else db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(m.version, m.name);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    ran.push(m.version);
  }
  return { applied: ran };
}

/** 回滚到目标版本（不含 target 本身之后的全部回滚，逆序执行 down）。 */
export function rollbackTo(db: Db, targetVersion: number): { rolledBack: number[] } {
  ensureMetaTable(db);
  const applied = appliedVersions(db);
  const rolled: number[] = [];
  const toRollback = MIGRATIONS
    .filter(m => m.version > targetVersion && applied.has(m.version))
    .sort((a, b) => b.version - a.version);
  for (const m of toRollback) {
    if (!m.down) throw new Error(`migration ${m.version} (${m.name}) has no down script`);
    db.exec('BEGIN');
    try {
      if (typeof m.down === 'function') m.down(db);
      else db.exec(m.down);
      db.prepare('DELETE FROM schema_migrations WHERE version=?').run(m.version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    rolled.push(m.version);
  }
  return { rolledBack: rolled };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.HETU_DB ?? 'hetu.db');
  const { applied } = runMigrations(db, { legacyOwnerId: process.env.HETU_LEGACY_OWNER });
  console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'already up to date');
}
