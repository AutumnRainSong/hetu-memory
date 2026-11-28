# Review R2 · 独立验收报告

> 审查基线：`fix/review-r1` @ `264fd0cc`
> 修订分支：`fix/review-r2` @ `d7674f81`
> 验收性质：《M1-B Review R2 定点修订任务书》P0-A / P0-B / P0-C / P1-D / P1-E / P1-F / P1-G / P1-H 逐项验收
> 验收原则：**通过真实 Provider 调用证明行为**，不接受仅凭测试代码直写 SQL 或字段级断言

---

## 一、总结论

| 任务 | 结论 | 关键证据 |
|---|---|---|
| **P0-A** 读取授权无绕过路径 | ✅ 闭环 | get 强制 AuthContext；shared_list 白名单真正执行；Sensitivity SQL 前置硬过滤 |
| **P0-B** 写入与生命周期授权 | ✅ 闭环 | 能力位校验；跨 owner/agent/project 拒绝；Purge 记录真实操作者 |
| **P0-C** Minimize/Revive 真实内容链路 | ✅ 闭环 | 真实字节级归档与恢复；路径逃逸防护；DB 约束 MINIMIZED 完整性 |
| **P1-D** Dry Run 端到端 | ✅ 闭环 | Runner 最外层拦截，**真正全新空库零建表** |
| **P1-E** Migration 003 历史数据保护 | ✅ 闭环 | 悬空边中止并报清单，不再静默 DELETE；persona 收紧留审计记录 |
| **P1-F** Edge 完整语义 | ✅ 闭环 | UPDATE 触发器；supersedes 同 node_id + 序号方向 |
| **P1-G** Purge 对账完整性 | ✅ 闭环 | 节点/两类边/覆盖层/Outbox 全部清理 |
| **P1-H** 主规格 v1.5 完整同步 | ✅ 闭环 | §0 旧结论显式取代；新增 §1.3 授权模型 |

**测试总量：13 个测试文件 / 153 项测试全绿**（R1 的 126 → 153，+27 项，**未降低任何既有断言**）。

---

## 二、P0-A · 读取授权无绕过路径

**审查指出的三个漏洞与修复**：

### 漏洞 1：`get()` 的 AuthContext 可选

**修复**：`get(ref, auth, opts?)` — `auth` 不再是可选参数。内部无授权读取拆为显式命名的
`unsafeInternalGet()`，并在 SPI 注释标注"不暴露给服务层以上任何调用者"。
`assertValidAuth()` 还会校验 `ownerId` / `agentId` / `projectIds` / `maxSensitivity` / `capabilities` 五项完整性——任一缺失即 `AUTH_CONTEXT_REQUIRED`。

**测试**：`未提供 AuthContext 的 get → 抛 AUTH_CONTEXT_REQUIRED`；`auth 缺 maxSensitivity → 视为不可信上下文`。

### 漏洞 2：`visibility=shared_list` 没有执行

**修复**：`isVisible()` 统一规则中 `shared_list` 必须 `scope.shared_with.includes(auth.agentId)`；
`query()` 在 SQL 层用 `json_each` 子查询同样执行该条件。`get` 与 `query` **共用同一套可见性函数**，避免规则漂移。

**关键测试**：`同项目成员但不在 shared_with → 不可见（项目成员≠白名单成员）` —— 这正是审查举的 Agent C 场景。

### 漏洞 3：Sensitivity 硬过滤未接入

**修复**：`query()` 的 SQL 中 `LEFT JOIN sensitivity_overlay` 并用 `CASE` 映射等级数值，
`(等级值 <= auth.maxSensitivity 等级值)` 作为 **WHERE 条件**（进候选集之前过滤，非排序因子）。
`get()` 走 `isVisible()` 的 `withinSensitivity()`。

**测试**：`restricted 对 normal 不可见 / 对 restricted 可见`；`sensitive 对 normal 不可见 / 对 sensitive 可见`。

### 其它

- `canReadGlobal=false` → 读不到 global 层 ✅
- 非项目成员读不到该项目 ✅
- 跨 owner 绝对隔离（且 `get` 返回 `null` 而非报错，**不泄漏存在性**）✅

