# 河图 HeTu · 通用 Agent 记忆模块 —— 架构规格 v1.5（定稿）
## 变更记录（ADR）

| 版本 | 日期 | 变更 | 影响范围 |
|---|---|---|---|
| **v1.5** | 2026-11-26 | **多 Agent 工作空间共享模型正式化**：① `owner_id` 正式定义为**工作空间边界**（一个用户/组织），不是 Agent ID；② 新增 `AuthContext`（ownerId / agentId / projectIds / canReadGlobal）作为查询的**强制授权上下文**，缺失即失败关闭（`PERMISSION_DENIED`）；③ `agent_persona` 与 `private_annotation` **强制 `visibility='owner'`**（DB CHECK + UPDATE 触发器双重保证，业务代码不可绕过）；④ 边引用完整性下沉 DB 触发器（普通边端点=node_id，supersedes 端点=revision_id，重复边拒绝覆盖） | 与 v1.4「多用户暂不实现、owner_id 仅预留」的表述不同。工作空间共享已进入实现基线。Proposal / Discussion / Decision 协作机制仍属 M4 |
| v1.4 | 2026-11-23 | 收敛定稿（双维度状态机、删除三操作、Purge Ledger、权限前置硬过滤、五类归属、Embedding Worker、候选预算、性能标准） | — |

> 设计修订遵循"不静默改变旧结论"：上表 v1.5 是对 v1.4 的**显式修订**，v1.4 原文保留可追溯。



> **名实**：系统 **河图 HeTu**（"河出图"——龙马负出的那张最早的图，点即节点、位势即边）
> **版本**：v1.5（唯一工程基线；v1.5 相对 v1.4 的修订见上方 ADR）· 2026-11-23 · 10 轮审查协商闭环（红队×4 / 复核×1 / 致命专项×1 / 外部评审×2 / 工程协商×2 / 收敛终审×1）
> 收敛依据：docs/reviews/hetu-v1-convergence-analysis.md 与 docs/reviews/convergence-v15-report.md（五项专项：P0-1/P0-2/P0-3/P1-4/P1-5）
> **状态**：设计冻结。本版本为团队实现的唯一依据；此后设计变更一律走"提案 → 用户/评审确认 → 文档先行 → 代码跟进"。
> **配套**：洛书 Luoshu 交换格式（第 7 节）· continue_bro.md（AI 结对入职）· 执行者.md（团队画像）

---

## 0. 定位与边界

- **定位**：跨框架通用记忆层——任何 agent 框架（Claude Code / Cursor / DSH / 自研）均可接入，一份记忆处处可用
- **理念**：本地优先、数据归用户（洛书开放格式）；记忆是活的图谱；**内容用户掌生杀权，系统掌结构整理权**
- **明确不做（MVP）**：跨设备同步 / 云托管 / 具身实现（JSON 扩展位）/ 内置大模型
  - ~~多用户（owner_id 预留）~~ → **v1.5 修订**：`owner_id` 已正式定义为**工作空间边界**，多 Agent 共享同一工作空间已进入实现基线（见上方 ADR 与 §1.3）。仍不做：跨组织 / 跨租户 / 互联网范围的全局共享
- **P2 延后项（设计已留接口，不进本轮）**：图谱扩散 / 边衰减 GC / LLM 消歧 / 反思 SCHEDULED 模式 / 实体自动合并 / 多租户

---

## 1. 四层架构

