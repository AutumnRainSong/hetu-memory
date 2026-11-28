# C 组 · Minimize / Revive 并发一致性 — Provider 接入说明（R4）

> **C 组交付**：`src/storage/lifecycle-cas.ts`（纯函数）+ `tests/storage/lifecycle-*.spec.ts`。
> **本说明写给 Lead**：如何用这三个纯函数替换 `src/storage/sqlite-provider.ts` 中 `minimize`/`revive`
> 现有的最终 UPDATE。**Lead 独占修改 provider，本组不直接改文件。**

---

## 1. 问题（R4 要修的缺陷）

现状 `sqlite-provider.ts`：
- `minimize`（L352-367）：文件 I/O 读完/写归档后，最终 `UPDATE nodes ... WHERE revision_id=?`
  —— **无** `version_state` / `content_state` CAS 条件，也**不检查 affected rows**。
- `revive`（L413-422）：同样只 `WHERE revision_id=?`，无状态条件、无 ref/hash CAS、不检查 changes。

后果（并发竞态）：
1. 两连接**同时** minimize 同一 revision → 都执行那一条 UPDATE，各返回 `ok:true`
   （见 `lifecycle-concurrent.spec.ts` 对照组 —— 现状两次成功）。
2. Minimize 读行（FULL）后、最终 UPDATE 前，Supersede 把该 revision 翻成 SUPERSEDED → minimize 仍把它
   改成 MINIMIZED 并返回成功（但该版本已非 CURRENT，违反状态机）。
3. Revive 读行（MINIMIZED）后并行 Purge → revive 可能在行已删时仍返回成功 / 复活已擦除版本。

## 2. 修复目标（契约 §6）

最终状态检查必须落在**最终 UPDATE 里**，用带 CAS 条件的 UPDATE，并断言 `changes === 1`：
- 命中即提交一次成功；未命中（0 行）即 `STATE_CONFLICT`，**绝不报告成功**。
- 未命中时，文件 I/O 已产生的孤儿归档文件必须登记清理任务（`recordOrphanForCleanup`）。

## 3. 接入步骤（replace 原 UPDATE）

### 3.1 Minimize —— 替换 L352-367 的 UPDATE

**原代码**（`sqlite-provider.ts` `minimize` 事务内）：
```ts
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
```

**改成**（引入 `buildMinimizeUpdate` / `assertSingleRow` / `recordOrphanForCleanup`）：
```ts
return await this.withTx<TxResult>(() => {
  const spec = buildMinimizeUpdate({
    revisionId: row.revision_id,
    archiveRef,                      // 文件 I/O 已成功写入的归档相对引用
    archiveHash,                     // sha256(原始内容)
    stubSummary: `精简：${String(row.content_hash).slice(0, 24)}`,
  });
  const changes = this.db.prepare(spec.sql).run(...spec.params).changes;
  const verdict = assertSingleRow(changes);
  if (!verdict.ok) {
    // 孤儿登记：归档文件已在磁盘但未被任何 revision 引用，必须进清理队列，不得静默残留
    recordOrphanForCleanup(this.db, {
      ownerKey: ownerKeyFor(row.owner_id),
      blobRef: archiveRef,
      kind: 'archive',
    });
    return { ok: false, error: 'STATE_CONFLICT' }; // 见下方「错误码路由」
  }
  return { ok: true, revision_id: asRevisionId(row.revision_id) };
});
```

**字段映射**（原 → 新）：
| 原占位 | 新参数 | 说明 |
|---|---|---|
| `stub_summary` 第 1 个 `?` | `spec.params[0]`（stubSummary） | 同值：`精简：<content_hash前24>` |
| `minimized_blob_ref` 第 2 个 `?` | `spec.params[1]`（archiveRef） | 同一 `archiveRef` |
| `minimized_blob_hash` 第 3 个 `?` | `spec.params[2]`（archiveHash） | 同一 `archiveHash` |
| `WHERE revision_id=?` 第 4 个 `?` | `spec.params[3]`（revisionId） | 同一 revision_id |
| **新增** | 无 | 原 WHERE 只有 revision_id；**新 WHERE 追加 `version_state='CURRENT' AND content_state='FULL'`** |

### 3.2 Revive —— 替换 L413-422 的 UPDATE

**原代码**（`sqlite-provider.ts` `revive` 事务内）：
```ts
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
```

**改成**：
```ts
return await this.withTx<TxResult>(() => {
  const spec = buildReviveUpdate({
    revisionId: row.revision_id,
    expectedRef: row.minimized_blob_ref!,          // 读回时已验证的归档引用
    expectedHash: row.minimized_blob_hash!,        // 读回时已验证的归档哈希
    mainRef,                                       // 已恢复到主区的引用
  });
  const changes = this.db.prepare(spec.sql).run(...spec.params).changes;
  const verdict = assertSingleRow(changes);
  if (!verdict.ok) return { ok: false, error: 'STATE_CONFLICT' }; // 不误报成功
  return { ok: true, revision_id: asRevisionId(row.revision_id) };
});
```

