/**
 * F-14 · preflight-zero-write —— Dry Run 零写入 + 两类边悬空检查。
 *
 * R4 契约 §8/E：preflight() 是**严格只读**函数（不建表、不写库），并报告两类悬空边：
 *   - danglingNodeEdges：普通边（type<>'supersedes'）端点 node_id 悬空；
 *   - danglingRevisionEdges：supersedes 边端点 revision_id 悬空。
 * dryRun 与真实迁移共用同一只读判定，且 **dryRun 零写入**（不建表、不写 schema_migrations）。
 *
 * 前置条件：
 *  - preflight 模块已交付（E 组）。
 *  - 悬空边**必须在 Migration 003 的边端点触发器之外**构造：003 后会 BEFORE INSERT 直接拒绝
 *    悬空边（这正是 F-14 要验证 preflight 能识别的历史数据形态）。因此先只迁移到 001 造数据，
 *    再对同一 DB 跑 preflight。
 * 并发方式：串行；先造脏数据 → 跑 dryRun/preflight → 校验零写入。
 * 预期：
 *  - 报告 kind='PREFLIGHT_REPORT'，danglingNodeEdges 与 danglingRevisionEdges 都非空；
 *  - blocking=true（悬空边即阻断）；
 *  - 零写入：sqlite_master 表/列集合不变、edges 行数不变、schema_migrations 不变；
 *  - 不抛错（只读函数不得因脏数据抛异常）。
 * 失败数据态：dryRun 若建表/写库 → 污染真实库；漏检悬空边 → 真实迁移会在脏数据上继续，
 *    产生不可恢复的悬空引用。
 *
 * 当前：preflight.ts 已交付（E 组），本用例可真实运行（不 skip）。
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  DatabaseSync,
  runMigrations,
  skipReason,
  hasPreflight,
  rollbackTo,
} from './_helpers.ts';

function columnsSnapshot(db: InstanceType<typeof DatabaseSync>): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name")
    .all() as { name: string }[];
  return tables.flatMap(r =>
    (db.prepare(`PRAGMA table_info("${r.name}")`).all() as { name: string }[]).map(c => `${r.name}.${c.name}`)
  );
}

describe('F-14 · preflight-zero-write', () => {
  let db: InstanceType<typeof DatabaseSync>;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    // 只迁移到 001（003 的边端点触发器会拒绝悬空边 → 脏数据须在其之前构造）
    runMigrations(db, { target: 1 });
  });

  it('preflight 报告两类悬空边 + blocking，且严格零写入', async () => {
    if (!hasPreflight) {
      skipReason('F-14', 'preflight 模块未交付，跳过');
      return;
    }

    // 造一条真实节点（让普通边有一端存在、另一端悬空 → 精确命中 node_id 悬空分支）
    db.prepare(
      `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
        content_state, modality, confidence, provenance, valid_from, ingested_at)
       VALUES('real-node','real-rev',1,'sha256:aa','CURRENT','FULL','text',0.7,'{}','2026-01-01','2026-01-01')`
    ).run();

    // ① 普通边：from 存在、to 悬空 → danglingNodeEdges 命中
    db.prepare(
      `INSERT INTO edges(type, link_class, "from", "to", weight, created_at)
       VALUES('link','explicit','real-node','ghost-node',0.5,'2026-01-01T00:00:00Z')`
    ).run();
    // ② supersedes 边：两端 revision 都不存在 → danglingRevisionEdges 命中
    db.prepare(
      `INSERT INTO edges(type, "from", "to", weight, created_at)
       VALUES('supersedes','ghost-rev-a','ghost-rev-b',1,'2026-01-01T00:00:00Z')`
    ).run();

    const preflightMod = (await import('../../src/storage/preflight.ts')) as {
      preflight(
        db: unknown,
        opts: Record<string, unknown>
      ): {
        kind: 'PREFLIGHT_REPORT';
        danglingNodeEdges: unknown[];
        danglingRevisionEdges: unknown[];
        cleanupTasksIncomplete: number;
        blocking: boolean;
        text: string;
      };
    };

    // ── 零写入快照 ──
    const beforeCols = columnsSnapshot(db);
    const beforeEdges = (db.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c;
    const beforeNodes = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c;
    const beforeTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map(r => r.name);

    const report = preflightMod.preflight(db, {});

    // ── 内容断言 ──
    expect(report.kind).toBe('PREFLIGHT_REPORT');
    expect(report.danglingNodeEdges.length).toBeGreaterThan(0);
    expect(report.danglingRevisionEdges.length).toBeGreaterThan(0);
    expect(report.blocking).toBe(true);
    // 文本报告可读且包含关键项（运维可用）
    expect(report.text).toContain('PREFLIGHT_REPORT');
    expect(report.text).toContain('悬空普通边');
    expect(report.text).toContain('悬空 supersedes 边');

    // ── 零写入断言（表/列/行数全部不变）──
    expect(columnsSnapshot(db)).toEqual(beforeCols);
    expect((db.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c).toBe(beforeEdges);
    expect((db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c).toBe(beforeNodes);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
        r => r.name
      )
    ).toEqual(beforeTables);
  });

  it('dryRun 走同一 preflight 且零写入（不建 schema_migrations、不应用迁移）', () => {
    if (!hasPreflight) {
      skipReason('F-14', 'preflight 模块未交付，跳过');
      return;
    }
    const fresh = new DatabaseSync(':memory:');
    const before = (fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      r => r.name
    );
    expect(before).toEqual([]); // 全新空库

    const rep = runMigrations(fresh, { dryRun: true }) as { kind?: string; isFreshDatabase?: boolean };
    // E 组为向后兼容保留 dryRun 的旧外壳 kind='DRY_RUN_REPORT'（内部由 preflight() 产出）；
    // 契约 §8 的 preflight() 本体返回 kind='PREFLIGHT_REPORT'（上一用例已直接断言）。
    expect(['DRY_RUN_REPORT', 'PREFLIGHT_REPORT']).toContain(rep.kind);
    expect(rep.isFreshDatabase).toBe(true);

    // 零写入：空库仍是空库（未建 schema_migrations / 未建 nodes）
    const after = (fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      r => r.name
    );
    expect(after).toEqual([]);
    fresh.close();
    void rollbackTo;
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });
});
