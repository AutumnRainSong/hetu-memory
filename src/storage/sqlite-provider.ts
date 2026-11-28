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
import { BlobStore, sha256, ownerKeyFor } from './blob-store.ts';
import { registerBlobRef, planPurge, runCleanup, reconcileBlobs, type ReconcileResult } from './blob-lifecycle.ts';
import { buildMinimizeUpdate, buildReviveUpdate, assertSingleRow, recordOrphanForCleanup } from './lifecycle-cas.ts';
import {
  type MemoryNode,
  type Edge,
  type OutboxEntry,
  type NodeId,
  type RevisionId,
  type ContentHash,
  type TxResult,
  type PurgeResult,
  type PurgeCleanupStatus,
  type ErrorCodeName,
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

  /** 维护面：返回某 owner 命名空间下该内容的主区定位（R4：必须显式给 ownerId，防跨工作空间探测） */
  async blobRef(ownerId: string, hash: ContentHash): Promise<BlobHandle> {
    return { ref: BlobStore.mainRefFor(ownerId, String(hash)), hash, inArchive: false };
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
        for (const e of edges) this.insertEdge(e, a);
        for (const o of outbox) this.insertOutbox(o, nodeIdStr(node.node_id), node.scope, a);

        // ── R4-A2：登记 Blob 引用（事务内；DELETING 对象返回 BLOB_BUSY）──
        const ownerKey = ownerKeyFor(a.ownerId);
        const regs: { ref: string; kind: 'main' | 'archive'; hash: string }[] = [];
        if (node.content_ref) {
          regs.push({ ref: node.content_ref, kind: 'main', hash: String(node.content_hash) });
        }
        if (node.minimized_blob_ref && node.minimized_blob_hash) {
          regs.push({
            ref: node.minimized_blob_ref,
            kind: 'archive',
            hash: String(node.minimized_blob_hash),
          });
        }
        for (const g of regs) {
          const reg = registerBlobRef(this.db, {
            ownerKey,
            blobRef: g.ref,
            nodeId: nodeIdStr(node.node_id),
            revisionId: revisionIdStr(node.revision_id),
            kind: g.kind,
            contentHash: g.hash,
          });
          if (!reg.ok) throw new ForbiddenError('BLOB_BUSY: 目标 Blob 正在删除，请稍后重试');
        }

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
      // ③ 写入归档区（R4：owner 命名空间 + 内容寻址，同 owner 内跨 Revision 去重）
      const archiveRef = BlobStore.archiveRefFor(row.owner_id, row.content_hash);
      const archiveHash = await this.blobs.write(archiveRef, original);
      // ④ 校验归档文件真实存在且 Hash 一致（write/read 已内建符号链接安全解析）
      await this.blobs.readVerified(archiveRef, archiveHash);

      // ⑤ R4-C1：最终状态检查与条件更新在同一事务内，且校验 affected rows
      return await this.withTx<TxResult>(() => {
        const spec = buildMinimizeUpdate({
          revisionId: row.revision_id,
          archiveRef,
          archiveHash,
          stubSummary: `精简：${String(row.content_hash).slice(0, 24)}`,
        });
        const changes = Number(this.db.prepare(spec.sql).run(...(spec.params as never[])).changes);
        const verdict = assertSingleRow(changes);
        if (!verdict.ok) {
          // 归档文件已落盘但未被任何 revision 引用 → 登记清理任务，不得静默残留
          recordOrphanForCleanup(this.db, {
            ownerKey: ownerKeyFor(row.owner_id),
            blobRef: archiveRef,
            kind: 'archive',
          });
          return { ok: false, error: 'STATE_CONFLICT' };
        }
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
      if (row.version_state !== 'CURRENT' || row.content_state !== 'MINIMIZED') {
        // R3-03：只能恢复当前版本；已被替代的历史版本按状态机拒绝直接 Revive
        return { ok: false, error: 'INVALID_STATE' };
      }
      if (!row.minimized_blob_ref || !row.minimized_blob_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }

      // ① 读回归档并校验 Hash（读前含符号链接安全解析，失败即零副作用）
      const content = await this.blobs.readVerified(row.minimized_blob_ref, row.minimized_blob_hash);
      // ② 校验内容与原始 content_hash 一致（证明恢复的是同一条记忆）
      if (sha256(content) !== row.content_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }
      // ③ 恢复到主区（R4：owner 命名空间隔离）
      const mainRef = BlobStore.mainRefFor(row.owner_id, row.content_hash);
      const restoredHash = await this.blobs.write(mainRef, content);
      if (restoredHash !== row.content_hash) {
        return { ok: false, error: 'ARCHIVE_MISSING' };
      }

      // ④ R4-C2：主区恢复成功后，在事务内用带 ref/hash CAS 的条件更新提交状态
      return await this.withTx<TxResult>(() => {
        const spec = buildReviveUpdate({
          revisionId: row.revision_id,
          expectedRef: row.minimized_blob_ref!,
          expectedHash: row.minimized_blob_hash!,
          mainRef,
        });
        const changes = Number(this.db.prepare(spec.sql).run(...(spec.params as never[])).changes);
        const verdict = assertSingleRow(changes);
        if (!verdict.ok) {
          return { ok: false, error: 'STATE_CONFLICT' };
        }
        return { ok: true, revision_id: asRevisionId(row.revision_id) };
      });
    } catch (e) {
      return this.asTxError(e);
    }
  }

  /** 硬擦除：需 memory:purge；Ledger 记录真实操作者 */
  /** 硬擦除（R3-01）：Ledger 先行 → 标记待删 blob → 择优删除文件 → 数据库记录
   *
   *  语义：
   *  1. 写 purge_ledger（持久化擦除意图，崩溃不丢）
   *  2. 为每个 revision 的主区 ref + 归档 ref 写入 purge_blob_marks（pending）
   *  3. 尽力物理删除 blob 文件；删除成功的 mark 置 done，失败保留 pending 由 reconcile 重试
   *  4. 删除节点/边/覆盖层/Outbox
   *  5. 返回前不做"文件已全删"的绝对担保——未删除的 pending 由 reconcile 补偿
   */
  /** 硬擦除（R4-A4/A5）：严格两阶段 —— 逻辑删除先行提交，物理清理在事务外
   *
   *  阶段一（本方法的主事务内，planPurge 完成）：
   *    ① purge_ledger 写入全部 revision 的 content_hash（提交点，operator = auth.agentId）
   *    ② 删该 node 的 blob_refs（引用归零）
   *    ③ 对每个候选 blob 做**原子认领**：仅当引用归零才 ACTIVE→DELETING 并入队清理任务
   *    ④ 删节点 / 两类边 / sensitivity_overlay / outbox
   *  阶段二（事务 COMMIT 之后）：runCleanup 执行真实 unlink；失败保留任务由 reconcile 补偿。
   *
   *  返回：ok=true 表示**逻辑删除已提交**（此后不可访问/不可写/不可 Revive）。
   *        物理清理状态在 cleanup 字段里如实上报，绝不伪称"已全部物理删除"。
   */
  async purge(
    nodeId: NodeId,
    auth: AuthContext,
    reasonCategory: string,
    cas: Cas
  ): Promise<PurgeResult> {
    try {
      const a = assertValidAuth(auth);
      if (!hasCap(a, 'memory:purge')) throw new ForbiddenError('PERMISSION_DENIED: 缺少 memory:purge 能力');

      // ── 阶段一：逻辑删除（单一事务）──
      const phase1 = await this.withTx<
        | { ok: false; error: ErrorCodeName; currentRevision?: RevisionId }
        | { ok: true; revisionId: RevisionId; plan: ReturnType<typeof planPurge> }
      >(() => {
        const row = this.db
          .prepare("SELECT * FROM nodes WHERE node_id=? AND version_state='CURRENT'")
          .get(nodeIdStr(nodeId)) as NodeRow | undefined;
        if (!row) return { ok: false as const, error: 'PURGED_FINAL' as const };
        const node = this.rowToNode(row);
        if (!isVisible(a, this.scopeViewOf(node), node.sensitivity)) {
          return { ok: false as const, error: 'PERMISSION_DENIED' as const };
        }
        if (revisionIdStr(cas.expectedRevision) !== row.revision_id) {
          return {
            ok: false as const,
            error: 'CAS_CONFLICT' as const,
            currentRevision: asRevisionId(row.revision_id),
          };
        }

        const all = this.db
          .prepare(
            'SELECT revision_id, content_hash, content_ref, minimized_blob_ref FROM nodes WHERE node_id=?'
          )
          .all(row.node_id) as {
          revision_id: string;
          content_hash: string;
          content_ref: string | null;
          minimized_blob_ref: string | null;
        }[];

        // planPurge 内部完成 ①②③④（含节点/边/覆盖层/outbox 删除），此处不得重复删除
        const plan = planPurge(this.db, {
          ownerKey: ownerKeyFor(row.owner_id),
          nodeId: row.node_id,
          revisions: all.map(r => ({
            revisionId: r.revision_id,
            contentHash: r.content_hash,
            contentRef: r.content_ref,
            minimizedBlobRef: r.minimized_blob_ref,
          })),
          operator: a.agentId,
          reason: reasonCategory,
        });

        return { ok: true as const, revisionId: asRevisionId(row.revision_id), plan };
      });

      if (!phase1.ok) return phase1;

      // ── 阶段二：物理清理（事务已 COMMIT；失败不回溯逻辑删除）──
      let cleanup: PurgeCleanupStatus = {
        status: 'scheduled',
        scheduled: phase1.plan.scheduled.length,
        retained: phase1.plan.retained,
        completedNow: 0,
        failed: [],
        pendingRetry: phase1.plan.scheduled.length,
      };

      if (this.blobs && phase1.plan.scheduled.length > 0) {
        try {
          const res = await runCleanup(this.db, this.blobs, { limit: 100 });
          const failedList = res.failed.map(f => ({ ref: f.ref, error: f.error }));
          cleanup = {
            status:
              failedList.length === 0 && res.removed === res.attempted
                ? 'completed'
                : res.removed > 0
                  ? 'partial'
                  : 'scheduled',
            scheduled: phase1.plan.scheduled.length,
            retained: phase1.plan.retained,
            completedNow: res.removed,
            failed: failedList,
            pendingRetry: res.attempted - res.removed + failedList.length > 0 ? failedList.length : 0,
          };
        } catch {
          cleanup.pendingRetry = phase1.plan.scheduled.length;
        }
      }

      return {
        ok: true,
        revision_id: phase1.revisionId,
        logicalDeleted: true,
        cleanup,
      };
    } catch (e) {
      return this.asPurgeError(e);
    }
  }

  /** 对账：清理 Ledger 命中残留（节点 + 两类边 + 覆盖层 + Outbox）+ 补偿 Purge 文件删除（R3-01） */
  async reconcile(): Promise<{ fixed: number; filesRemoved: number }> {
    // ── R4-A6：补偿 Blob 清理（事务外，真实文件 I/O）──
    let blobComp: ReconcileResult = { pendingRetry: 0, filesRemoved: 0, hadPending: false };
    if (this.blobs) {
      try {
        blobComp = await reconcileBlobs(this.db, this.blobs, { limit: 100 });
      } catch {
        blobComp = { pendingRetry: 0, filesRemoved: 0, hadPending: true };
      }
    }

    const dbFixed = await this.withTx(async () => {
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

      // （Blob 文件清理已由事务外的 reconcileBlobs() 负责，此处只做数据库残留清理）
      return { fixed };
    });

    return { fixed: dbFixed.fixed, filesRemoved: blobComp.filesRemoved };
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

  private insertEdge(e: Edge, auth: AuthContext): void {
    const isSupersedes = e.type === 'supersedes';

    // R3-05：Edge 授权完整性 —— 两端必须属于当前工作空间且对当前 auth 可见，
    //          不能连到其他工作空间 / 其他 Agent 的私有 persona / annotation。
    const fromStr = String(e.from);
    const toStr = String(e.to);
    if (isSupersedes) {
      // supersedes 由 DB 触发器保证同 node_id + 序号方向；这里校验这两个 revision 都可读
      const both = this.db
        .prepare(
          `SELECT revision_id, node_id, owner_id, layer, agent_id, visibility,
                  (SELECT value FROM sensitivity_overlay so WHERE so.node_id = n.node_id) AS sensitivity_value,
                  shared_with
           FROM nodes n WHERE revision_id IN (?,?)`
        )
        .all(fromStr, toStr) as unknown as NodeRow[];
      if (both.length !== 2) throw new ForbiddenError('PERMISSION_DENIED: supersedes 边端点必须存在');
      for (const r of both) {
        const mnode = this.rowToNode(r);
        if (!isVisible(auth, this.scopeViewOf(mnode), mnode.sensitivity)) {
          throw new ForbiddenError('PERMISSION_DENIED: supersedes 边端点不在授权范围');
        }
      }
      this.db
        .prepare(
          `INSERT INTO edges(type, link_class, "from", "to", weight, created_at) VALUES(?,?,?,?,?,?)`
        )
        .run(e.type, null, fromStr, toStr, e.weight, e.created_at);
      return;
    }

    // 普通边：from/to 是 node_id —— 两端节点都必须在当前工作空间且对 auth 可见
    const nodes = this.db
      .prepare(
        `SELECT n.*, (SELECT value FROM sensitivity_overlay so WHERE so.node_id = n.node_id) AS sensitivity_value
         FROM nodes n WHERE n.node_id IN (?,?)`
      )
      .all(fromStr, toStr) as unknown as NodeRow[];
    if (nodes.length !== 2) {
      // 端点不足（DB 引用完整性也会拦），此处给出授权语义而非仅"引用缺失"
      throw new ForbiddenError('PERMISSION_DENIED: 边端点必须存在且在本工作空间内');
    }
    for (const r of nodes) {
      const mnode = this.rowToNode(r);
      if (!isVisible(auth, this.scopeViewOf(mnode), mnode.sensitivity)) {
        throw new ForbiddenError('PERMISSION_DENIED: 不能连接不可见的节点（跨工作空间或他人私有）');
      }
    }

    this.db
      .prepare(
        `INSERT INTO edges(type, link_class, "from", "to", weight, created_at) VALUES(?,?,?,?,?,?)`
      )
      .run(
        e.type,
        ((e as { link_class?: string }).link_class ?? null),
        fromStr,
        toStr,
        e.weight,
        e.created_at
      );
  }

  private insertOutbox(o: OutboxEntry, nodeId: string, nodeScope: Scope, _auth: AuthContext): void {
    // R3-05：Outbox entity_id 必须与本次写入的节点 / 其项目 / 其工作空间一致
    //（防伪造索引或资源声明的 entity，把动作挂到别的记录或项目上）
    const validEntities = new Set([nodeId, nodeScope.owner_id]);
    if (nodeScope.project_id) validEntities.add(nodeScope.project_id);
    if (!validEntities.has(o.entity_id)) {
      throw new ForbiddenError('PERMISSION_DENIED: outbox entity_id 超出本次授权写入范围');
    }
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

  private asPurgeError(e: unknown): PurgeResult {
    return this.asTxError(e) as PurgeResult;
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