```
┌ 接入层 ────────────────────────────────────────────────┐
│ MCP Server（薄壳：记/忆/忘/察 + introspect）             │
│ REST API（自研 agent / 管理面板 —— 独立鉴权域，           │
│           agent token 永不授管理 scope）                  │
│ 鉴权：服务端分配 agent_id / token↔id 焊死 / 短 TTL /      │
│       吊销列表即时生效（每工具调用入口检查）/ 失败锁定      │
├ 服务层（HTTP 底座，MCP 仅为协议翻译）────────────────────┤
│ 记忆装配器（唯一预算分配器；persona 带 floor、可 pin）     │
│ 召回引擎（权限前置硬过滤 → 双路检索 → RRF 合并 → 复核注入） │
│ 消歧裁决（高分直取 / 低置信反问；LLM 消歧 P2）             │
│ 写入闸门（if-chain 决策；授权映射到意图而非工具）           │
│ 合并器（只出 Proposal 走宿主确认流；可回放）                │
│ Proposal 队列（同逻辑记忆 FIFO + 两阶段确认 + 无长锁）      │
│ 统一 Writer 队列 + Outbox 异步索引更新                     │
├ 存储层（Storage SPI 六原语）────────────────────────────┤
│ get / put / query / graph-traverse / vector-search / blob │
│ MVP：SQLite(WAL + Writer 队列) + 持久化 HNSW               │
│   索引 Manifest 校验；重建仅损坏兜底（后台重建+原子切换）    │
│   链尾唯一性：存储层条件写 + 确定性 tie-break               │
│   graph-traverse 契约：hub 抑制 / 扩散预算 / 超时降级       │
├ 扩展层（预留接口，不实现）───────────────────────────────┤
│ 具身（JSON 扩展位）/ 跨设备同步 / 云托管                    │
└────────────────────────────────────────────────────────┘

### 1.3 授权模型与敏感级过滤（v1.5 新增，替代 v1.4 的 owner_id 预留说明）

**身份与边界**

| 概念 | 含义 | 不是什么 |
|---|---|---|
| `owner_id` | 工作空间边界（一个用户或一个组织） | **不是** Agent ID，不是单个记忆的创建者 |
| `agent_id` | 人格 / 私有注解的归属对象 | 不是权限边界 |
| `project_id` | 项目共享空间 | 不是用户私有空间 |
| `provenance.agent_id` | 内容的实际贡献者（审计） | 不代表当前请求身份 |

**AuthContext**（由经 Token 验证的服务层构造，存储层只接受不推断）

```
ownerId         工作空间边界
agentId         当前 Agent 身份
projectIds      经可信成员关系验证的项目集
canReadGlobal   是否可读工作空间 global 层
maxSensitivity  可读敏感级上限
capabilities    写能力位（write/supersede/minimize/revive/purge）
```

**可见性规则**（`get` 与 `query` 共用同一套 `isVisible()`）

1. **工作空间：** `scope.owner_id` 必须等于 `auth.ownerId`（绝对隔离）
2. **敏感级硬过滤：** `sensitivity_overlay` 值超出 `maxSensitivity` 即不进入候选（SQL 层完成，**不是排序因子**）
3. **层可见性：**
   - `user_identity` → 当前工作空间内可见
   - `project` → `project_id ∈ auth.projectIds`（成员关系验证，非客户端自述）
   - `global` → 需 `canReadGlobal`
   - `agent_persona` / `private_annotation` → 仅 `agent_id === auth.agentId`
4. **visibility 语义：**
   - `owner` / `project_agents` / `all_agents`：按层规则已约束
   - `shared_list`：**必须** `shared_with.includes(auth.agentId)`（项目成员 ≠ 白名单成员）
5. **不可见 = 不存在：** `get` 返回 `null`，`query` 不返回该条，不泄露存在性

**写权限：** `put` / `minimize` / `revive` / `purge` 分别需 `memory:write` / `memory:minimize` / `memory:revive` / `memory:purge` 能力位；写入 `owner_id` / `agent_id` 必须与 `auth` 一致；`purge_ledger.operator` 记录**真实操作者**。

**能力边界**：`AuthContext` 的 Token 解析、会话绑定与项目成员关系查询属 **M1-C**；存储层强制要求上下文完整且不可绕过，但不自行验证签名。

### 1.1 Storage SPI 事务与原子性契约（收敛 P0-3 补充）

六原语之上的**一致性规则**（跨进程有效，不依赖应用内队列/锁）：

```ts
// 事务块：Node+Revision+Edge+Outbox 同一 SQLite 事务原子提交
interface StorageTx {
  putWithRevision(node: ImmutableNode, edges: Edge[], outbox: OutboxEntry[],
                  cas?: { expectedRevision: RevisionId }): Promise<TxResult>;
  minimize(id: NodeId, archive: BlobHandle, cas: Cas): Promise<TxResult>;   // 归档写+主区引用改，单事务
  purge(id: NodeId): Promise<TxResult>;                                     // Ledger 先行（提交点）→ 级联删除；崩溃后启动对账补删
  revive(id: NodeId): Promise<TxResult>;                                    // TOMBSTONE→FULL，校验归档 hash
}
```

- **CAS 失败语义**：返回 `{ok:false, error:'CAS_CONFLICT', currentRevision}`，调用方重读最新状态重新决策（不重放旧操作）
- **幂等键**：Outbox 条目 (kind, entity_id, seq) 唯一约束在 DB 内，消费端按键去重
- **Outbox 原子性**：Outbox 条目与业务数据在同一事务写入（无独立"先写后通知"窗口）
- **Purge Ledger**：独立表；purge() 事务 = Ledger insert（提交点）→ 级联删除；崩溃后启动对账"Ledger 有而节点表有 → 补删"
- **Minimize 一致性**：先写归档 blob → 单事务内改 content_state 与 minimized_blob_ref → 主区 blob 延迟 GC；启动对账修复半途状态
- **多进程**：SQLite WAL + busy_timeout + Writer 队列（单写者进程）+ 存储层条件写；不变量全部由 DB 约束承载

Embedding Worker（独立常驻进程）：查询向量缓存 / 批量计算 / 模型
版本管理 / 维度校验；模型升级 = 旧向量标记版本 → 后台重算 → 原子切换
```

