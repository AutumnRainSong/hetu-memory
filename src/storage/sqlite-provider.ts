/** SqliteStorageProvider v2（Review R2）
 *
 *  核心变化（相对 R1）：
 *  - **每个读写方法都强制 AuthContext**；无授权即抛 AuthRequiredError（失败关闭）
 *  - `get` / `query` 共用 `isVisible()` 规则（层可见性 + visibility + shared_list + sensitivity）
 *  - **Sensitivity 硬过滤在 SQL 层完成**（JOIN sensitivity_overlay），不在内存后置过滤
 *  - `query` 与 `get` 都执行 `shared_list` 白名单检查
 *  - 写操作按能力位校验；owner/agent 必须与 auth 一致
 *  - Purge 记录真实操作者（不再硬编码 'provider'）
 *  - Minimize / Revive 走真实 Blob 读写（BlobStore）+ 路径逃逸防护
 *  - reconcile 清理节点 / 两类边 / sensitivity_overlay / Outbox 残留
 */
import { DatabaseSync } from './sqlite.ts';
import { BlobStore, sha256 } from './blob-store.ts';
import {
  type MemoryNode,
  type Edge,
  type OutboxEntry,
  type NodeId,
  type RevisionId,
  type ContentHash,
  type TxResult,
  type Scope,
  type Provenance,
  asNodeId,
  asRevisionId,
  asContentHash,
  nodeIdStr,
  revisionIdStr,
} from './types.ts';
import {
  type AuthContext,
  type Sensitivity,
  SENSITIVITY_LEVEL,
  assertValidAuth,
  ForbiddenError,
  hasCap,
  isVisible,
  withinSensitivity,
} from '../auth/context.ts';
import type { StorageTx, NodeRef, Cas, Hit, BlobHandle, Subgraph, TraverseBudget } from './spi.ts';

export interface ProviderOptions {
  dbPath?: string;
  blobRoot?: string;
  busyTimeoutMs?: number;
}

interface NodeRow {
  node_id: string;
  revision_id: string;
  revision_sequence: number;
  content_hash: string;
  version_state: 'CURRENT' | 'SUPERSEDED';
  content_state: 'FULL' | 'MINIMIZED' | 'STUB' | 'TOMBSTONE';
  content_ref: string | null;
  stub_summary: string | null;
  minimized_blob_ref: string | null;
  minimized_blob_hash: string | null;
  modality: string;
  confidence: number;
  provenance: string;
  valid_from: string;
  valid_until: string | null;
  ingested_at: string;
  superseded_by: string | null;
  superseded_by_revision: string | null;
  owner_id: string;
  layer: string;
  project_id: string | null;
  agent_id: string | null;
  visibility: string;
  shared_with: string;
  sensitivity_value?: string | null;
}

const UNIMPLEMENTED = (what: string) =>
  Promise.reject(new Error(`UNIMPLEMENTED: ${what} — 属 M4 范围`));

