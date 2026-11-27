/** Migration 运行器：按版本号顺序回放（幂等），支持 up/down 函数形式与目标版本。
 *
 * up/down 可以是 SQL 字符串，也可以是函数（用于旧数据校验与回填 —— 迁移必须能
 * 在发现无法安全转换的历史数据时**明确中止并列出待处理记录**，而不是静默写入）。
 */
import { DatabaseSync } from './sqlite.ts';
import { migration as m001 } from './migrations/001_init.ts';
import { migration as m002 } from './migrations/002_scope_revision.ts';
import { migration as m003 } from './migrations/003_persona_private_edges.ts';

export type Db = InstanceType<typeof DatabaseSync>;

import type { LegacyScopeEntry } from './migrations/002_scope_revision.ts';

export interface MigrationOptions {
  /** 旧数据回填 owner。未提供且存在旧数据时，迁移将中止并要求显式指定。 */
  legacyOwnerId?: string;
  /** 旧数据 Scope 显式映射（键 = revision_id） */
  legacyScopeManifest?: Record<string, LegacyScopeEntry>;
  /** 显式同意全部旧记录归入 project/default-project */
  acceptDefaultScopeMapping?: boolean;
  /** 只报告不写库（由 Runner 最外层拦截，任何情况下零写入） */
  dryRun?: boolean;
  /** 只升级到指定版本（测试用） */
  target?: number;
}

export interface DryRunReport {
  readonly kind: 'DRY_RUN_REPORT';
  readonly isFreshDatabase: boolean;
  readonly appliedVersions: number[];
  readonly pendingVersions: number[];
  readonly nodeCount: number;
  readonly mappedCount: number;
  readonly unmapped: string[];
  readonly legacySupersededPending: number;
  readonly ambiguous: string[];
  readonly dangling: string[];
  readonly cycles: string[];
  readonly legacyOwnerProvided: boolean;
  readonly text: string;
}

/** 统计迁移前状态（不触碰数据库结构） */
function inspectBeforeMigrate(db: Db, opts: MigrationOptions): DryRunReport {
  const hasNodesTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
    .get();
  const isFreshDatabase = !hasNodesTable;

  const applied: number[] = (() => {
    const hasMeta = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (!hasMeta) return [];
    return (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      r => r.version
    );
  })();

  const pending = MIGRATIONS.filter(m => !applied.includes(m.version)).map(m => m.version);

  const revIds = isFreshDatabase
    ? []
    : (db.prepare('SELECT revision_id FROM nodes').all() as { revision_id: string }[]).map(
        r => r.revision_id
      );
  const manifest = opts.legacyScopeManifest ?? {};
  const unmapped = revIds.filter(id => !(id in manifest));

  // 历史 superseded_by 待转换统计（仅当 002 的列尚不存在时）
  let pendingSuperseded: string[] = [];
  let ambiguous: string[] = [];
  let dangling: string[] = [];
  if (!isFreshDatabase) {
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(c => c.name);
    if (cols.includes('superseded_by') && !cols.includes('superseded_by_revision')) {
      const rows = db
        .prepare('SELECT node_id, revision_id, superseded_by FROM nodes WHERE superseded_by IS NOT NULL')
        .all() as { node_id: string; revision_id: string; superseded_by: string }[];
      for (const r of rows) {
        const asRev = db
          .prepare('SELECT 1 FROM nodes WHERE node_id=? AND revision_id=?')
          .get(r.node_id, r.superseded_by);
        if (asRev) {
          pendingSuperseded.push(`${r.node_id}/${r.revision_id} -> ${r.superseded_by}`);
          continue;
        }
        const asNode = db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(r.superseded_by);
        if (asNode) ambiguous.push(`${r.node_id}/${r.revision_id} -> ${r.superseded_by}`);
        else dangling.push(`${r.node_id}/${r.revision_id} -> ${r.superseded_by}`);
      }
    }
  }

  const text = [
    'DRY_RUN_REPORT（未执行任何数据库写操作）',
    `数据库状态：${isFreshDatabase ? '全新空库（尚无 nodes 表）' : '已有结构'}`,
    `已应用迁移：${applied.length ? applied.join(', ') : '无'}`,
    `待应用迁移：${pending.length ? pending.join(', ') : '无'}`,
    `记忆记录数：${revIds.length}`,
    `显式映射条数：${Object.keys(manifest).length}`,
    `未映射条数：${unmapped.length}${unmapped.length && !opts.acceptDefaultScopeMapping ? '（需 legacyScopeManifest 或 acceptDefaultScopeMapping）' : ''}`,
    `superseded_by 待转换：${pendingSuperseded.length}（歧义 ${ambiguous.length} / 悬空 ${dangling.length}）`,
    `旧 owner 提供：${opts.legacyOwnerId ? '是' : '否'}`,
    unmapped.length ? `待映射记录：\n  ${unmapped.slice(0, 20).join('\n  ')}` : '',
    '如需执行，请在不设置 dryRun 的情况下重新调用。',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    kind: 'DRY_RUN_REPORT',
    isFreshDatabase,
    appliedVersions: applied,
    pendingVersions: pending,
    nodeCount: revIds.length,
    mappedCount: Object.keys(manifest).length,
    unmapped,
    legacySupersededPending: pendingSuperseded.length,
    ambiguous,
    dangling,
    cycles: [],
    legacyOwnerProvided: !!opts.legacyOwnerId,
    text,
  };
}

export interface Migration {
  version: number;
  name: string;
  up: string | ((db: Db, opts: MigrationOptions) => void);
  down?: string | ((db: Db) => void);
}

export const MIGRATIONS: Migration[] = [m001 as Migration, m002 as Migration, m003 as Migration];

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
  opts: MigrationOptions = {}
): { applied: number[] } | DryRunReport {
  // ── P1-D：dryRun 必须在 Runner 最外层拦截，早于 schema_migrations 创建与任何 Migration ──
  if (opts.dryRun) {
    return inspectBeforeMigrate(db, opts);
  }

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
  const dryRun = process.argv.includes('--dry-run');
  const result = runMigrations(db, {
    legacyOwnerId: process.env.HETU_LEGACY_OWNER,
    dryRun,
  });
  if ('kind' in result && result.kind === 'DRY_RUN_REPORT') {
    console.log(result.text);
  } else {
    const applied = (result as { applied: number[] }).applied;
    console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'already up to date');
  }
}