---

## 2. 数据模型

### 2.1 五类记忆归属

| 归属类 | 属主 | 示例 |
|---|---|---|
| User Identity | 用户 | 长期身份、偏好、事实 |
| Agent Persona | agent（用户授予） | 工作习惯、角色设定 |
| Global Memory | 用户（授权共享） | 跨 agent 共享记忆 |
| Project Memory | 项目 | 项目内事实与决策 |
| Private Annotation | 单个 agent | 私有解读 |

每节点独立判归属与可见性；权限不依赖导出文件 scope 声明。

### 2.2 记忆节点（不可变）

字段：content blob 引用 · modality · 置信度 · **provenance**（agent 身份 / origin（session-digest|hot-path|reflection）/ method / source_refs / producer_version / generated_at / confidence）· **双时间轴**（valid_from/until + ingested_at）· superseded_by。

**sensitivity = 独立可变覆盖层**（键=node_id，单独记审计）——节点内容不可变与整链降级由此兼容。召回**硬过滤前置**读覆盖层；**链上最高继承**（只升不降，用户面板整链降级为唯一降级通道+审计）；**边级应用**（edge 继承端点高者）。

### 2.3 双维度状态机（正交组合）

| 维度 | 状态 |
|---|---|
| 版本 | CURRENT / SUPERSEDED |
| 内容 | FULL / STUB / **MINIMIZED** / TOMBSTONE / PURGED |

> PURGED 不是节点行上的字段，而是独立擦除账本（Purge Ledger）中的记录——节点物理不存在；状态机保留 PURGED 仅作导入兼容的概念终态（详见 §3.3）。MINIMIZED 为受控归档态（§3.1 收敛 P0-1）。`SUPERSEDED × {MINIMIZED, TOMBSTONE, PURGED}` 为不可达非法组合（历史随链尾级联）。

历史版本可 FULL（时间回溯需要）也可被 Minimize/Forget——两维独立演化。

### 2.4 边（四类，容量与策略分立）

| 类型 | 容量 | 满额策略 |
|---|---|---|
| 共现边 | top-K（默认 32） | **确定性淘汰**：score = f(cooccurrence_count 单会话去重, distinct_session_count, last_reinforced_at 衰减项)，纯函数可测；并列淘汰 created_at 较旧者；Writer 队列串行；审计记原因+评分+触发新边；可从 RAW 重建 |
| 显式 Link | 独立存量 ≤20（初始参数） | **三分**：pinned 不淘汰 / explicit 满额拒绝新增+告知容量 / inferred 确定性淘汰。跨类型互不挤占 |
| Supersede 边 | 链长上限 | 触顶走历史归档或可追溯链压缩，**绝不破坏版本历史** |
| Annotation 边 | 配额治理（§6.1） | 宿主 PURGED 联动清理 |

**扩散吸收边界**：TOMBSTONE/PURGED 为图扩散吸收边界；sensitivity 边级继承。

---

## 3. 生命周期与行为矩阵

### 3.1 删除三操作