---

## 三、P0-B · 写入与生命周期授权

**修复**：

| 操作 | 要求 |
|---|---|
| `put` / `putWithRevision` | `memory:write`；`owner_id === auth.ownerId`；persona/annotation 的 `agent_id === auth.agentId`；project 必须是成员；敏感级不得超上限 |
| `supersede`（带 cas） | 额外需 `memory:supersede` |
| `minimize` | `memory:minimize` + 目标可见 |
| `revive` | `memory:revive` + 目标可见 |
| `purge` | `memory:purge` + 目标可见；`purge_ledger.operator = auth.agentId`（**不再硬编码 'provider'**） |

**有序失败语义**：授权检查在事务外先做，失败不进入事务。

**测试（8 项）**：无 write 能力拒绝 / 跨工作空间拒绝 / 写别人 persona 拒绝 / 非成员写项目拒绝 /
supersede 缺能力拒绝 / purge 缺能力拒绝且**有能力时 Ledger 记录 `agent-a`**。

**能力边界声明**（写入本报告与 README）：

> `AuthContext` 目前是**类型契约**，Token 解析、会话绑定、项目成员关系查询属 **M1-C**。
> 在此之前，底层写接口（`put` / `minimize` / `revive` / `purge`）**只能由受信任的服务层调用**，
> **禁止直接暴露给 Agent 或 MCP 工具**。存储层保证"上下文不完整即拒绝"，但不自行验证签名。

---

## 四、P0-C · Minimize / Revive 真实内容链路

**审查指出的问题**：`writeArchive` 要求调用方预先写好文件；Revive 只改状态不恢复内容；`join()` 无路径逃逸防护。

**修复**（新增 `src/storage/blob-store.ts`）：

**Minimize 真实链路**（`minimize(nodeId, auth, cas)`，参数由 revisionId 改为 nodeId 以定位当前链尾）：
1. 读取主区 Blob（`content_ref`）
2. 校验 `sha256(original) === content_hash` —— 证明归档的是**这条记忆的真实内容**
3. 写入归档区 `archive/<nodeId>/<revisionId>.txt`
4. `assertInsideRoot()` + `readVerified()` —— 归档文件真实存在且 Hash 一致
5. **只有以上全部成功**才开事务改 `content_state='MINIMIZED'`

**Revive 真实链路**：
1. `assertInsideRoot()` + `readVerified(minimized_blob_ref, minimized_blob_hash)` —— 读回归档并校验
2. **再次校验** `sha256(content) === content_hash` —— 证明恢复的是同一条记忆
3. 写回主区 `blobs/<hash前缀>/<hash>`
4. 校验写回 Hash 一致
5. **全部成功后才**改 `content_state='FULL'` 并清空 `minimized_*`

**测试是字节级而非字段级**：
- Minimize 后从归档文件读回的字符串**与原内容逐字节相等**
- Revive 测试先**删除主区文件**再 revive，随后从主区读回的字节**与原内容相等**，且 `sha256(restored) === 原 hash`
- 归档文件被删 → Revive 失败且 `content_state` **仍是 MINIMIZED**
- 归档内容被篡改 → Revive 失败（Hash 校验生效）

**路径逃逸防护**（`BlobStore.resolve`）：
- 拒绝绝对路径（`isAbsolute`）
- 拒绝 `../` 与 `/../`
- `relative(root, abs)` 结果不得以 `..` 开头
- `assertInsideRoot()` 用 `realpath` 防**符号链接逃逸**
- `archiveRefFor` 的字符集收敛为 `[A-Za-z0-9_-]`，点号一律替换（防止 `..` 构成路径段）

**测试**：`../etc/passwd` 拒绝 / `archive/../../escape.txt` 拒绝 / `/etc/passwd` 拒绝 /
`..\\..\\evil.txt` 拒绝 / 合法引用允许 / 含路径字符的 node_id 被安全化。

**DB 约束**（Migration 003）：`CHECK (content_state <> 'MINIMIZED' OR (minimized_blob_ref IS NOT NULL AND minimized_blob_hash IS NOT NULL))`

