/** Preflight 只读报告（契约 §8，E 组独占）。
 *
 *  严格只读：只 SELECT / PRAGMA（含 sqlite_master 判表），不建表、不写库。
 *  dryRun 与真实迁移共用本函数 —— 消除 dryRun 内联检查与真实迁移前置校验
 *  之间的逻辑漂移（R4-E1/E2）。
 *
 *  R4 新增检测项：
 *   - danglingNodeEdges：普通边（type<>'supersedes'）node_id 端点悬空
 *   - danglingRevisionEdges：supersedes 边 revision_id 端点悬空
 *   - cleanupTasksIncomplete：004 表格 blob_cleanup_tasks 未完成任务数（影响回滚判定）
 */
import type { Db } from './migrate.ts';
import type { MigrationOptions } from './migrate.ts';
import { MIGRATIONS } from './migrate.ts';

export interface PreflightReport {
  kind: 'PREFLIGHT_REPORT';
  isFreshDatabase: boolean;
  appliedVersions: number[];
  pendingVersions: number[];
  nodeCount: number;
  unmappedRevisions: string[];
  supersededConvertible: string[];
  supersededAmbiguous: string[];
  supersededDangling: string[];
  danglingNodeEdges: { type: string; from: string; to: string }[];
  danglingRevisionEdges: { type: string; from: string; to: string }[];
  cleanupTasksIncomplete: number;
  cycles: string[];
  blocking: boolean;
  text: string;
}

function tableExists(db: Db, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    c => c.name
  );
}