| 操作 | 语义 | 普通 recall |
|---|---|---|
| Minimize 精简 | 原文移入**受控归档区**（移出检索面，物理保留）；摘要与关联保留 | 可见（摘要）；原文仅历史接口可达 |
| Forget 删除 | 软删除 → TOMBSTONE | **完全不可见** |
| Purge 擦除 | 清理受控存储+全部派生数据 | 物理消失 |

STUB 历史仅经独立历史查询接口（显式授权）访问。

**Minimize 可逆性（收敛 P0-1）**：采用受控归档方案——原文移入归档区（主索引/FTS/HNSW/recall 全部移除引用，归档区独立配额不计入 RAW 500MB），Revive 从归档取回原文校验 content_hash 后内容态回 FULL；归档缺失/哈希不匹配 → 降级恢复到摘要级并报 `ARCHIVE_MISSING`（不静默）。Purge(MINIMIZED) 必须级联擦除归档区原文——Purge 与 Minimize 边界闭合。崩溃对账：先写归档、后删主区、再改状态；启动对账修复半途状态。Minimize 的产品语义 = "从可见性中移除原文"，**不承诺物理删除**（需物理删除走 Forget/Purge），UI 明示。

**内容轴新增第 5 状态 MINIMIZED**（收敛 P0-1/P0-2）：STUB 变体升级为独立状态；`SUPERSEDED × {TOMBSTONE, PURGED, MINIMIZED}` 为**不可达非法组合**（Forget/Purge 优先于 supersede：对历史版本单独删除拒绝 `STATE_CONFLICT`，链上历史随链尾级联；对链尾 Purge 即整链逐节点入账本）。

### 3.2 行为矩阵（2 版本 × 5 内容 = 10 组合，其中 3 组不可达；表驱动测试不过不合并）

完整矩阵（操作 × 状态组合，ALLOW/错误码/迁移；YAML 表驱动夹具即测试数据，禁止测试代码内联期望值）：

| 状态\操作 | remember | recall | introspect | Minimize | Forget | Purge | Revive | supersede(作为源) |
|---|---|---|---|---|---|---|---|---|
| CURRENT/FULL | W（闸门四操作） | ✅ | ✅ 全字段 | →MINIMIZED | →TOMBSTONE | →账本+节点物理删 | `INVALID_STATE` | ✅（源转 SUPERSEDED） |
| CURRENT/STUB | `STUB_IMMUTABLE`（提示走新 remember） | ✅ 仅摘要 | ✅ | →MINIMIZED | →TOMBSTONE | →账本删 | `INVALID_STATE` | ✅ |
| CURRENT/TOMBSTONE | `STATE_CONFLICT`（复活走 Revive） | ❌ 不可见 | ✅ 仅元数据 | `STATE_CONFLICT` | 幂等 | ✅（终态清理） | →FULL（原文在）/`ARCHIVE_MISSING` 降级 | `STATE_CONFLICT` |
| CURRENT/PURGED | `PURGED_FINAL` | ❌ | ✅ 仅 Marker 元数据 | N/A | N/A | 幂等 | `PURGED_FINAL` | N/A |
| CURRENT/MINIMIZED | `STATE_CONFLICT` | ✅ 仅摘要（标 minimized） | ✅ | 幂等 | ✅（级联删归档） | ✅（级联删归档） | →FULL | ✅ |
| SUPERSEDED/FULL | `STATE_CONFLICT` | ❌（显式链查询除外） | ✅ | `STATE_CONFLICT` | `STATE_CONFLICT`（随链尾级联） | `STATE_CONFLICT` | `STATE_CONFLICT` | ❌（已被替代） |
| SUPERSEDED/STUB | `STATE_CONFLICT` | ❌ | ✅ | `STATE_CONFLICT` | `STATE_CONFLICT` | `STATE_CONFLICT` | `STATE_CONFLICT` | ❌ |
| SUPERSEDED/TOMBSTONE · SUPERSEDED/PURGED · SUPERSEDED/MINIMIZED | 不可达 N/A（属性测试证明无操作序列可达） | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