---

## 五、P1-D · Dry Run 端到端

**审查指出的盲区**：`ensureMetaTable()` 先执行，真正空库时 Migration 001 会先跑完。

**修复**：`runMigrations()` 的**最外层第一步**判断 `opts.dryRun`，直接返回 `DryRunReport` 对象
（不再抛异常，调用方可结构化读取），**在 `ensureMetaTable` 之前**。

**报告内容**：是否全新空库 / 已应用版本 / 待应用版本 / 记录数 / 显式映射条数 / 未映射清单 /
superseded_by 待转换数（含歧义与悬空） / 旧 owner 是否提供 / 文本摘要。

**关键测试**：`完全空库（无 nodes、无 schema_migrations）+ dryRun → 不建任何表`
—— 断言执行前后 `sqlite_master` 的 table 列表**都是空数组**，且 `pendingVersions === [1,2,3]`。

**类型声明**：`MigrationOptions` 正式声明 `legacyOwnerId` / `legacyScopeManifest` / `acceptDefaultScopeMapping` / `dryRun` / `target`，TypeScript 调用方类型安全。

**CLI**：`node src/storage/migrate.ts --dry-run` 输出报告。

---

## 六、P1-E · Migration 003 历史数据保护

**审查指出**：`DELETE FROM edges WHERE ...` 静默删除悬空边。

**修复**：
- 迁移**开始前**统计悬空边（分普通边与 supersedes 边两类）
- 存在即 `MIGRATION_ABORTED`，列出受影响记录（最多 50 条），**不再删除**
- persona/annotation 可见性收紧是**可判定自动修复**，但**记录修复依据**到 `migration_reports` 表（版本号 + kind + 明细 JSON）

**保留**：`MINIMIZED` 归档完整性 CHECK、`UPDATE` 触发器防放松。

---

## 七、P1-F · Edge 完整语义

**审查指出的缺口**：只有 INSERT 检查，无 UPDATE；supersedes 无同 node_id 与序号方向校验。

**修复**（Migration 003 共 7 个边触发器）：

| 触发器 | 约束 |
|---|---|
| `trg_edges_node_ref_ins` / `_upd` | 普通边端点必须是已存在 node_id（INSERT + UPDATE） |
| `trg_edges_revision_ref_ins` / `_upd` | supersedes 端点必须是已存在 revision_id（INSERT + UPDATE） |
| `trg_edges_supersedes_same_memory_ins` / `_upd` | supersedes 两端必须同 node_id **且** `from.revision_sequence > to.revision_sequence` |
| `trg_edges_no_silent_replace` | 重复边拒绝覆盖 |

**测试**：跨逻辑记忆 supersedes 拒绝 / 序号方向错误拒绝 / 普通边指向 ghost node 拒绝。

---

## 八、P1-G · Purge 对账完整性

**审查指出**：`reconcile()` 只删节点，残留边与覆盖层。

**修复**：`reconcile()` 现在对每个 Ledger 命中的 node_id 依次清理：
1. 普通边（按 node_id）
2. supersedes 边（按该记忆的全部 revision_id）
3. `sensitivity_overlay`
4. `outbox`（entity_id）
5. 节点本身

并在最后做**全库孤儿清扫**：端点不存在的两类边、无节点的覆盖层。

**测试**：模拟崩溃残留（Ledger 有记录但节点/边/覆盖层/Outbox 都还在）→ reconcile 后**四类残留计数全为 0**。

**范围声明**：本报告与 README 均标注 —— 真正的**跨设备物理擦除**需 Blob + 索引 + Marker 协同，属 M4；当前不宣称"完整全链物理擦除"。

---

## 九、P1-H · 主规格 v1.5 完整同步