**字段映射**：
| 原占位 | 新参数 | 说明 |
|---|---|---|
| `content_ref` 第 1 个 `?` | `spec.params[0]`（mainRef） | 同一 mainRef |
| `WHERE revision_id=?` 第 2 个 `?` | `spec.params[1]`（revisionId） | 同一 revision_id |
| **新增** 第 3、4 个 | `spec.params[2]`（expectedRef）、`spec.params[3]`（expectedHash） | 用读回时已验证的 `minimized_blob_ref`/`minimized_blob_hash` 作为 CAS 守卫 |
| **新增** | 无 | 新 WHERE 追加 `version_state='CURRENT' AND content_state='MINIMIZED' AND minimized_blob_ref=? AND minimized_blob_hash=?` |

### 3.3 孤儿登记所需 ownerKey

- 用 B 组交付的 `ownerKeyFor(row.owner_id)`（`sha256(NFC)[0:32]`），从 `blob-store.ts` 导入。
- `recordOrphanForCleanup` 在 A 组 Migration 005 的 `blob_cleanup_tasks` 表上执行
  `INSERT OR IGNORE ... VALUES(?, ?,'archive','pending')`（partial unique 索引防重复）。
- 顺序：仅在 `changes !== 1`（conflict 路径）时登记；成功路径不登记（成功即归档已被引用）。

## 4. 错误码路由（`asTxError`）

- 未命中返回的 `{ ok:false, error:'STATE_CONFLICT' }` 会经本组 `asTxError` 的
  `/STATE_CONFLICT/` 分支正确路由；无需改动（现状已在 L848 处理）。
- 若 provider 的 `TxResult` 不允许直接 `{ok:false}` return（视 Lead 现状），
  可扔一个 message 含 `STATE_CONFLICT` 的异常让 `asTxError` 捕获；效果等价。

## 5. 事务语义（并发保证）

- `withTx` 是 `BEGIN IMMEDIATE`：写锁**提交前独占**，跨连接并发时第二个 `BEGIN IMMEDIATE`
  会等待第一个 COMMIT/ROLLBACK。因此**两个连接的 minimize 最终 UPDATE 串行执行**：
  - 连接 A 先提交 → `changes===1`（成功）。
  - 连接 B 拿到锁后重跑同一 UPDATE，发现已是 MINIMIZED → `changes===0` → `STATE_CONFLICT`。
- 这正是契约 §6「最终状态检查进最终事务 + 条件 UPDATE + 检查 affected rows」的落地点。
- `buildMinimizeUpdate`/`buildReviveUpdate` 是纯函数：先组装 SQL，在事务内执行并检查 changes，
  与 provider 的具体事务包装无关，故可先由 C 组在独立文件库 + 独立连接上验证（见 CONTRACTS §6 与四条验收）。

## 6. 验收对照（执行计划 §6.1 C 组四条）

| # | 验收 | 本交付证据 |
|---|---|---|
| C-1 | CAS 条件 UPDATE + `changes===1` | `buildMinimizeUpdate`/`buildReviveUpdate`/`assertSingleRow` 纯函数 + `lifecycle-cas-unit.spec.ts` |
| C-2 | 跨连接并发单向成功 | `lifecycle-concurrent.spec.ts`（两独立 Provider 共一个文件库，`BEGIN IMMEDIATE`+CAS，断言恰好 1 成功 1 STATE_CONFLICT） |
| C-3 | 孤儿登记 | `recordOrphanForCleanup` + `lifecycle-orphan.spec.ts`（conflict 时登记清理任务、幂等） |
| C-4 | SUPERSEDED 不得 Revive | `lifecycle-cross.spec.ts`（已 SUPERSEDED → INVALID_STATE；已 Purge → PURGED_FINAL；Min×Sup 只一个成功） |

## 7. 备注 / 风险

- `buildReviveUpdate` 把「当前状态 + 归档 ref/hash 一致」同时作为 CAS，防止 Revive 复活已被
  Purge/替换的归档（`content_ref=COALESCE(content_ref,?)` 保留已有主区引用语义不变）。
- 孤儿登记依赖 A 组 `blob_cleanup_tasks`；若 A 未交付，provider 接入前需保证 005 已建表，
  否则 `recordOrphanForCleanup` 会因缺表抛错（C 组测试内已按契约 DDL 自行建表规避）。
- 本组未修改 `sqlite-provider.ts` / `types.ts` / `blob-store.ts`；所有变更均在新文件与文档内。