**矩阵单元统计（统一口径）**：2 版本 × 5 内容 = **10 组合**；其中 3 组不可达（SUPERSEDED × 删除/归档态）。**80 个矩阵单元 = 56 个可达行为测试格 + 24 个不可达组合证明格**。56 格执行行为测试，24 格执行"无操作序列可达"属性证明。操作全集 = 8 个（remember/recall/introspect/Minimize/Forget/Purge/Revive/supersede）；reinforce/annotate/link 遵循"仅作用于可读写内容态"的同构规则，不单独成列（其前置条件在 B 包工作内定义）。

错误码：`STATE_CONFLICT`（状态不允许）/ `PURGED_FINAL`（永久擦除）/ `STUB_IMMUTABLE` / `ARCHIVE_MISSING`（归档丢失，恢复降级）/ `INVALID_STATE`（操作对该状态无意义）/ `QUOTA_HARD_LIMIT` / `PERMISSION_DENIED` / `WRITE_PAUSED`（背压，P1-4）/ `MARKER_CONFLICT`（导入遇 Marker 同 id 内容）。

### 3.3 Purge Ledger（擦除账本）与防复活（收敛 P0-3：采用账本方案，PURGED 非库内状态）

**PURGED 不是节点行上的字段，而是独立擦除账本（Purge Ledger，append-only）中的记录**；Purge 后原始节点物理不存在（行/revision/边/FTS/HNSW/blob 全部级联删除）。

- **Ledger 条目（最小信息，不含正文/摘要/embedding）**：`purge_seq（全局单调）, node_id, content_hash, operator, timestamp, reason_category`。content_hash 是防复活关键（换 id 重建也按 hash 拦截）；导出携带版脱敏（去 operator）。
- **两阶段 Purge**：先写 Ledger（提交点）→ 后级联删除；崩溃后启动对账（Ledger 有而节点表有 → 补删），任何崩溃序列不产生"内容已删无 Marker"或"Marker 无但内容在"以外的中间态。
- **Marker 与节点状态关系**：Purge Marker = Ledger 条目的导出投影，是已 Purge 内容的唯一残迹。
- **防复活五通道**：①导入 Ledger 优先于一切内容（同 id 或同 content_hash 命中 → `MARKER_CONFLICT` 拒绝）②Purge 时 blob 立即删除 + GC 引用计数兜底孤儿 ③FTS/HNSW Purge 事务内同步删 + 启动对账（索引 id 不在节点表 → 删）④备份内嵌 Ledger 快照，恢复后合并取 purge_seq 并集，命中的旧节点恢复时即物理丢弃 ⑤缓存键含 revision_id，节点删后失效事件+TTL 上限封顶。
- **避免防复活长期保留敏感信息**：Ledger 仅含不可逆标识；P2 `purge_ledger_compact`（超期无冲突风险条目脱敏为 {purge_seq, timestamp, reason_category}）；数据模型已预留。
- **边界声明**：完全离线长期未同步的备份无法远程撤销——产品文档明示。

### 3.4 宿主状态迁移 × 注解联动

SUPERSEDED 注解原位；Minimize/Forget 跟随内容状态；Purge 先墓碑再联动清理；agent revoked 注解+persona 整体处置（默认 tombstone，可选归档），清理主体=服务端 GC。

### 3.5 生命周期分层（结绳→竹简→河图→本相）

| 层 | 策略 |
|---|---|
| 结绳 RAW | FIFO，TTL 7-30 天，配额 500MB；到期摘要**新建节点**内联（provenance 标 source_expired；系统摘要不计入独立来源） |
| 竹简 情节 | 引用升权 |
| 河图 语义/本相 人格 | 多次独立来源=不同会话；人格候选→确认两段式可回滚 |
| 归档遗忘 | conflict 仅数值/日期/显式否定保守触发，**绝不自动改写** |

---

## 4. 写入管线（六步）

归属路由（五类）→ 质量闸门 → 原子化抽取 → 四操作决策（ADD/UPDATE/DELETE/MERGE_INTO，按意图集授权）→ 建边（实体解析=别名表+显式确认合并，可逆+日志）→ 落盘（append-only；**单事务只做 DB 写**，Embedding/HNSW/图谱/权重刷新全走 Outbox）。

### 4.1 后台三层（架构共识）