| 位置 | 变更 |
|---|---|
| 顶部 ADR | v1.5 变更声明（保留） |
| §0「明确不做（MVP）」 | `多用户（owner_id 预留）` → **显式标注被 v1.5 取代**，说明仍不做的范围（跨组织/跨租户/互联网全局共享） |
| 架构图扩展层 | 移除"多用户 owner_id"，保留跨设备同步/云托管为延后项 |
| **新增 §1.3** | 授权模型与敏感级过滤：身份/边界概念表、AuthContext 字段、五条可见性规则、写权限位、能力边界（Token 验证属 M1-C） |

---

## 十、端到端数据安全测试（大师特别要求）

新增 `tests/e2e/multi-agent-security.spec.ts` —— **17 项**，使用 **4 个不同 AuthContext** 对同一批记忆做读/写/改/删：

| 身份 | 特征 |
|---|---|
| Agent A | `ws-acme` / proj-apollo 成员 / 全能力 / restricted 上限 |
| Agent B | `ws-acme` / proj-apollo 成员 / 无 purge / normal 上限 |
| Agent C | `ws-acme` / **非** proj-apollo 成员 |
| Agent D | **ws-other** 工作空间（项目名相同也不通） |

**覆盖矩阵**：

| 场景 | A | B | C | D |
|---|---|---|---|---|
| 读 project_agents 记忆 | ✅ | ✅ | ❌ | ❌ |
| 读 shared_list（只列 A） | ✅ | ❌ | ❌ | ❌ |
| 读 restricted 记忆 | ✅ | ❌ | — | — |
| 读 A 的 persona / 注解 | ✅ | ❌ | ❌ | ❌ |
| 替 A 写 persona | — | ❌ | — | — |
| 写入新项目记忆 | ✅ | ✅ | ❌ | ❌ |
| supersede | ✅ | ✅ | ❌ | — |
| purge | ✅ | ❌ | — | — |
| purge 后所有人读不到 | — | ✅ | — | — |

另有 `跨会话召回一致性`：同一身份连续三次查询结果稳定，且不含他人私有内容。

---

## 十一、遗留与明确边界

| 项 | 归属 | 说明 |
|---|---|---|
| Token 解析 / 会话绑定 / 成员关系查询 | **M1-C** | AuthContext 现为类型契约，由服务层构造 |
| 主区 Blob GC 策略 | **M2** | Minimize 保留主区文件，由 M2 决定清理时机 |
| 跨设备防复活 / 物理擦除 | **M4** | 需 Blob + 索引 + Marker 协同 |
| Proposal / 讨论 / 裁决 | **M4** | 不属本轮 |
| main 分支保护 | 仓库设置 | 需人工在 Settings → Branches 开启（工具无权限） |
| PR 创建 | 需用户操作 | token 缺 `pull_requests` 写权限（403） |

---

## 十二、验收判定

《M1-B Review R2 定点修订任务书》八项任务（P0-A/B/C + P1-D/E/F/G/H）**全部闭环**：

- [x] 不带 AuthContext 的 get/query 拒绝测试
- [x] shared_list 越权访问测试（项目成员 ≠ 白名单成员）
- [x] Sensitivity 硬过滤测试（SQL 前置，非排序因子）
- [x] 无权写入、修改、Purge 测试（含 Ledger 真实操作者）
- [x] Minimize / Revive **原始字节**恢复测试（先删主区文件再恢复）
- [x] 路径逃逸拒绝测试（`../`、绝对路径、反斜杠、符号链接）
- [x] 全新数据库 Dry Run **零建表**测试
- [x] Migration 003 悬空边中止（不再静默删除）+ persona 收紧审计
- [x] Supersedes DB 端语义测试（同 node_id + 序号方向 + UPDATE）
- [x] Purge reconcile 无悬空边（四类残留清零）
- [x] CI 全绿（lint + build + typecheck + test + audit 0 漏洞）
- [x] 架构说明更新（主规格 v1.5 §0 + §1.3 + ADR）

**结论：Review R2 满足合并门禁。R2 通过前不合并 main、不启动 M1-C —— 本轮严格遵守此约束（全部修订在 `fix/review-r2` 分支）。**

---

**报告生成**：2026-11-27 · `docs/QA-ACCEPTANCE-REVIEW-R2.md`
**签署**：待技术负责人复核 · QA 确认 · 产品负责人审查
