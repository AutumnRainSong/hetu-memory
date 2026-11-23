# 河图（HeTu）v1.4 → v1 第一版开发前技术收敛报告（5 项专项分析）

范围声明：不推翻 v1.4 架构；不加新功能；不提前实现 P2 项。所有结论均以 v1.4 既有概念（不可变节点 / sensitivity 覆盖层 / 双维度状态机 / 三删除操作 / Purge Marker / RAW 层 / Outbox / 洛书格式）为收敛基础。

---

## P0-1 Minimize 的可逆性与原文保留机制

### 1. 问题分析
v1.4 定义"Minimize = 删除原文留摘要与关联，标记可逆"。歧义：原文物理删除后"可逆"无数据基础。若按字面真删，则"可逆"只能指恢复到摘要级，与用户直觉（找回原文）冲突，会在删除确认 UI 与事故恢复中产生承诺违约。若不删，则 Minimize 与 Forget 无差异。

### 2. 最终方案
**采用方案 (a)：受控归档式 Minimize（原文移出检索面、物理保留在归档区）。**

- **语义分层**（明确三层次）：
  - 恢复状态：节点内容状态 FULL → MINIMIZED（MINIMIZED 是**内容轴新增状态**，不是 STUB——见 §P0-2 对 2×4 → 2×5 的修正理由；若严格维持 2×4，则 MINIMIZED 实现 STUB 的变体并加 `minimized: true` 元字段，行为矩阵独立成行）。
  - 恢复摘要与关联：摘要、边、supersede 链在 Minimize 后**全部保留原样**（普通 recall 可见摘要；边仅在显式 Link/Annotation 查询时可见，普通 recall 不以原文为基础生成）。
  - 恢复原文：**Minimize 可逆指原文可恢复**——原文从 blob 存储移入受控归档区（archived blob store），主索引、FTS、HNSW、recall 全部移除原文引用；归档区不参与任何检索，仅凭 Restore-with-archive 操作可达。
- **数据保留方式**：节点记录 `minimized_blob_ref`（指向归档区）+ `minimized_at` + 恢复凭据（无原文 hash 校验不恢复）。归档区与 blob 主区同库不同 namespace，纳入统一配额但**不计入 RAW 500MB**，受独立归档配额（MVP 无硬上限，P2 引入上限+LRU 清理提示）。
- **恢复流程**：Revive(minimized) → 权限校验（同层归属 + sensitivity 覆盖层校验）→ 原文从归档区搬回主 blob 区（校验 content_hash）→ 内容状态回 FULL → 重建 FTS/HNSW 索引 → 行为回到 FULL 全集。
- **错误处理**：归档 blob 丢失/哈希不匹配 → 恢复降级为"摘要级恢复"并显式报错 `ARCHIVE_MISSING`（不静默）；重复 Revive 幂等。
- **与 Purge 边界不冲突**：Purge 的唯一入口语义不变——Purge(MINIMIZED 节点) 必须同时擦除归档区原文（这是 Purge 唯一能触达归档区的路径）；Purge Marker 正常生成。
- **隐私与存储成本**：Minimize 的卖点改为"从可见性中移除原文"（防普通召回/导出泄露），不承诺物理删除；需要物理删除时用户走 Forget/Purge。文档必须明示这一点，否则有合规误导风险。存储成本 = 归档区额外一份原文。
- **测试用例**：Minimize 后 recall 返回摘要不含原文；Revive 后原文 hash 与最小化前一致；Minimize→Purge 后归档区无残留、Marker 存在；Minimize→Forget 后归档区删除（Forget 不允许归档残留）。

### 3. 替代方案及不采用原因
方案 (b) 原文真删、恢复只到摘要级：实现最简单、存储最省，但 (i) "标记可逆"承诺落空，(ii) 与 Supersede/Merge 等依赖原文 hash 链的机制冲突（洛书 content_hash 三概念分离要求可追溯），(iii) 用户误操作 Minimize 后不可恢复，MVP 信任成本过高。**代价对比**：(a) 多一份归档存储 + 一个 namespace 管理逻辑；(b) 省存储但需要把"可逆"从文档中删除并接受数据丢失风险。判断：(a) 的代价可接受且与 v1.4 "可逆"表述自洽。

