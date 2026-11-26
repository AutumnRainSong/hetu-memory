/** SqliteStorageProvider —— Storage SPI / StorageTx 的真实 SQLite 实现（M1-B）
 *
 *  设计要点（对应主规格 §1.1 四条不变量）：
 *  1. 链尾唯一：supersede 走条件写（CAS），失败返回 CAS_CONFLICT + 当前 revision
 *  2. 节点不可变：只 INSERT 新 revision，绝不 UPDATE 内容字段（DB 触发器兜底）
 *  3. Purge Ledger 先行提交：purge() 在单事务内先写 Ledger 再级联删除；崩溃由 reconcile() 收敛
 *  4. 单写者：同一 provider 实例串行写；跨进程由 SQLite WAL + busy_timeout 承载
 *
 *  权限前置：query() 在 SQL 层就带上 scope 条件，绝不"先全量召回再过滤"。
 */
import { DatabaseSync } from './sqlite.ts';
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
import { type AuthContext, AuthRequiredError } from '../auth/context.ts';
import type {
  StorageTx,
  NodeRef,
  Cas,
  Hit,
  BlobHandle,
  Subgraph,
  TraverseBudget,
} from './spi.ts';

export interface ProviderOptions {
  /** SQLite 数据库文件路径，或 ':memory:' */
  dbPath?: string;
  /** Blob 根目录（默认不落盘，仅记录引用） */
  blobRoot?: string;
  /** 跨进程写冲突等待（ms） */
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
}

const UNIMPLEMENTED = (what: string) =>
  Promise.reject(new Error(`UNIMPLEMENTED: ${what} — 属 M2/M4 范围（当前 M1-B 只实现基础存储）`));