| 层 | 内容 | MVP 策略 |
|---|---|---|
| Data Integrity | Raw Event Capture、事务、权限、删除、备份、版本一致性 | 必须可靠运行 |
| Memory Processing | **Session Digest（默认 ON）**、确定性抽取、Embedding、索引维护 | 有界运行 |
| Memory Intelligence | LLM Reflection、跨会话归纳、复杂推断 | OFF（ON-DEMAND 可用 / SCHEDULED 接口预留） |

### 4.2 Session Digest 可靠性流程（v1.3 收敛 ①）

Raw Event 先持久化 → 会话结束 → Digest 任务 Outbox 登记（幂等键）→ 执行（确定性规则：实体/事实/时间/意图/片段索引；**确定性摘要不得自动写入高可信语义记忆**）→ source_event_watermark 记录覆盖范围 → **提交成功前对应 RAW 不 GC** → 异常全覆盖（进程崩溃/连接中断/Digest 崩溃/重复消费/用户删除联动）→ 崩溃会话恢复扫描补偿触发。

### 4.3 RAW 配额背压（收敛 P1-4：三级阈值，死线拒写不删数据）

| 阈值 | 触发行为 |
|---|---|
| 软 80%（400MB） | 告警（面板+trace）+ Digest Worker 提级；**正常接收写入** |
| 硬 95%（475MB） | 暂停全部后台淘汰/压缩类任务（Outbox 消费与 Digest 保留）；继续接收写入 |
| 死线 100% | **拒绝新的 remember/RAW 写入**（`WRITE_PAUSED`，HTTP 503+Retry-After）；recall/introspect 不受影响 |

- **单 Session 上限 50MB**：超出拒绝 `SESSION_RAW_QUOTA` 并触发该会话即时 Digest（插队）；不自动截断、不自动删。
- **Digest 连续失败**：指数退避（1m→30m 封顶）；连续 5 次 → 标 `digest_stuck` 红色告警；**不 GC、不降级伪造摘要**。
- **GC 水位线跟随最小未完成 watermark**：Digest 全挂 → watermark 不前进 → RAW 停 GC、写入被拒 → 系统"只读保护"而非"静默清理"。
- **磁盘真满（宿主级）**：**不丢弃任何 RAW**（DDR-109 裁决：摘要不构成安全归档，`RAW_EMERGENCY_DROP` 已从设计中移除）；返回 `DISK_FULL` 独立错误码进入只读保护；解除 = Digest 恢复或用户显式"归档导出+确认清理"（用户主动有损，系统永不自动有损）。
- **重启恢复**：RAW 扫描重建配额计数；stuck 批按退避表续跑；TTL/GC 指针持久化。
- **底线承诺（DDR-109）：任何故障注入序列下，系统不自动删除未安全归档的原始记忆**——死线只拒写（`WRITE_PAUSED`）；宿主磁盘真满返回 `DISK_FULL` 只读保护；有损清理仅存在于用户显式"导出+确认清理"流程（压力测试断言）。

## 5. 召回管线（权限前置）

```
身份认证 → Scope 检查 → Sensitivity 硬过滤（节点级）
  → 向量/BM25 检索 → RRF 合并
  → 最终权限复核（边级继承 + 图扩散复查 + 缓存复查）
  → 上下文注入
```

候选预算：Vector 30 / BM25 30 / Graph 20 / 合并 80 / 精排 30 / 注入 5-15。
图扩散硬限：最大节点/边访问数、最大时间、单节点扇出、超时降级——**扩散失败不影响基础 recall**。
装配削减顺序：叙事线 → Top-N 长尾 → persona 最后（persona 可 pin）。

## 6. 治理规则（v1.3 收敛）

### 6.1 Annotation 容量治理（体验优先、全局有界）

- per-agent **软上限**：超限告警（面板+trace）但允许继续写入
- **全局硬存储预算**：达限拒绝注解（`MEM_QUOTA_EXCEEDED`），**不影响共享事实读写**
- 双维度统计：条数 + 存储字节
- 全局预留**原子化**（Writer 队列内原子操作，防并发突破）
- 异常增长监控 + revoked 归档清理

### 6.2 Proposal 状态机与队列