export class SqliteStorageProvider implements StorageTx {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly blobs?: BlobStore;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: ProviderOptions = {}) {
    this.db = new DatabaseSync(opts.dbPath ?? ':memory:');
    this.blobs = opts.blobRoot ? new BlobStore(opts.blobRoot) : undefined;
    if (opts.dbPath && opts.dbPath !== ':memory:') {
      this.db.exec(`PRAGMA journal_mode=WAL;`);
      this.db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5000};`);
    }
    this.db.exec('PRAGMA foreign_keys=ON;');
  }

  private async withTx<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  // ───────────────────────── 读（全部强制授权） ─────────────────────────

  async get(
    ref: NodeRef,
    auth: AuthContext,
    opts: { includeArchived?: boolean } = {}
  ): Promise<MemoryNode | null> {
    const a = assertValidAuth(auth);
    const row = this.loadRow(ref);
    if (!row) return null;
    const node = this.rowToNode(row);
    if (!isVisible(a, this.scopeViewOf(node), node.sensitivity)) return null;
    if (!opts.includeArchived && node.content_state === 'TOMBSTONE') return null;
    return node;
  }

  /** 内部无授权读取（仅供 reconcile / 迁移 / 测试断言；不对外暴露） */
  async unsafeInternalGet(
    ref: NodeRef,
    opts: { includeArchived?: boolean } = {}
  ): Promise<MemoryNode | null> {
    const row = this.loadRow(ref);
    if (!row) return null;
    const node = this.rowToNode(row);
    if (!opts.includeArchived && node.content_state === 'TOMBSTONE') return null;
    return node;
  }

  async query(
    q: { text?: string; scope?: Partial<Scope> },
    auth: AuthContext
  ): Promise<Hit[]> {
    const a = assertValidAuth(auth);

    // 权限 + 敏感级在 SQL 层前置过滤（P0-A5）
    const where: string[] = [
      "n.version_state='CURRENT'",
      "n.content_state IN ('FULL','MINIMIZED','STUB')",
      'n.owner_id = ?',
    ];
    const params: (string | number)[] = [a.ownerId];

    // 敏感级上限：JOIN 覆盖层，超出即不进入候选
    where.push(
      `(CASE COALESCE(so.value,'normal')
              WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 ELSE 2 END) <= ?`
    );
    params.push(SENSITIVITY_LEVEL[a.maxSensitivity]);

    // 层可见性 + visibility（与 isVisible 同构，落成 SQL）
    const layerCond = [
      `(n.layer='user_identity')`,
      `(n.layer='project' AND n.project_id IN (${a.projectIds.length ? a.projectIds.map(() => '?').join(',') : "''"}))`,
      `(n.layer='global' AND ${a.canReadGlobal ? '1' : '0'} = 1)`,
      `(n.layer IN ('agent_persona','private_annotation') AND n.agent_id = ?)`,
    ].join(' OR ');
    where.push(`(${layerCond})`);
    params.push(...a.projectIds, a.agentId);

    // visibility 规则（shared_list 必须命中当前 Agent）
    where.push(
      `(n.visibility IN ('owner','project_agents','all_agents')
        OR (n.visibility='shared_list' AND EXISTS (
              SELECT 1 FROM json_each(CASE WHEN json_valid(n.shared_with) THEN n.shared_with ELSE '[]' END) je
              WHERE je.value = ?)))`
    );
    params.push(a.agentId);

    const sc = q.scope ?? {};
    if (sc.layer) {
      where.push('n.layer = ?');
      params.push(sc.layer);
    }
    if (sc.project_id) {
      if (!a.projectIds.includes(sc.project_id)) return [];
      where.push('n.project_id = ?');
      params.push(sc.project_id);
    }
    if (sc.agent_id) {
      if (sc.agent_id !== a.agentId) return [];
      where.push('n.agent_id = ?');
      params.push(sc.agent_id);
    }

    if (q.text && q.text.trim()) {
      const terms = q.text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
      for (const t of terms) {
        where.push('(n.stub_summary LIKE ? OR n.content_ref LIKE ?)');
        params.push(`%${t}%`, `%${t}%`);
      }
    }

    const sql = `SELECT n.*, so.value AS sensitivity_value
                 FROM nodes n
                 LEFT JOIN sensitivity_overlay so ON so.node_id = n.node_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY n.revision_sequence DESC LIMIT 100`;
    const rows = this.db.prepare(sql).all(...params) as unknown as NodeRow[];

    return rows
      .map(r => this.rowToNode(r))
      .filter(n => isVisible(a, this.scopeViewOf(n), n.sensitivity)) // 兜底二次校验（防御 SQL 与 TS 规则漂移）
      .map(n => ({
        node_id: n.node_id,
        revision_id: n.revision_id,
        score: 1.0,
        scope: n.scope,
      }));
  }

  async graphTraverse(_f: NodeRef, _b: TraverseBudget, _a: AuthContext): Promise<Subgraph> {
    return UNIMPLEMENTED('graphTraverse（图谱扩散）');
  }

  async vectorSearch(_v: Float32Array, _n: number, _a: AuthContext): Promise<Hit[]> {
    return UNIMPLEMENTED('vectorSearch（HNSW 向量检索）');
  }

  async blobRef(hash: ContentHash): Promise<BlobHandle> {
    return { ref: BlobStore.mainRefFor(String(hash)), hash, inArchive: false };
  }

  // ───────────────────────── 写（能力位 + 归属校验） ─────────────────────────

  async put(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    auth: AuthContext,
    cas?: Cas
  ): Promise<TxResult> {
    return this.putWithRevision(node, edges, outbox, auth, cas);
  }

  async putWithRevision(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    auth: AuthContext,
    cas?: Cas
  ): Promise<TxResult> {
    try {
      const a = assertValidAuth(auth);
      if (!hasCap(a, 'memory:write')) throw new ForbiddenError('PERMISSION_DENIED: 缺少 memory:write 能力');
      // owner/agent 必须与授权身份一致（不能替别的 Agent 写）
      if (node.scope.owner_id !== a.ownerId) {
        throw new ForbiddenError('PERMISSION_DENIED: 不能写入其他工作空间的记忆');
      }
      if (
        (node.scope.layer === 'agent_persona' || node.scope.layer === 'private_annotation') &&
        node.scope.agent_id !== a.agentId
      ) {
        throw new ForbiddenError('PERMISSION_DENIED: 不能写入其他 Agent 的人格/私有注解');
      }
      if (
        node.scope.layer === 'project' &&
        (node.scope.project_id === null || !a.projectIds.includes(node.scope.project_id))
      ) {
        throw new ForbiddenError('PERMISSION_DENIED: 不是该项目成员，不能写入');
      }
      if (!withinSensitivity(a, node.sensitivity)) {
        throw new ForbiddenError('PERMISSION_DENIED: 超出可写敏感级上限');
      }
      if (cas && !hasCap(a, 'memory:supersede')) {
        throw new ForbiddenError('PERMISSION_DENIED: 缺少 memory:supersede 能力');
      }

      return await this.withTx<TxResult>(() => {
        if (cas) {
          const tail = this.db
            .prepare("SELECT revision_id FROM nodes WHERE node_id=? AND version_state='CURRENT'")
            .get(nodeIdStr(node.node_id)) as { revision_id: string } | undefined;
          if (!tail || tail.revision_id !== revisionIdStr(cas.expectedRevision)) {
            return {
              ok: false,
              error: 'CAS_CONFLICT',
              currentRevision: tail ? asRevisionId(tail.revision_id) : undefined,
            };
          }
          this.insertNode({ ...node, version_state: 'SUPERSEDED' });
          this.db
            .prepare(
              `UPDATE nodes SET version_state='SUPERSEDED', superseded_by_revision=? WHERE revision_id=?`
            )
            .run(revisionIdStr(node.revision_id), tail.revision_id);
          this.db
            .prepare(`UPDATE nodes SET version_state='CURRENT' WHERE revision_id=?`)
            .run(revisionIdStr(node.revision_id));
        } else {
          this.insertNode(node);
        }
        for (const e of edges) this.insertEdge(e);
        for (const o of outbox) this.insertOutbox(o);
        return { ok: true, revision_id: node.revision_id };
      });
    } catch (e) {
      return this.asTxError(e);
    }
  }

  /** 精简：真实写入归档文件 → 校验 → 再改状态 */
  async minimize(nodeId: NodeId, auth: AuthContext, cas: Cas): Promise<TxResult> {
    try {
      const a = assertValidAuth(auth);
      if (!hasCap(a, 'memory:minimize')) throw new ForbiddenError('PERMISSION_DENIED: 缺少 memory:minimize 能力');
      if (!this.blobs) return { ok: false, error: 'ARCHIVE_MISSING' };

      const row = this.db
        .prepare("SELECT * FROM nodes WHERE node_id=? AND version_state='CURRENT'")
        .get(nodeIdStr(nodeId)) as NodeRow | undefined;
      if (!row) return { ok: false, error: 'INVALID_STATE' };
      const node = this.rowToNode(row);
      if (!isVisible(a, this.scopeViewOf(node), node.sensitivity)) {
        return { ok: false, error: 'PERMISSION_DENIED' };
      }
      if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
        return { ok: false, error: 'CAS_CONFLICT', currentRevision: asRevisionId(row.revision_id) };
      }
      if (row.content_state !== 'FULL' || !row.content_ref) {
        return { ok: false, error: 'INVALID_STATE' };
      }

      // ① 读取主区原始内容
      let original: Buffer;
      try {
        original = await this.blobs.read(row.content_ref);
      } catch {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }
      // ② 校验主区内容与记录一致
      if (sha256(original) !== row.content_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }
      // ③ 写入归档区
      const archiveRef = BlobStore.archiveRefFor(row.node_id, row.revision_id);
      const archiveHash = await this.blobs.write(archiveRef, original);
      // ④ 校验归档文件真实存在且 Hash 一致（路径逃逸检查 + 真实读取）
      await this.blobs.assertInsideRoot(archiveRef);
      await this.blobs.readVerified(archiveRef, archiveHash);

      // ⑤ 归档确认后才改状态；主区原始 Blob 保留（由 M2 的 GC 策略处理）
      return await this.withTx<TxResult>(() => {
        this.db
          .prepare(
            `UPDATE nodes SET content_state='MINIMIZED',
               stub_summary=COALESCE(stub_summary, ?),
               minimized_blob_ref=?, minimized_blob_hash=?
             WHERE revision_id=?`
          )
          .run(
            `精简：${String(row.content_hash).slice(0, 24)}`,
            archiveRef,
            archiveHash,
            row.revision_id
          );
        return { ok: true, revision_id: asRevisionId(row.revision_id) };
      });
    } catch (e) {
      return this.asTxError(e);
    }
  }

  /** 恢复：真实读取归档 → 校验 → 恢复主区 → 才改状态 */
  async revive(revisionId: RevisionId, auth: AuthContext, cas: Cas): Promise<TxResult> {
    try {
      const a = assertValidAuth(auth);
      if (!hasCap(a, 'memory:revive')) throw new ForbiddenError('PERMISSION_DENIED: 缺少 memory:revive 能力');
      if (!this.blobs) return { ok: false, error: 'ARCHIVE_MISSING' };

      const row = this.db
        .prepare('SELECT * FROM nodes WHERE revision_id=?')
        .get(revisionIdStr(revisionId)) as NodeRow | undefined;
      if (!row) return { ok: false, error: 'PURGED_FINAL' };
      const node = this.rowToNode(row);
      if (!isVisible(a, this.scopeViewOf(node), node.sensitivity)) {
        return { ok: false, error: 'PERMISSION_DENIED' };
      }
      if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
        return { ok: false, error: 'CAS_CONFLICT', currentRevision: asRevisionId(row.revision_id) };
      }
      if (row.content_state !== 'MINIMIZED') {
        return { ok: false, error: 'INVALID_STATE' };
      }
      if (!row.minimized_blob_ref || !row.minimized_blob_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }

      // ① 读回归档并校验 Hash（失败即零副作用）
      await this.blobs.assertInsideRoot(row.minimized_blob_ref);
      const content = await this.blobs.readVerified(row.minimized_blob_ref, row.minimized_blob_hash);
      // ② 校验内容与原始 content_hash 一致（证明恢复的是同一条记忆）
      if (sha256(content) !== row.content_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }
      // ③ 恢复到主区
      const mainRef = BlobStore.mainRefFor(row.content_hash);
      const restoredHash = await this.blobs.write(mainRef, content);
      if (restoredHash !== row.content_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }

      // ④ 主区恢复成功后才改状态
      return await this.withTx<TxResult>(() => {
        this.db
          .prepare(
            `UPDATE nodes SET content_state='FULL', content_ref=COALESCE(content_ref, ?),
               minimized_blob_ref=NULL, minimized_blob_hash=NULL
             WHERE revision_id=?`
          )
          .run(mainRef, row.revision_id);
        return { ok: true, revision_id: asRevisionId(row.revision_id) };
      });
    } catch (e) {
      return this.asTxError(e);
    }
  }

  /** 硬擦除：需 memory:purge；Ledger 记录真实操作者 */
  async purge(
    nodeId: NodeId,
    auth: AuthContext,
    reasonCategory: string,
    cas: Cas
  ): Promise<TxResult> {
    try {
      const a = assertValidAuth(auth);
      if (!hasCap(a, 'memory:purge')) throw new ForbiddenError('PERMISSION_DENIED: 缺少 memory:purge 能力');

      return await this.withTx<TxResult>(() => {
        const row = this.db
          .prepare("SELECT * FROM nodes WHERE node_id=? AND version_state='CURRENT'")
          .get(nodeIdStr(nodeId)) as NodeRow | undefined;
        if (!row) return { ok: false, error: 'PURGED_FINAL' };
        const node = this.rowToNode(row);
        if (!isVisible(a, this.scopeViewOf(node), node.sensitivity)) {
          return { ok: false, error: 'PERMISSION_DENIED' };
        }
        if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
          return { ok: false, error: 'CAS_CONFLICT', currentRevision: asRevisionId(row.revision_id) };
        }

        const all = this.db
          .prepare('SELECT revision_id, content_hash, content_ref, minimized_blob_ref FROM nodes WHERE node_id=?')
          .all(row.node_id) as {
          revision_id: string;
          content_hash: string;
          content_ref: string | null;
          minimized_blob_ref: string | null;
        }[];

        const ledger = this.db.prepare(
          `INSERT INTO purge_ledger(node_id, content_hash, operator, reason_category)
           VALUES(?,?,?,?)`
        );
        for (const r of all) ledger.run(row.node_id, r.content_hash, a.agentId, reasonCategory);

        this.cleanupNodeRelations(row.node_id, all.map(r => r.revision_id));
        this.db.prepare('DELETE FROM sensitivity_overlay WHERE node_id=?').run(row.node_id);
        this.db.prepare('DELETE FROM nodes WHERE node_id=?').run(row.node_id);
        return { ok: true, revision_id: asRevisionId(row.revision_id) };
      });
    } catch (e) {
      return this.asTxError(e);
    }
  }

  /** 对账：清理 Ledger 命中残留（节点 + 两类边 + 覆盖层 + Outbox） */
  async reconcile(): Promise<{ fixed: number }> {
    return this.withTx(() => {
      const orphans = this.db
        .prepare(
          `SELECT n.node_id FROM nodes n JOIN purge_ledger l ON l.node_id = n.node_id GROUP BY n.node_id`
        )
        .all() as { node_id: string }[];

      let fixed = 0;
      for (const o of orphans) {
        const revs = this.db
          .prepare('SELECT revision_id FROM nodes WHERE node_id=?')
          .all(o.node_id) as { revision_id: string }[];
        this.cleanupNodeRelations(o.node_id, revs.map(r => r.revision_id));
        this.db.prepare('DELETE FROM sensitivity_overlay WHERE node_id=?').run(o.node_id);
        this.db
          .prepare("DELETE FROM outbox WHERE entity_id=?")
          .run(o.node_id);
        this.db.prepare('DELETE FROM nodes WHERE node_id=?').run(o.node_id);
        fixed += 1;
      }

      // 清理全库孤儿引用（边端点不存在、覆盖层无节点）
      this.db.exec(`
DELETE FROM edges WHERE type <> 'supersedes'
  AND (NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."from")
    OR NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = edges."to"));