### 4. 异常场景
- 并发：Minimize 与 Purge 竞争 → 以 Outbox 顺序化，Purge 胜出时归档区同步擦除，返回已 PURGED。
- 崩溃：Minimize 半途（主区已删、归档未落盘）→ 采用"先写归档、后删主区、再改状态"的顺序 + 启动时对账（归档存在但状态非 MINIMIZED → 补完成；状态 MINIMIZED 但归档缺失 → 标记 `ARCHIVE_MISSING`，恢复降级摘要级）。
- 重复：幂等。
- 权限：Minimize 需对归属层有写权；归档区原文保留受 sensitivity 覆盖层影响——high sensitivity 节点被 Minimize 时 UI 提示"原文仍保留在归档区"，可选（MVP）级联自动 Forget 归档。

### 5. MVP / P2 边界
MVP：受控归档 + Revive + 对账 + 归档区随 Purge/Forget 擦除。P2：归档配额与过期策略、Minimize 的批量操作、归档区加密。

### 6. 测试标准
自动化用例（表驱动）：10+ 用例覆盖上述场景；通过条件 = 全部表驱动断言通过 + 崩溃注入测试中无主区/归档区不一致残留（或残留可被对账修复）。

### 7. 文档影响
- 主设计：删除三操作章节 —— Minimize 语义改写为"受控归档"；新增内容状态 MINIMIZED（或 STUB 变体）说明；行为矩阵加行。
- 洛书格式：节点增加可选字段 `minimized_blob_ref` / `minimized_at`。
- continue_bro：Minimize 决策树更新。
- 执行者：实现归档 namespace、Revive 流程、启动对账。

---

## P0-2 完整行为矩阵与维度统一

### 1. 问题分析
2×4=8 组合中，`(SUPERSEDED, TOMBSTONE)` 与 `(SUPERSEDED, PURGED)` 语义重叠（superseded 已表示"被替代不可见"，tombstone/purge 再叠加删除状态），若不做明确"是否合法组合"判定，行为矩阵会出现空格子或臆造行为。另外 P0-1 引入 MINIMIZED 后维度不再是纯 2×4。

### 2. 最终方案

**维度统一裁决：**
- `(SUPERSEDED, TOMBSTONE)` / `(SUPERSEDED, PURGED)`：**非法组合，物理不可达**。约束：Forget/Purge 操作将节点同时置 CURRENT？不——正解是 **Forget/Purge 优先于 supersede**：对 SUPERSEDED 节点执行 Forget/Purge 是**拒绝**（错误码 `STATE_CONFLICT`），必须先对链尾（CURRENT 节点）操作，链上历史节点随链尾级联（与"链尾唯一性=存储层条件写"一致）。因此 SUPERSEDED × {TOMBSTONE, PURGED} 不存在，标记 N/A（不可达，不是空）。
- MINIMIZED 作为内容轴第 5 值（SUPERSEDED × MINIMIZED 亦不可达，同上拒绝）。
- `(CURRENT, PURGED)`：**合法且是 Purge 后唯一节点残迹**（见 P0-3 推荐：账本方案下甚至节点本体也不存在，此处 `(CURRENT, PURGED)` 保留为"账本方案兼容态"，MVP 采用账本方案后此格 = 概念占位，实际由 Marker 承载）。

**核心矩阵（操作 × 状态，其余操作 supersede/link/annotate/reinforce 均遵循"仅作用于可读写内容态"）：**