- **队列键 = logical_memory_id**（聚合根，非物理 node_id）
- **状态机**：`PENDING → APPROVED → APPLIED`（批准 ≠ 提交，两阶段）；旁路 `REJECTED / STALE / EXPIRED / CANCELLED`；提案带 TTL
- **等待期零长锁**：不持有 DB 事务/Writer 锁/阻塞读写资源
- **重验**：前位提案状态变化 → 后位提案自动重验（节点版本/边版本/权限）；**操作含义已变化 → 重新生成提案要求再确认**；底线：**自动重验 ≠ 自动授权**
- **提交**：APPROVED 后仍需存储层 CAS（节点版本/边版本/权限）原子提交；Writer 队列只管顺序，不变量在存储层
- **统一操作对象**：ADD / SUPERSEDE / MERGE / LINK_CREATE / LINK_UPDATE / ARCHIVE——全走写入闸门与授权确认流

## 7. 洛书 Luoshu（开放交换格式）

### 7.1 三概念分离

node_id（稳定身份）· revision_id / revision_sequence（版本）· content_hash（完整性）。幂等键 (owner_id, node_id, content_hash) 仅识别重复；版本冲突按 revision_id——旧快照不覆盖新版本。

### 7.2 Restore 与 Merge 分离

| | Restore | Merge |
|---|---|---|
| 节点/边/边权/状态 | 原样恢复（**不重跑淘汰**） | 冲突检查后按确定性淘汰合并 |
| Purge Ledger | 优先于旧备份节点，命中即物理丢弃 | 同左 |
| 冲突 | 完整性验证 | 无法自动解决→报告+导入审计 |

**Restore 与 Merge 共用同一套节点级导入权限验证管线**（校验→过滤→落库差异仅在落库动作）——杜绝"Restore 绕过权限"漏洞。

### 7.3 节点级 Scope 与可见性契约（收敛 P1-5）

每节点自带 scope 块（**节点级是权威数据，文件级仅传输容器；冲突节点级胜出**）：

```
scope:
  owner_id: 必填（导出不可变）
  layer: user_identity | agent_persona | global | project | private_annotation
  project_id: layer=project 时必填，否则禁止
  agent_id: layer=agent_persona|private_annotation 时必填
  visibility: owner | project_agents | all_agents | shared_list
  shared_with: visibility=shared_list 时的 agent id 列表
```

- 五类归属字段约束：User Identity→agent_id 禁止；Agent Persona/Private Annotation→agent_id 必填；Project→project_id 必填；**Private Annotation visibility 强制 = owner（硬约束，导入校验强制重写）**
- **导出过滤**：默认 visibility=shared 集合；Private Annotation 默认不导出（`include_private=true` + 宿主 UI 二次确认）；persona 默认导出可 flag 排除
- **导入四步验证**：①scope 自洽（层与字段匹配）→ `SCOPE_INVALID` 整节点拒绝 ②PRIVATE_LEAK（private 节点 visibility≠owner）→ **全文件拒绝**（导出方被篡改，不部分导入）③导入方无权限（layer/project 不匹配）→ 跳过该节点+导入报告计数（`IMPORT_SKIPPED`），**从不静默改归属** ④sensitivity 覆盖层随节点携带，导入取更严者
- 文件级 owner 仅作导出者元数据，不作权限依据；shared_list 只是"允许"非"充分"，导入方仍本地校验

### 7.4 派生来源链

provenance 七字段（origin/method/source_refs/producer_version/model_id/generated_at/confidence）。派生链不重复计数：A → Digest A → Reflection A ≠ 三个独立来源。

### 7.5 导入幂等与冲突

幂等键 (owner_id, node_id, content_hash)；revision_id 比较——旧快照不覆盖新版本；同 ID 异内容→冲突报告；悬空 superseded_by→占位墓碑+warning；Purge Ledger 永远优先；导入为事务性批次，失败整体回滚；content_hash 相同重复导入幂等跳过。

## 8. 评测与运维

- **golden QA**：召回/消歧/噪声 + 权限泄漏专项（200 条级持续扩充）
- **行为矩阵表驱动测试**：矩阵即规格即测试，不过不合并
- **洛书**：round-trip + 随机删节点 fuzz + Restore/Merge 分离测试
- **Proposal 异常场景测试**：等待/过期/重验/批准执行/并发预留
- **容量并发一致性测试**：全局预留原子性
- **性能验收**：Recall P95 ≤150ms / Persona 装配 P95 ≤10ms / 热点缓存命中 ≥95% / 增量索引 ≤1s / 后台影响 ≤10%
- 监控十指标 + 每次 Recall Trace ID；批量读取防 N+1
- 备份：快照+WAL checkpoint+restore 重放+Purge Marker
- schema 版本化迁移 SPI；MySQL 兼容测试按需触发