export class SqliteStorageProvider implements StorageTx {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly blobRoot?: string;
  /** 单写者：写事务串行化（同进程内） */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: ProviderOptions = {}) {
    this.db = new DatabaseSync(opts.dbPath ?? ':memory:');
    this.blobRoot = opts.blobRoot;
    if (opts.dbPath && opts.dbPath !== ':memory:') {
      // WAL 提升读写并发；busy_timeout 处理跨进程写冲突
      this.db.exec(`PRAGMA journal_mode=WAL;`);
      this.db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5000};`);
    }
    this.db.exec('PRAGMA foreign_keys=ON;');
  }

  /** 事务包装：串行化 + 失败整体回滚 */
  private async withTx<T>(fn: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
    const next = this.writeChain.then(run, run);
    // 保持链不因单次失败而断裂
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  // ───────────────────────── 读 ─────────────────────────

  async get(
    ref: NodeRef,
    opts: { includeArchived?: boolean; auth?: AuthContext } = {}
  ): Promise<MemoryNode | null> {
    let row: NodeRow | undefined;
    if (ref.kind === 'revision') {
      row = this.db
        .prepare('SELECT * FROM nodes WHERE revision_id=?')
        .get(revisionIdStr(ref.revisionId)) as NodeRow | undefined;
    } else {
      row = this.db
        .prepare("SELECT * FROM nodes WHERE node_id=? AND version_state='CURRENT'")
        .get(nodeIdStr(ref.nodeId)) as NodeRow | undefined;
    }
    // 授权（P0-A）：带 auth 时检查可见性；不带 auth 仅供存储层内部使用
    if (row && opts.auth) {
      const a = opts.auth;
      const n = this.rowToNode(row);
      const visible =
        n.scope.owner_id === a.ownerId &&
        (n.scope.layer === 'user_identity' ||
          (n.scope.layer === 'project' &&
            n.scope.project_id !== null &&
            a.projectIds.includes(n.scope.project_id)) ||
          (n.scope.layer === 'global' && a.canReadGlobal) ||
          ((n.scope.layer === 'agent_persona' || n.scope.layer === 'private_annotation') &&
            n.scope.agent_id === a.agentId));
      if (!visible) return null; // 不可见 → 等同不存在（不泄漏存在性）
    }
    if (!row) return null;
    // PURGED 不落节点表（由 purge_ledger 承载）；此处只需处理业务可见性
    if (!opts.includeArchived && row.content_state === 'TOMBSTONE') return null;
    return this.rowToNode(row);
  }

  /** 权限前置查询（P0-A）：必须携带可信 AuthContext，缺失即失败关闭。
   *
   *  授权推导规则（调用方不可绕过）：
   *  - 强制 owner_id = auth.ownerId（工作空间绝对隔离）
   *  - project 层：project_id 必须 ∈ auth.projectIds（可信成员关系，非客户端自述）
   *  - global 层：需 auth.canReadGlobal
   *  - agent_persona / private_annotation：仅 agent_id = auth.agentId 可见
   *  - user_identity：仅 owner 本人可见
   */
  async query(
    q: { text?: string; scope?: Partial<Scope> },
    auth: AuthContext
  ): Promise<Hit[]> {
    if (!auth || !auth.ownerId || !auth.agentId) throw new AuthRequiredError();

    const where: string[] = [
      "n.version_state='CURRENT'",
      "n.content_state IN ('FULL','MINIMIZED','STUB')",
      'n.owner_id = ?',
    ];
    const params: (string | number)[] = [auth.ownerId];

    // 层可见性由授权推导，不接受客户端传 layer
    const visibleLayerExpr = [
      `(n.layer = 'user_identity')`,
      `(n.layer = 'project' AND n.project_id IN (${auth.projectIds.length ? auth.projectIds.map(() => '?').join(',') : "''"}))`,
      `(n.layer = 'global' AND ${auth.canReadGlobal ? '1' : '0'} = 1)`,
      `(n.layer IN ('agent_persona','private_annotation') AND n.agent_id = ?)`,
    ].join(' OR ');
    where.push(`(${visibleLayerExpr})`);
    params.push(...auth.projectIds);
    params.push(auth.agentId);

    // 客户端可选的收窄条件（只能进一步缩小，不能扩大）
    const sc = q.scope ?? {};
    if (sc.layer) {
      where.push('n.layer = ?');
      params.push(sc.layer);
    }
    if (sc.project_id) {
      if (!auth.projectIds.includes(sc.project_id)) {
        return []; // 未授权项目 → 空结果（不泄漏存在性）
      }
      where.push('n.project_id = ?');
      params.push(sc.project_id);
    }
    if (sc.agent_id) {
      // 只能查自己
      if (sc.agent_id !== auth.agentId) return [];
      where.push('n.agent_id = ?');
      params.push(sc.agent_id);
    }
    if (sc.visibility) {
      where.push('n.visibility = ?');
      params.push(sc.visibility);
    }

    // 文本检索：MVP 用简单的分词 LIKE（BM25 全量实现属 M4）
    if (q.text && q.text.trim()) {
      const terms = q.text
        .trim()
        .split(/\s+/)
        .filter(t => t.length > 0)
        .slice(0, 8);
      for (const t of terms) {
        where.push(`(n.stub_summary LIKE ? OR n.content_ref LIKE ?)`);
        params.push(`%${t}%`, `%${t}%`);
      }
    }

    const sql = `SELECT n.* FROM nodes n WHERE ${where.join(' AND ')}
                 ORDER BY n.revision_sequence DESC LIMIT 100`;
    const rows = this.db.prepare(sql).all(...params) as unknown as NodeRow[];

    return rows.map(r => ({
      node_id: asNodeId(r.node_id),
      revision_id: asRevisionId(r.revision_id),
      score: 1.0, // MVP：未实现评分函数（DDR T-B-04）
      scope: this.rowToScope(r),
    }));
  }

  async graphTraverse(_from: NodeId, _budget: TraverseBudget): Promise<Subgraph> {
    return UNIMPLEMENTED('graphTraverse（图谱扩散）');
  }

  async vectorSearch(_v: Float32Array, _budget: number): Promise<Hit[]> {
    return UNIMPLEMENTED('vectorSearch（HNSW 向量检索）');
  }

  async blobRef(hash: ContentHash): Promise<BlobHandle> {
    const dir = String(hash).replace(/^sha256:/, '');
    return {
      ref: `blobs/${dir.slice(0, 2)}/${dir}`,
      hash,
      inArchive: false,
    };
  }

  // ───────────────────────── 写 ─────────────────────────

  async put(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    cas?: Cas
  ): Promise<TxResult> {
    return this.putWithRevision(node, edges, outbox, cas);
  }

  async putWithRevision(
    node: MemoryNode,
    edges: Edge[],
    outbox: OutboxEntry[],
    cas?: Cas
  ): Promise<TxResult> {
    try {
      return await this.withTx<TxResult>(() => {
        // CAS：期望的当前链尾 revision 必须匹配
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
          // 顺序满足约束：① 新 revision 以 SUPERSEDED 占位插入（idx_nodes_current 只约束 CURRENT）
          //              ② 旧链尾翻转并指向新 revision（引用完整性触发器此时可命中）
          //              ③ 新 revision 升为 CURRENT
          this.insertNode({ ...node, version_state: 'SUPERSEDED' });
          this.db
            .prepare(
              `UPDATE nodes SET version_state='SUPERSEDED', superseded_by_revision=?
               WHERE revision_id=?`
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
      return { ok: false, error: this.classifyError(e) };
    }
  }

  async minimize(revisionId: RevisionId, archive: BlobHandle, cas: Cas): Promise<TxResult> {
    // 能力边界（P0-B）：未配置归档存储时不允许调用，防止"状态变了但归档没落"的假成功
    if (!this.blobRoot) return { ok: false, error: 'ARCHIVE_MISSING' };
    try {
      // 归档必须先真实落盘并校验 Hash（失败即不改库）
      const archiveCheck = await this.writeArchive(archive);
      if (!archiveCheck.ok) return { ok: false, error: 'ARCHIVE_MISSING' };

      return await this.withTx<TxResult>(() => {
        const row = this.db
          .prepare('SELECT * FROM nodes WHERE revision_id=?')
          .get(revisionIdStr(revisionId)) as NodeRow | undefined;
        if (!row) return { ok: false, error: 'INVALID_STATE' };
        if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
          return { ok: false, error: 'CAS_CONFLICT', currentRevision: asRevisionId(row.revision_id) };
        }
        // MINIMIZED 状态与归档字段在同一 UPDATE 内变化（满足生命周期守卫）
        this.db
          .prepare(
            `UPDATE nodes SET content_state='MINIMIZED', minimized_blob_ref=?, minimized_blob_hash=?
             WHERE revision_id=?`
          )
          .run(archive.ref, String(archive.hash), row.revision_id);
        return { ok: true, revision_id: asRevisionId(row.revision_id) };
      });
    } catch (e) {
      return { ok: false, error: this.classifyError(e) };
    }
  }

  async purge(nodeId: NodeId, reasonCategory: string, cas: Cas): Promise<TxResult> {
    try {
      return await this.withTx<TxResult>(() => {
        // Purge 作用于整个逻辑记忆：CAS 校验对象是当前链尾
        const row = this.db
          .prepare("SELECT * FROM nodes WHERE node_id=? AND version_state='CURRENT'")
          .get(nodeIdStr(nodeId)) as NodeRow | undefined;
        if (!row) return { ok: false, error: 'PURGED_FINAL' };
        if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
          return { ok: false, error: 'CAS_CONFLICT', currentRevision: asRevisionId(row.revision_id) };
        }
        // Ledger 必须覆盖该逻辑记忆的**全部** revision（防旧版本经备份/导入复活）
        const allRevisions = this.db
          .prepare('SELECT revision_id, content_hash FROM nodes WHERE node_id=?')
          .all(row.node_id) as { revision_id: string; content_hash: string }[];
        const ledgerInsert = this.db.prepare(
          `INSERT INTO purge_ledger(node_id, content_hash, operator, reason_category)
           VALUES(?,?,?,?)`
        );
        for (const r of allRevisions) {
          ledgerInsert.run(row.node_id, r.content_hash, 'provider', reasonCategory);
        }

        // 普通边端点用 node_id；supersedes 边端点用 revision_id
        this.db
          .prepare(
            `DELETE FROM edges WHERE type <> 'supersedes' AND ("from"=? OR "to"=?)`
          )
          .run(row.node_id, row.node_id);
        for (const r of allRevisions) {
          this.db
            .prepare(`DELETE FROM edges WHERE type = 'supersedes' AND ("from"=? OR "to"=?)`)
            .run(r.revision_id, r.revision_id);
        }
        this.db.prepare('DELETE FROM nodes WHERE node_id=?').run(row.node_id);
        return { ok: true, revision_id: asRevisionId(row.revision_id) };
      });
    } catch (e) {
      return { ok: false, error: this.classifyError(e) };
    }
  }

  async revive(revisionId: RevisionId, cas: Cas): Promise<TxResult> {
    // 归档校验必须在任何写操作之前完成（失败即不改库）
    const row0 = this.db
      .prepare('SELECT * FROM nodes WHERE revision_id=?')
      .get(revisionIdStr(revisionId)) as NodeRow | undefined;
    if (!row0) return { ok: false, error: 'PURGED_FINAL' };
    if (row0.content_state === 'MINIMIZED' || row0.content_state === 'TOMBSTONE') {
      const verified = await this.verifyArchive(row0.minimized_blob_ref, row0.minimized_blob_hash);
      if (!verified) return { ok: false, error: 'ARCHIVE_MISSING' };
    }
    try {
      return await this.withTx<TxResult>(() => {
        const row = this.db
          .prepare('SELECT * FROM nodes WHERE revision_id=?')
          .get(revisionIdStr(revisionId)) as NodeRow | undefined;
        if (!row) return { ok: false, error: 'PURGED_FINAL' };
        if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
          return { ok: false, error: 'CAS_CONFLICT', currentRevision: asRevisionId(row.revision_id) };
        }
        if (row.content_state === 'TOMBSTONE') {
          // 归档原文仍在 → 回 FULL；否则降级为 STUB 并报 ARCHIVE_MISSING 由调用方处理
          const hasArchive = row.minimized_blob_ref !== null;
          this.db
            .prepare(
              `UPDATE nodes SET content_state=?, minimized_blob_ref=NULL, minimized_blob_hash=NULL
               WHERE revision_id=?`
            )
            .run(hasArchive ? 'FULL' : 'STUB', row.revision_id);
          if (!hasArchive && row.content_ref === null) {
            return { ok: false, error: 'ARCHIVE_MISSING', currentRevision: asRevisionId(row.revision_id) };
          }
          return { ok: true, revision_id: asRevisionId(row.revision_id) };
        }
        if (row.content_state === 'MINIMIZED') {
          if (row.minimized_blob_ref === null) {
            return { ok: false, error: 'ARCHIVE_MISSING', currentRevision: asRevisionId(row.revision_id) };
          }
          this.db
            .prepare(
              `UPDATE nodes SET content_state='FULL', minimized_blob_ref=NULL, minimized_blob_hash=NULL
               WHERE revision_id=?`
            )
            .run(row.revision_id);
          return { ok: true, revision_id: asRevisionId(row.revision_id) };
        }
        return { ok: false, error: 'INVALID_STATE' };
      });
    } catch (e) {
      return { ok: false, error: this.classifyError(e) };
    }
  }

  /** 启动对账：Ledger 有而节点表仍有 → 补删（崩溃残留收敛） */
  async reconcile(): Promise<{ fixed: number }> {
    return this.withTx(() => {
      const orphans = this.db
        .prepare(
          `SELECT n.node_id FROM nodes n
           JOIN purge_ledger l ON l.node_id = n.node_id`
        )
        .all() as { node_id: string }[];
      for (const o of orphans) {
        this.db.prepare('DELETE FROM nodes WHERE node_id=?').run(o.node_id);
      }
      return { fixed: orphans.length };
    });
  }

  /** 关闭数据库（测试用；确保 WAL 落盘） */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* 非 WAL 模式忽略 */
    }
    this.db.close();
  }

  /** 暴露底层 db 仅供测试断言约束（不用于业务写路径） */
  get raw(): InstanceType<typeof DatabaseSync> {
    return this.db;
  }

  // ───────────────────── 内部 helpers ─────────────────────

  // ── P0-B：归档真实存储与校验 ──

  /** 写入归档文件：真实落盘 + 存在性 + Hash 校验 */
  private async writeArchive(archive: BlobHandle): Promise<{ ok: boolean }> {
    if (!this.blobRoot) {
      // 未配置 blobRoot 时不冒充已归档（否则 Minimize 不可信）
      return { ok: false };
    }
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { dirname, join } = await import('node:path');
    const abs = join(this.blobRoot, archive.ref);
    try {
      await mkdir(dirname(abs), { recursive: true });
      // 归档内容由调用方通过 blobRef 提供；此处校验"内容已存在"或写入占位
      // 真实内容来源：content_ref 指向的主区 blob（由上层读取后传入）
      // 为可验证性，这里要求归档文件必须已由调用方写入，否则拒绝
      const buf = await readFile(abs);
      const h = 'sha256:' + createHash('sha256').update(buf).digest('hex');
      return { ok: h === String(archive.hash) };
    } catch {
      // 文件不存在 → 尝试创建空占位再校验（生产由上层写入真实内容）
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, '');
        return { ok: false };
      } catch {
        return { ok: false };
      }
    }
  }

  /** 校验归档文件存在且 Hash 匹配（Revive 前置条件） */
  private async verifyArchive(ref: string | null, expectedHash: string | null): Promise<boolean> {
    if (!ref || !this.blobRoot) return false;
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { join } = await import('node:path');
    try {
      const buf = await readFile(join(this.blobRoot, ref));
      const h = 'sha256:' + createHash('sha256').update(buf).digest('hex');
      return expectedHash ? h === expectedHash : true;
    } catch {
      return false;
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
  }

  private insertEdge(e: Edge): void {
    const isSupersedes = e.type === 'supersedes';
    this.db
      .prepare(
        `INSERT INTO edges(type, link_class, "from", "to", weight, created_at)
         VALUES(?,?,?,?,?,?)`
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

  private rowToScope(r: NodeRow): Scope {
    let shared: string[] = [];
    try {
      const parsed = JSON.parse(r.shared_with);
      if (Array.isArray(parsed)) shared = parsed as string[];
    } catch {
      /* 非法 JSON 由 DB CHECK 拦截，此处兜底 */
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
    // sensitivity 读覆盖层（可变），缺省 normal
    const ov = this.db
      .prepare('SELECT value FROM sensitivity_overlay WHERE node_id=?')
      .get(r.node_id) as { value: 'normal' | 'sensitive' | 'restricted' } | undefined;

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
      sensitivity: ov?.value ?? 'normal',
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      ingested_at: r.ingested_at,
      superseded_by: r.superseded_by_revision ? asRevisionId(r.superseded_by_revision) : null,
    };
  }

  private classifyError(e: unknown): TxResult extends { error: infer E } ? E : never {
    const msg = e instanceof Error ? e.message : String(e);
    if (/STATE_CONFLICT/.test(msg)) return 'STATE_CONFLICT' as never;
    if (/MEM_IMMUTABLE/.test(msg)) return 'STATE_CONFLICT' as never;
    if (/PURGED_FINAL/.test(msg)) return 'PURGED_FINAL' as never;
    if (/STUB_IMMUTABLE/.test(msg)) return 'STUB_IMMUTABLE' as never;
    if (/SCOPE_INVALID|CHECK|constraint/i.test(msg)) return 'SCOPE_INVALID' as never;
    if (/UNIQUE/.test(msg)) return 'CAS_CONFLICT' as never;
    throw e; // 未预期错误不吞掉
  }
}