| 状态\操作 | remember | recall | introspect | Minimize | Forget | Purge | Revive | supersede(作为源) |
|---|---|---|---|---|---|---|---|---|
| CURRENT/FULL | 新版本（同 id 追加 revision） | ✅ | ✅ 全字段 | →MINIMIZED | →TOMBSTONE | →账本+节点物理删 | N/A（已 FULL）→`INVALID_STATE` | ✅（源转 SUPERSEDED） |
| CURRENT/STUB | 拒绝（不补写）→`STUB_IMMUTABLE`，提示走新 remember | ✅ 仅摘要 | ✅ 含 expired 标记 | →MINIMIZED(STUB) | →TOMBSTONE | →账本删 | N/A→`INVALID_STATE` | ✅ |
| CURRENT/TOMBSTONE | 拒绝→`STATE_CONFLICT`（复活走 Revive） | ❌ 不可见 | ✅ 仅元数据（id/状态/时间） | N/A→`STATE_CONFLICT` | 幂等 | ✅（终态清理） | →FULL（原文在则 FULL，否则 `ARCHIVE_MISSING` 降级） | ❌→`STATE_CONFLICT` |
| CURRENT/PURGED | 拒绝→`PURGED_FINAL` | ❌ | ✅ 仅 Marker 元数据 | N/A | N/A | 幂等 | ❌ 永久→`PURGED_FINAL` | N/A |
| SUPERSEDED/FULL | 拒绝→`STATE_CONFLICT` | ❌（除非显式链查询） | ✅ | ❌→`STATE_CONFLICT` | ❌→`STATE_CONFLICT`（级联随链尾） | ❌→`STATE_CONFLICT` | ❌→`STATE_CONFLICT` | ❌（已替代） |
| SUPERSEDED/STUB | 同上拒绝 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| SUPERSEDED/TOMBSTONE | 不可达 N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| SUPERSEDED/PURGED | 不可达 N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| CURRENT/MINIMIZED（P0-1 引入） | 拒绝→`STATE_CONFLICT` | ✅ 仅摘要（标 minimized） | ✅ | 幂等 | ✅ | ✅ | →FULL | ✅ |

**错误码定义**：`STATE_CONFLICT`（状态不允许该操作）、`PURGED_FINAL`（已永久擦除）、`STUB_IMMUTABLE`（确定性摘要节点不可补写）、`ARCHIVE_MISSING`（归档丢失，恢复降级）、`QUOTA_HARD_LIMIT`（RAW/归档配额硬顶）、`PERMISSION_DENIED`（层归属/visibility 校验失败）、`WRITE_PAUSED`（背压拒绝写入，P1-4）、`MARKER_CONFLICT`（导入遇 Marker 且带同 id 内容）。

**测试数据格式**（可自动化）：YAML 表驱动，每行 = `{state: {version, content}, op: "recall", expect: {allowed: bool, error?: "STATE_CONFLICT", transition?: "CURRENT/TOMBSTONE"}}`，矩阵文件即测试夹具，禁止测试代码内联期望值。

### 3. 替代方案及不采用原因
允许 SUPERSEDED 节点被单独 Forget/Purge：会破坏链尾唯一性与 supersede 链完整性，且造成"链中洞"（恢复语义不明）。代价是用户不能直接删历史版本——可接受，通过"对链尾 Purge 即整链清理"达到等效目的（Purge 链尾 → 整条 supersede 链逐节点入账本，因为链上历史由链尾派生可见性）。

### 4. 异常场景
并发：两个操作同时迁移同一节点 → 存储层条件写（版本号 CAS）裁决，败者重读状态并按新状态重新判定（不重放旧操作）。
崩溃：迁移半途 → 每次状态迁移先写 WAL/Outbox，重启重放幂等。
重复：幂等（同操作同状态 no-op 返回成功，不重复入 Outbox）。

### 5. MVP/P2
MVP：上表全部。P2：introspect 的 diff 视图、批量状态迁移。

### 6. 测试标准
矩阵文件直接驱动参数化测试；通过条件 = 每格至少 1 用例、无空格子（N/A 格必须有可达性证明用例，即"没有任何操作序列能到达"的属性测试）。

### 7. 文档影响
主设计：状态机章节重写（内容轴加 MINIMIZED、不可达组合、错误码表）；洛书：revision 状态字段同步；continue_bro：操作前置条件表；执行者：按矩阵实现短路逻辑。

---

## P0-3 PURGED 的最终语义

### 1. 问题分析
矛盾：Purge 要求物理删除，但 PURGED 又作为内容状态存在于节点。若节点保留则"物理删除"未达成（正文虽删但节点骨架、边、索引痕迹仍在，GDPR/删除权场景不合格）；若纯账本方案则状态机中 PURGED 悬空。防复活面广：旧备份、导入文件、blob 孤儿、FTS/HNSW 残留、缓存。