DELETE FROM edges WHERE type = 'supersedes'
  AND (NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."from")
    OR NOT EXISTS (SELECT 1 FROM nodes WHERE revision_id = edges."to"));
DELETE FROM sensitivity_overlay WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE node_id = sensitivity_overlay.node_id);
`);
      return { fixed };
    });
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* 非 WAL 忽略 */
    }
    this.db.close();
  }

  get raw(): InstanceType<typeof DatabaseSync> {
    return this.db;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private loadRow(ref: NodeRef): NodeRow | undefined {
    if (ref.kind === 'revision') {
      return this.db
        .prepare(
          `SELECT n.*, so.value AS sensitivity_value FROM nodes n
           LEFT JOIN sensitivity_overlay so ON so.node_id = n.node_id
           WHERE n.revision_id=?`
        )
        .get(revisionIdStr(ref.revisionId)) as NodeRow | undefined;
    }
    return this.db
      .prepare(
        `SELECT n.*, so.value AS sensitivity_value FROM nodes n
         LEFT JOIN sensitivity_overlay so ON so.node_id = n.node_id
         WHERE n.node_id=? AND n.version_state='CURRENT'`
      )
      .get(nodeIdStr(ref.nodeId)) as NodeRow | undefined;
  }

  private cleanupNodeRelations(nodeId: string, revisionIds: string[]): void {
    this.db
      .prepare(`DELETE FROM edges WHERE type <> 'supersedes' AND ("from"=? OR "to"=?)`)
      .run(nodeId, nodeId);
    for (const r of revisionIds) {
      this.db
        .prepare(`DELETE FROM edges WHERE type = 'supersedes' AND ("from"=? OR "to"=?)`)
        .run(r, r);
    }
  }

  private insertNode(node: MemoryNode): void {
    const scope = node.scope;
    this.db
      .prepare(
        `INSERT INTO nodes(node_id, revision_id, revision_sequence, content_hash, version_state,
          content_state, content_ref, stub_summary, minimized_blob_ref, minimized_blob_hash,
          modality, confidence, provenance, valid_from, valid_until, ingested_at,
          superseded_by, superseded_by_revision,
          owner_id, layer, project_id, agent_id, visibility, shared_with)
         VALUES(@node_id,@revision_id,@revision_sequence,@content_hash,@version_state,
          @content_state,@content_ref,@stub_summary,@minimized_blob_ref,@minimized_blob_hash,
          @modality,@confidence,@provenance,@valid_from,@valid_until,@ingested_at,
          NULL,@superseded_by_revision,
          @owner_id,@layer,@project_id,@agent_id,@visibility,@shared_with)`
      )
      .run({
        node_id: nodeIdStr(node.node_id),
        revision_id: revisionIdStr(node.revision_id),
        revision_sequence: node.revision_sequence,
        content_hash: String(node.content_hash),
        version_state: node.version_state,
        content_state: node.content_state,
        content_ref: node.content_ref,
        stub_summary: node.stub_summary,
        minimized_blob_ref: node.minimized_blob_ref,
        minimized_blob_hash: node.minimized_blob_hash,
        modality: node.modality,
        confidence: node.confidence,
        provenance: typeof node.provenance === 'string' ? node.provenance : JSON.stringify(node.provenance),
        valid_from: node.valid_from,
        valid_until: node.valid_until,
        ingested_at: node.ingested_at,
        superseded_by_revision: node.superseded_by ?? null,
        owner_id: scope.owner_id,
        layer: scope.layer,
        project_id: scope.project_id,
        agent_id: scope.agent_id,
        visibility: scope.visibility,
        shared_with: JSON.stringify(scope.shared_with ?? []),
      });

    // sensitivity 覆盖层（非 normal 才写，normal 视为缺省）
    if (node.sensitivity && node.sensitivity !== 'normal') {
      this.db
        .prepare(
          `INSERT INTO sensitivity_overlay(node_id, value, updated_by, reason)
           VALUES(?,?,?,?)
           ON CONFLICT(node_id) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by`
        )
        .run(nodeIdStr(node.node_id), node.sensitivity, node.provenance?.agent_id ?? 'unknown', 'write');
    }
  }

  private insertEdge(e: Edge): void {
    const isSupersedes = e.type === 'supersedes';
    this.db
      .prepare(
        `INSERT INTO edges(type, link_class, "from", "to", weight, created_at) VALUES(?,?,?,?,?,?)`
      )
      .run(
        e.type,
        isSupersedes ? null : ((e as { link_class?: string }).link_class ?? null),
        String(e.from),
        String(e.to),
        e.weight,
        e.created_at
      );
  }

  private insertOutbox(o: OutboxEntry): void {
    this.db
      .prepare(
        `INSERT INTO outbox(kind, entity_id, seq, payload) VALUES(?,?,?,?)
         ON CONFLICT(kind, entity_id, seq) DO NOTHING`
      )
      .run(o.kind, o.entity_id, o.seq, o.payload === undefined ? null : JSON.stringify(o.payload));
  }

  private scopeViewOf(n: MemoryNode) {
    return {
      owner_id: n.scope.owner_id,
      layer: n.scope.layer,
      project_id: n.scope.project_id,
      agent_id: n.scope.agent_id,
      visibility: n.scope.visibility,
      shared_with: n.scope.shared_with,
    };
  }

  private rowToScope(r: NodeRow): Scope {
    let shared: string[] = [];
    try {
      const parsed = JSON.parse(r.shared_with);
      if (Array.isArray(parsed)) shared = parsed as string[];
    } catch {
      /* DB CHECK 保证合法 */
    }
    return {
      owner_id: r.owner_id,
      layer: r.layer as Scope['layer'],
      project_id: r.project_id,
      agent_id: r.agent_id,
      visibility: r.visibility as Scope['visibility'],
      shared_with: shared,
    };
  }

  private rowToNode(r: NodeRow): MemoryNode {
    let provenance: Provenance;
    try {
      provenance = JSON.parse(r.provenance) as Provenance;
    } catch {
      provenance = {
        agent_id: 'unknown',
        origin: 'hot-path',
        method: 'rule',
        source_refs: [],
        producer_version: 'unknown',
        model_id: null,
        generated_at: r.ingested_at,
        confidence: r.confidence,
      };
    }
    const sens = (r.sensitivity_value ?? 'normal') as Sensitivity;
    return {
      node_id: asNodeId(r.node_id),
      revision_id: asRevisionId(r.revision_id),
      revision_sequence: r.revision_sequence,
      content_hash: asContentHash(r.content_hash),
      version_state: r.version_state,
      content_state: r.content_state,
      content_ref: r.content_ref,
      stub_summary: r.stub_summary,
      minimized_blob_ref: r.minimized_blob_ref,
      minimized_blob_hash: r.minimized_blob_hash,
      modality: 'text',
      confidence: r.confidence,
      provenance,
      scope: this.rowToScope(r),
      sensitivity: sens,
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      ingested_at: r.ingested_at,
      superseded_by: r.superseded_by_revision ? asRevisionId(r.superseded_by_revision) : null,
    };
  }

  private asTxError(e: unknown): TxResult {
    if (e instanceof ForbiddenError) return { ok: false, error: 'PERMISSION_DENIED' };
    const msg = e instanceof Error ? e.message : String(e);
    if (/AUTH_CONTEXT_REQUIRED|PERMISSION_DENIED/.test(msg)) return { ok: false, error: 'PERMISSION_DENIED' };
    if (/BLOB_PATH_REJECTED/.test(msg)) return { ok: false, error: 'PERMISSION_DENIED' };
    if (/ARCHIVE_MISSING/.test(msg)) return { ok: false, error: 'ARCHIVE_MISSING' };
    if (/STATE_CONFLICT/.test(msg)) return { ok: false, error: 'STATE_CONFLICT' };
    if (/MEM_IMMUTABLE/.test(msg)) return { ok: false, error: 'STATE_CONFLICT' };
    if (/PURGED_FINAL/.test(msg)) return { ok: false, error: 'PURGED_FINAL' };
    if (/STUB_IMMUTABLE/.test(msg)) return { ok: false, error: 'STUB_IMMUTABLE' };
    if (/SCOPE_INVALID|CHECK|constraint/i.test(msg)) return { ok: false, error: 'SCOPE_INVALID' };
    if (/UNIQUE/.test(msg)) return { ok: false, error: 'CAS_CONFLICT' };
    throw e;
  }
}