## 9. 实施路线图

| 阶段 | 内容 | 出口 |
|---|---|---|
| **M0 工程准备与设计冻结**（1-2 周） | 六项 P0 决策（DDR-001~006）/ 工程骨架 / CI / Migration 框架 / 接口契约 / 测试夹具 | 设计冻结签认 |
| **M1 最小记忆闭环**（3-4 周） | Remember → Persist → Recall / 权限过滤 / BM25 基础检索 / 重启持久 | 六条功能验收（仅内部技术原型） |
| **M2 记忆生命周期**（3-4 周） | Revision / Supersede / Minimize / Revive / Forget / Purge / Purge Ledger | 删除与 Purge 验收（通过前不承载真实敏感数据） |
| **M3 后台可靠性**（3-4 周） | RAW / Outbox / Session Digest / Watermark / Backpressure / 故障恢复 | 底线断言 + 压力测试 |
| **M4 完整 MVP 与发布**（4-6 周） | 洛书 / Proposal / Embedding / HNSW / RRF / 真实 Adapter / 完整安全与性能验收 | 毕业考（见 §11） |
| **P2 智能化扩展** | 图谱扩散 / 反思 SCHEDULED / LLM 消歧 / 实体合并 / 程序性记忆 / 多 Agent 调度 | M4 稳定后按需启动 |

## 10. 待详设清单（实现前补齐，不阻塞启动）

1. Top-K 评分函数的具体权重与衰减项形式
2. "时间显式命中"意图分类误判兜底
3. supersede 链长触顶的中段归档细节
4. provenance 惩罚公式与阈值
5. 注入检测假阳性处置规则（降权/丢弃/加壳选择）
6. golden QA 通过阈值与阻断策略
7. persona pin 与装配器 floor 数值
8. 审计日志保留期限与用户擦除权边界
9. Embedding 模型选型与向量维度约定
10. RRF 融合 k 值初始值
11. Proposal TTL 时长与 EXPIRED 提案的复活规则
12. link 存量 ≤20 与共现 top-K=32 的压测校准

## 11. MVP 毕业考（验收标准）

一条真实框架 adapter 走通：

```
记住 → 跨会话召回 → 删除（Forget）→ 不再出现
→ 导出（洛书）→ Restore → Purge 过的内容不复活
```

硬性门禁（缺一不验收）：行为矩阵全组合测试 ✓ / 洛书 round-trip+fuzz ✓ / Restore-Merge 分离测试 ✓ / Proposal 异常场景测试 ✓ / 容量并发测试 ✓ / 性能四目标 ✓ / 权限泄漏 QA 零失败 ✓ / 无绕过写入闸门的写路径（安全审计）✓

## 12. 审查与协商档案

| 轮次 | 性质 | 关键产出 |
|---|---|---|
| 1-4 | 红队逐节+矩阵 | 投毒防御、身份服务端分配、意图级授权、复活链封死 |
| 5 | 架构终审 | 链尾存储层唯一、装配器唯一预算、扩散吸收边界、YAGNI 三减法 |
| 6 | 致命专项 | sensitivity 覆盖层、restore 重放、合并器提案流 |
| 7 | 外部评审 | 双维度状态机、删除三操作、Purge Marker、权限前置、五类归属、Embedding Worker、候选预算、性能标准 |
| 8 | 后台协商 | 三层后台、Session Digest、Top-K 淘汰、边容量分立 |
| 9 | 收敛协商 | Annotation 体验优先、Proposal 状态机、洛书三概念、Restore/Merge 分离 |
| **10（终审）** | **框架定稿** | **大师裁定：框架无异议，P2 延后** |
| **11（开发前收敛）** | **五项专项（P0×3/P1×2）** | **Minimize 受控归档+MINIMIZED 状态 / 完整行为矩阵(含不可达组合与 8 错误码) / Purge Ledger 账本方案 / RAW 三级背压 / 洛书节点级 Scope 契约** |

---

> 龙马负图，图已成形。剩下的，是把这张图画进代码里。