### 2. 最终方案
**推荐 (b)：PURGED 作为独立擦除账本（Purge Ledger）记录，原始节点物理删除；节点状态机中 PURGED 仅作为"概念终态"用于导入兼容与文档表达，不再有物理节点行。**

理由：(a) 方案中节点骨架保留 = 泄露元数据（id、时间戳、层归属、长度），与"审计仅 id/操作者/时间戳/原因类别"的隐私精神冲突；且需要为每个 PURGED 节点维护永久状态行，数据库里"物理删除"名存实亡。(b) 的代价是状态机失去一个物理状态——但这正是 v1.4 已有的结构：**Purge Marker 本来就是独立于节点的对象**，账本方案只是把 Marker 从"随导出携带的附件"提升为"系统内一等持久对象 + 导出附件"双形态，架构自洽。

- **PURGED 后原始记忆节点存在吗？** 不存在（行删除，含 revision、边、FTS、HNSW、blob 全部级联删除）。
- **PURGED 状态由什么记录？** Purge Ledger（append-only 表）：`{purge_seq（删除序列号，全局单调）, node_id, content_hash, operator, timestamp, reason_category}`——**不含正文**。导出时 Ledger 全量随导出携带（Purge Marker 即 Ledger 条目的导出投影）。
- **Marker 与节点状态关系**：无节点；Marker 是唯一残迹。导入时先应用 Marker：命中 Marker 的同 id 内容一律拒绝/丢弃（`MARKER_CONFLICT`），这正是 v1.4 "Purge Marker 优先"的落地。
- **Marker 最小信息**：`purge_seq, node_id, content_hash, timestamp, reason_category`（content_hash 是防复活关键：即使换 node_id 重建，hash 匹配也可拦截）。不含 operator（导出携带版本可含，本地账本含 operator 属审计需要，导出版脱敏——操作者身份可能本身是敏感信息）。
- **防复活机制**：
  1. 导入：Ledger 优先于一切内容（先应用再校验）。
  2. Blob GC：Purge 时 blob 立即删除 + GC 扫描引用计数兜底孤儿。
  3. FTS/HNSW：Purge 事务内同步删除索引条目；启动时对账（索引 id 不在节点表 → 删）。
  4. 备份恢复：备份内嵌 Ledger 快照；恢复后 Ledger 合并（取 purge_seq 最大并集），恢复出的旧节点若命中 Ledger → 恢复时即物理丢弃。
  5. 缓存：Purge 发布缓存失效事件；TTL 上限 ≤ 缓存最坏存活（缓存键含 revision_id，节点删后键不可解析即失效）。
- **避免防复活机制长期保留敏感信息**：Ledger 不含正文/摘要/embedding；node_id 与 content_hash 是不可逆标识（hash 不还原）；Ledger 本身支持 `purge_ledger_compact`——P2 引入：超过保留期（如 1 年）且无冲突风险的条目可归档脱敏为 `{purge_seq, timestamp, reason_category}`（去 node_id/hash）。MVP 不做 compact，但数据模型预留 reason_category 使未来可脱敏。

### 3. 替代方案及不采用原因
(a) PURGED 数据库逻辑终态（节点保留）：实现简单（状态机闭合、无级联删除），但元数据残留（结构、边拓扑、时序泄露"曾存在某条记忆及其长度/层"），删除权合规弱；且需为防复活在节点上挂 Marker 引用，两套机制重复。代价对比：(b) 需要级联删除事务 + Ledger 表 + 恢复合并逻辑，复杂度约 +30%，换取真正可证明的擦除。判断：删除操作的信任价值正是产品核心承诺，(b) 值得。

### 4. 异常场景
并发：Purge 与 supersede/annotate 竞争 → 条件写，Purge 胜出则对方操作返回 `PURGED_FINAL`；Purge 败出则正常走对方路径。
崩溃：级联删除半途 → Purge 事务分两阶段：先写 Ledger（提交点），后级联删除；崩溃后启动对账"Ledger 有而节点表有 → 补删"。**Ledger 先行保证任何崩溃序列下不会出现"内容已删但无 Marker"或"Marker 无但内容在"以外的不一致。**
重复：同一 node_id 二次 Purge 幂等；不同 node_id 同 content_hash → 各自入账（hash 拦截在导入/恢复时按 content_hash 判定）。
权限：Purge 仅限对应归属层授权 + 宿主 UI 二次确认；Ledger 只增不改不删（compact 是 P2 独立治理操作）。