/** 严格只读：不建表、不写库。dryRun 与真实迁移共用本函数。 */
export function preflight(db: Db, opts: MigrationOptions = {}): PreflightReport {
  const hasNodesTable = tableExists(db, 'nodes');
  const isFreshDatabase = !hasNodesTable;

  // ── 已应用 / 待应用版本 ──
  const applied: number[] = tableExists(db, 'schema_migrations')
    ? (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        r => r.version
      )
    : [];
  const pending = MIGRATIONS.filter(m => !applied.includes(m.version)).map(m => m.version);

  // ── Scope / 旧 owner 相关 ──
  const revIds = isFreshDatabase
    ? []
    : (db.prepare('SELECT revision_id FROM nodes').all() as { revision_id: string }[]).map(
        r => r.revision_id
      );
  const manifest = opts.legacyScopeManifest ?? {};
  const unmappedRevisions = revIds.filter(id => !(id in manifest));

  // ── 历史 superseded_by（002 迁移前的旧值）分类 ──
  let supersededConvertible: string[] = [];
  let supersededAmbiguous: string[] = [];
  let supersededDangling: string[] = [];
  let cycles: string[] = [];
  if (!isFreshDatabase) {
    const cols = columnNames(db, 'nodes');
    if (cols.includes('superseded_by') && !cols.includes('superseded_by_revision')) {
      const rows = db
        .prepare('SELECT node_id, revision_id, superseded_by FROM nodes WHERE superseded_by IS NOT NULL')
        .all() as { node_id: string; revision_id: string; superseded_by: string }[];
      for (const r of rows) {
        const asRev = db
          .prepare('SELECT 1 FROM nodes WHERE node_id=? AND revision_id=?')
          .get(r.node_id, r.superseded_by);
        if (asRev) {
          supersededConvertible.push(`${r.node_id}/${r.revision_id} -> ${r.superseded_by}`);
          continue;
        }
        const asNode = db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(r.superseded_by);
        if (asNode) supersededAmbiguous.push(`${r.node_id}/${r.revision_id} -> ${r.superseded_by}`);
        else supersededDangling.push(`${r.node_id}/${r.revision_id} -> ${r.superseded_by}`);
      }

      // 历史环检测（与 002 迁移同判定）
      const chainMap = new Map<string, string>();
      const all = db
        .prepare('SELECT revision_id, superseded_by FROM nodes WHERE superseded_by IS NOT NULL')
        .all() as { revision_id: string; superseded_by: string }[];
      for (const r of all) chainMap.set(r.revision_id, r.superseded_by);
      const seenCycles = new Set<string>();
      for (const start of chainMap.keys()) {
        const visit = new Set<string>();
        let cur: string | undefined = start;
        while (cur && chainMap.has(cur)) {
          if (visit.has(cur)) {
            seenCycles.add([...visit, cur].join(' -> '));
            break;
          }
          visit.add(cur);
          cur = chainMap.get(cur);
        }
      }
      cycles = [...seenCycles];
    }
  }

  // ── 普通边悬空（node_id 端点）—— 仅当 edges 与 nodes 两表都存在时计算 ──
  let danglingNodeEdges: { type: string; from: string; to: string }[] = [];
  let danglingRevisionEdges: { type: string; from: string; to: string }[] = [];
  if (tableExists(db, 'edges') && hasNodesTable) {
    danglingNodeEdges = db
      .prepare(
        `SELECT type, "from", "to" FROM edges
          WHERE type <> 'supersedes'
            AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."from")
              OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."to"))`
      )
      .all() as { type: string; from: string; to: string }[];
    danglingRevisionEdges = db
      .prepare(
        `SELECT type, "from", "to" FROM edges
          WHERE type = 'supersedes'
            AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."from")
              OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."to"))`
      )
      .all() as { type: string; from: string; to: string }[];
  }

  // ── 004 清理任务未完成数（005 表存在才查）──
  let cleanupTasksIncomplete = 0;
  if (tableExists(db, 'blob_cleanup_tasks')) {
    cleanupTasksIncomplete = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM blob_cleanup_tasks
            WHERE status IN ('pending','claimed','failed')`
        )
        .get() as { c: number }
    ).c;
  }

  const nodeCount = revIds.length;

  // ── blocking 判定（契约 §8）──
  const blocking =
    (unmappedRevisions.length > 0 && !opts.acceptDefaultScopeMapping) ||
    supersededAmbiguous.length > 0 ||
    supersededDangling.length > 0 ||
    cycles.length > 0 ||
    danglingNodeEdges.length > 0 ||
    danglingRevisionEdges.length > 0 ||
    (nodeCount > 0 && !opts.legacyOwnerId);

  const text = [
    'PREFLIGHT_REPORT（只读检查，未执行任何数据库写操作）',
    `数据库状态：${isFreshDatabase ? '全新空库（尚无 nodes 表）' : '已有结构'}`,
    `已应用迁移：${applied.length ? applied.join(', ') : '无'}`,
    `待应用迁移：${pending.length ? pending.join(', ') : '无'}`,
    `记忆记录数：${nodeCount}`,
    `显式映射条数：${Object.keys(manifest).length}`,
    `未映射条数：${unmappedRevisions.length}${unmappedRevisions.length && !opts.acceptDefaultScopeMapping ? '（需 legacyScopeManifest 或 acceptDefaultScopeMapping）' : ''}`,
    `superseded_by 待转换：${supersededConvertible.length}（歧义 ${supersededAmbiguous.length} / 悬空 ${supersededDangling.length}）`,
    `悬空普通边：${danglingNodeEdges.length}`,
    `悬空 supersedes 边：${danglingRevisionEdges.length}`,
    `未完成 blob 清理任务：${cleanupTasksIncomplete}`,
    `历史环：${cycles.length}`,
    `旧 owner 提供：${opts.legacyOwnerId ? '是' : '否'}`,
    `阻断（blocking）：${blocking ? '是' : '否'}`,
    danglingNodeEdges.length
      ? `悬空普通边清单：\n  ${danglingNodeEdges.slice(0, 20).map(e => `${e.type}: ${e.from} -> ${e.to}`).join('\n  ')}`
      : '',
    danglingRevisionEdges.length
      ? `悬空 supersedes 边清单：\n  ${danglingRevisionEdges.slice(0, 20).map(e => `${e.type}: ${e.from} -> ${e.to}`).join('\n  ')}`
      : '',
    unmappedRevisions.length ? `待映射记录：\n  ${unmappedRevisions.slice(0, 20).join('\n  ')}` : '',
    '如需执行，请在不设置 dryRun 的情况下重新调用。',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    kind: 'PREFLIGHT_REPORT',
    isFreshDatabase,
    appliedVersions: applied,
    pendingVersions: pending,
    nodeCount,
    unmappedRevisions,
    supersededConvertible,
    supersededAmbiguous,
    supersededDangling,
    danglingNodeEdges,
    danglingRevisionEdges,
    cleanupTasksIncomplete,
    cycles,
    blocking,
    text,
  };
}