/** Migration 运行器：按版本号顺序回放（幂等），支持 up/down 函数形式与目标版本。
 *
 * up/down 可以是 SQL 字符串，也可以是函数（用于旧数据校验与回填 —— 迁移必须能
 * 在发现无法安全转换的历史数据时**明确中止并列出待处理记录**，而不是静默写入）。
 */
import { DatabaseSync } from './sqlite.ts';
import { migration as m001 } from './migrations/001_init.ts';
import { migration as m002 } from './migrations/002_scope_revision.ts';
import { migration as m003 } from './migrations/003_persona_private_edges.ts';
import { migration as m004 } from './migrations/004_purge_blob_marks.ts';
import { migration as m005 } from './migrations/005_blob_objects.ts';
import { preflight } from './preflight.ts';

export type Db = InstanceType<typeof DatabaseSync>;

import type { LegacyScopeEntry } from './migrations/002_scope_revision.ts';
import type { PreflightReport } from './preflight.ts';

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

/**
 * 将 preflight() 的 PreflightReport 映射为旧 dryRun 的 DryRunReport 结构。
 * 保持既有 178 项回归所依赖的字段名/语义不变（R3 兼容）：
 *   mappedCount  = 显式 manifest 条数（旧语义）
 *   unmapped     = 未映射 revision 清单
 *   ambiguous    = superseded 歧义清单
 *   dangling     = superseded 悬空清单
 */
function toDryRunReport(p: PreflightReport, opts: MigrationOptions): DryRunReport {
  return {
    kind: 'DRY_RUN_REPORT',
    isFreshDatabase: p.isFreshDatabase,
    appliedVersions: p.appliedVersions,
    pendingVersions: p.pendingVersions,
    nodeCount: p.nodeCount,
    mappedCount: Object.keys(opts.legacyScopeManifest ?? {}).length,
    unmapped: p.unmappedRevisions,
    legacySupersededPending: p.supersededConvertible.length,
    ambiguous: p.supersededAmbiguous,
    dangling: p.supersededDangling,
    cycles: p.cycles,
    legacyOwnerProvided: !!opts.legacyOwnerId,
    text: p.text,
  };
}

export interface Migration {
  version: number;
  name: string;
  up: string | ((db: Db, opts: MigrationOptions) => void);
  down?: string | ((db: Db) => void);
}

export const MIGRATIONS: Migration[] = [
  m001 as Migration,
  m002 as Migration,
  m003 as Migration,
  m004 as Migration,
  m005 as Migration,
];

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
    return toDryRunReport(preflight(db, opts), opts);
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

/** 回滚到目标版本（不含 target 本身之后的全部回滚，逆序执行 down）。
 *
 *  R4 §9（裁决 6）：回滚会丢弃 blob 清理队列所在结构（005.down 先于 004.down 执行），
 *  因此存在未完成清理任务时必须拒绝回滚并列出任务 —— 由统一的 preflight() 只读判定，
 *  不让 Runner 与 004.down 各自实现一套（避免逻辑漂移）。
 */
export function rollbackTo(db: Db, targetVersion: number): { rolledBack: number[] } {
  ensureMetaTable(db);
  const applied = appliedVersions(db);

  // 只有当本次回滚会触及 004/005（即 target < 5）时，清理队列才可能被丢弃
  const wouldDropCleanupQueue = targetVersion < 5 && applied.has(5);
  if (wouldDropCleanupQueue) {
    const p = preflight(db, {});
    if (p.cleanupTasksIncomplete > 0) {
      const rows = db
        .prepare(
          `SELECT seq, owner_key, blob_ref, status FROM blob_cleanup_tasks
            WHERE status IN ('pending','claimed','failed')
            ORDER BY seq LIMIT 50`
        )
        .all() as { seq: number; owner_key: string; blob_ref: string; status: string }[];
      const lines = rows
        .map(t => `  [${t.status}] ${t.owner_key} ${t.blob_ref} (seq=${t.seq})`)
        .join('\n');
      throw new Error(
        `MIGRATION_ABORTED: 存在 ${p.cleanupTasksIncomplete} 个未完成的 Blob 清理任务，拒绝回滚（target=${targetVersion}）。\n` +
          `未完成任务：\n${lines}\n` +
          `请先运行 reconcileBlobs() 完成物理清理后再重试回滚。`
      );
    }
  }

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