### 5. MVP/P2
MVP：Ledger、级联删除、导入优先、备份合并、启动对账、防复活测试。P2：Ledger compact、跨设备 Ledger 同步策略、Ledger 导出脱敏策略。

### 6. 测试标准
用例：Purge 后节点/边/FTS/HNSW/blob 五处均无残留（属性测试扫全库）；含被 purge 节点的旧备份恢复 → 节点不复活；导入含同 id/hash 内容 + Marker → 拒绝；Purge 中途 kill -9 任意时刻 → 重启对账收敛。通过条件 = 全部通过 + 全库残留扫描为空。

### 7. 文档影响
主设计：删除三操作章节（Purge 改为账本方案）、数据模型加 Purge Ledger、备份恢复章节；洛书：Marker 格式（已在 v1.4，补 content_hash 必填）；continue_bro：Purge 决策与崩溃恢复语义；执行者：Ledger 表、两阶段 Purge、对账任务。

---

## P1-4 RAW 配额与 Digest 失败的背压机制

### 1. 问题分析
RAW FIFO 500MB + TTL 7-30 天，但 Digest 失败时 RAW 不能 GC（"Digest 提交成功前不 GC"），新会话持续写入 → 容量死锁。若静默删除未归档 RAW 违反底线（数据丢失）；若无限放行则磁盘耗尽拖垮主库。

### 2. 最终方案

**阈值体系：**
- 软阈值 80%（400MB）：告警 + Digest Worker 提级重试（退避变短）+ 宿主 UI 黄色提示。**正常接收写入。**
- 硬阈值 95%（475MB）：**暂停全部后台淘汰/压缩类任务**（Digest 重试保持、其他后台任务让出 IO），继续接收写入（会话可用性优先）。
- 死线 100% 且无任何可 GC 空间：**拒绝新的 remember/RAW 写入**，返回 `WRITE_PAUSED`（HTTP 层面等价 503 + Retry-After）；recall/introspect/其他查询操作不受影响。**底线承诺：任何情况下不静默删除未归档 RAW；唯一出清路径 = Digest 成功或 TTL 到期且已生成摘要内联节点。**

**单 Session 最大容量**：RAW 单 session 上限 50MB（硬顶的 10%），超出 → 该 session 的 RAW 写入拒绝 `SESSION_RAW_QUOTA`，并触发该 session 的即时 Digest 请求（插队）。超大会话由用户拆分——不自动截断、不自动删。

**7 场景裁决：**
1. 接近上限（80%）：软告警，Worker 并发+1，UI 提示。
2. 达到上限（95%）：如上；同时向宿主发出可操作建议（手动触发 Digest / 导出归档）。
3. Digest 连续失败：指数退避（1m→2m→…→30m 封顶），连续 5 次失败 → 标记该批 RAW `digest_stuck`，UI 红色告警给出失败原因（模型不可达/超时/格式错）。**不因失败而 GC，不因失败而降级为"跳过摘要直接入语义库"**（v1.4 已定：确定性摘要不得自动写高可信语义记忆——同理，失败摘要也不得伪造）。
4. Outbox 积压：Outbox 属写入路径，积压时优先 drain Outbox；RAW 硬阈值时暂停的后台任务不含 Outbox 消费。
5. 单 Session 超容量：如上 `SESSION_RAW_QUOTA`。
6. 磁盘不足（整盘，非 RAW 配额）：所有写操作（含主库）拒绝 `DISK_FULL`，只读降级；这是宿主级故障不是配额策略解决范围，但需要区分错误码。
7. 重启恢复：RAW 文件列表扫描重建配额计数；`digest_stuck` 批次按退避表续跑；TTL/GC 指针持久化，不重扫全文。

**背压流程**：写入方 → RAW 配额检查（软/硬/死线三级）→ session 配额检查 → 落盘 → 入 Digest 队列。拒绝只发生在入口，绝不写一半。

### 3. 替代方案及不采用原因
- 达到 100% 时自动删除最旧未归档 RAW：违反 v1.4 底线（静默数据丢失），拒绝。
- 硬阈值即拒绝写入（不设 95% 缓冲）：会话可用性损失过大，拒绝。
- Digest 失败 N 次后放弃并允许 TTL GC：等于把摘要失败转化为静默丢原始数据，拒绝；改为无限保留 + 持续告警 + 人工干预通道。

### 4. 异常场景
并发：多 Worker 抢同一 RAW 批 → 队列租约（lease），超时回收；重复 Digest → 提交幂等（session_id+时间窗指纹）。
崩溃：RAW 落盘成功但队列消息丢失 → 启动扫描"无 digest 记录的 RAW"重入队；摘要已写、RAW 待 GC → GC 指针推进。
权限：配额策略不分层（宿主级资源）；`WRITE_PAUSED` 对所有归属层一致。

### 5. MVP/P2
MVP：三级阈值、单 session 上限、退避重试、digest_stuck 标记、重启恢复、错误码。P2：多级存储（RAW 落冷盘）、按项目配额细分、Digest 降级模型选择。

### 6. 测试标准
容量压力测试：构造 500MB RAW + Digest 全失败 → 断言 (i) 无任何 RAW 被删除，(ii) 95% 后台暂停生效，(iii) 100% 后 remember 返回 `WRITE_PAUSED` 且 recall 正常，(iv) Digest 恢复后配额下降、写入自动恢复。单 session 50MB 超限测试；重启后 stuck 批续跑测试。通过条件 = 底线断言（零删除）在任何故障注入序列下成立。

### 7. 文档影响
主设计：RAW 层章节加配额与背压小节、错误码表；continue_bro：容量告警处置手册；执行者：配额检查器、退避调度、stuck 状态、恢复扫描。

---

## P1-5 洛书节点级 Scope 与可见性契约

### 1. 问题分析
现状洛书仅文件级 owner_id。多 Agent 导出/导入时：私有注解（Private Annotation 层）可能随文件级导出泄露给其他 Agent；Global/Project/User 层混在一个文件里时，导入方无法按层裁决；文件级 owner_id 无 authority 表达（"这个节点是哪个 Agent 记的、哪些主体可见"）。

### 2. 最终方案

**节点级数据结构**（洛书节点新增 scope 块）：
```
scope:
  owner_id: <user identity，必填，导出不可变>
  layer: user_identity | agent_persona | global | project | private_annotation
  project_id: <layer=project 时必填，否则禁止出现>
  agent_id: <layer=agent_persona | private_annotation 时必填>
  visibility: owner | project_agents | all_agents | shared_list
  shared_with: <visibility=shared_list 时的 agent id 列表>
```
- **五类归属的节点字段约束**：User Identity → `owner_id` 必填、agent_id 禁止；Agent Persona → agent_id 必填；Global → owner_id+visibility=all_agents；Project → project_id 必填；Private Annotation → agent_id 必填 + **visibility 强制 = owner**（private 是硬约束，不是默认值，导入时校验强制重写为 owner）。
- **节点级 vs 文件级职责**：文件级 = 传输容器属性（格式版本、签名、文件完整性、导出者身份）；节点级 = 权威数据（每个节点独立声明归属与可见性）。规则：**冲突时节点级胜出**；文件级 owner 仅作为导出者元数据，不作为权限依据。

**导出过滤规则**：默认导出 = 当前上下文可见集合（sensitivity 硬过滤前置之后仍可见的 + 层归属过滤：导出目标方无权见的层整体排除）。Private Annotation **默认不导出**，仅显式 `include_private=true` 且宿主 UI 二次确认。Agent Persona 默认导出（persona 本来就是给其他 Agent 用的），可 flag 排除。

**导入权限验证规则**：
1. 节点级校验：scope 块必填且自洽（层与字段匹配、private 强制 owner）→ 不自洽整个节点拒绝 `SCOPE_INVALID`（不静默降级）。
2. 私有注解泄露防护：导入文件含 visibility≠owner 的 private_annotation 节点 → 全文件拒绝 `PRIVATE_LEAK`（说明导出方被篡改或格式错误，不部分导入——部分导入会造成"哪些被丢了"不可知）。
3. 导入方无权限：节点 layer/project_id 在导入方不存在或不匹配 → 三选一策略按层：project 层 → 默认跳过该节点并记入导入报告（`IMPORT_SKIPPED` 计数）；global → 导入为导入方本地 global；user_identity → 校验 owner_id 一致否则跳过。**从不静默改归属。**
4. sensitivity 覆盖层随节点携带，导入时按导入方 sensitivity 策略**取更严者**。

**Restore 与 Merge 同一权限验证规则**：是。Restore（不重跑淘汰）与 Merge 只影响图操作，不影响权限裁决——两者共享同一套导入验证管线（校验→过滤→落库），差异仅在落库时 Merge 走合并键、Restore 走原样重建。这样避免"Restore 绕过权限"的经典漏洞。

### 3. 替代方案及不采用原因
- 仅靠文件级加密/签名控制可见性：粒度太粗，一个文件多节点混合归属时无法分层裁决，拒绝。
- 导入无权限节点时静默降级为导入方私有：篡改归属语义（provenance 失真），违反五类归属模型，拒绝——改为跳过+报告。
- 全文件拒绝 vs 跳过策略的裁决：只对 PRIVATE_LEAK / SCOPE_INVALID 这类"格式/契约被破坏"全文件拒绝（不信任该文件），对"权限不匹配"类跳过+报告（正常业务情形）。混合会造成安全/可用失衡，故两档分明。

### 4. 异常场景
并发：导出期间节点被 supersede → 导出快照一致性（导出走只读快照）。
崩溃：导入半途 → 导入事务整体提交（MVP 简化：导入是事务性批次），失败回滚。
重复：同节点重复导入 → content_hash 相同幂等跳过；不同 → 走 Merge/Supersede 键裁决。
权限：导出者伪造 visibility=shared_list 包含导入方 → 导入方仍需本地校验 project/layer 归属，shared_list 只是"允许"非"充分"。

### 5. MVP/P2
MVP：scope 块、导出过滤、导入四步验证、private 硬约束、Restore/Merge 共用管线。P2：shared_list 的细粒度授权管理 UI、跨设备 scope 迁移策略、导入报告的可视化。

### 6. 测试标准
跨 Agent 隔离测试：Agent A 导出含私有注解 → Agent B 导入 → 断言 B 库中无私有注解节点且导入报告计数正确；private 泄露构造（篡改 visibility）→ 全文件拒绝；无权限 project 节点 → 跳过+报告；Restore 与 Merge 各跑一遍同一污染文件 → 权限结果一致（属性测试：两种路径的可见集合差为空）。通过条件 = 隔离属性测试全绿。

### 7. 文档影响
主设计：五类归属章节加节点级 scope 契约、导出导入章节；洛书格式规范：scope 块字段与校验规则（格式变更需版本号 bump）；continue_bro：跨 Agent 协作场景手册；执行者：scope 校验器、导出过滤器、导入管线统一化（Restore/Merge 复用）。

---

## 技术债清单（非阻塞，一句话一条）

1. Digest Worker 无降级模型选择（P2：失败时可切换轻量模型重试而非无限重试同一模型）。
2. 归档区（Minimize）MVP 无配额与加密，长期需独立容量治理。
3. Purge Ledger compact（长期脱敏）MVP 缺席，Ledger 无限增长。
4. 洛书 scope 校验错误信息未做本地化/i18n。
5. Outbox 与 Purge Ledger 的事务边界未统一抽象，实现时可能各写一套提交逻辑。
6. HNSW 索引的启动对账是全量扫描，规模大后需增量 checkpoint。
7. 导入报告 MVP 为纯文本日志，无结构化 schema。
8. sensitivity"取更严者"合并策略在跨设备同步时的冲突提示 UI 未定义。
9. RAW TTL 与配额双触发时的 GC 顺序未做确定性规范（实现时按 purge_seq 即可，但应写进注释）。
10. 宿主 UI 二次确认的审计留痕格式未与 Purge Ledger 对齐。
