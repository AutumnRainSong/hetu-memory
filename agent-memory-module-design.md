# 河图 · 主设计文档

> 版本：v1.3（收敛版） · 日期：2026-11-23
> 名实：系统 **河图 HeTu**（"河出图"——华夏最早的结构化知识图谱）· 交换格式 **洛书 Luoshu**
> 协作：用户 × AI 框架设计师 × 外部架构评审（8 轮审查+协商全部闭环）

---

## 0. 定位与边界

- **定位**：跨框架通用记忆层——任何 agent 框架均可接入，一份记忆处处可用
- **理念**：本地优先、数据归用户、记忆是活的图谱、内容用户掌生杀权而系统掌结构整理权
- **明确不做（MVP）**：跨设备同步、云托管、多用户（schema 预留 owner_id）、具身实现（JSON 扩展位）、内置大模型

### 0.1 五类记忆归属

| 归属类 | 属主 | 示例 |
|---|---|---|
| User Identity | 用户 | 长期稳定的身份、偏好、事实 |
| Agent Persona | agent（用户授予） | 工作习惯、行为偏好、角色设定 |
| Global Memory | 用户（授权共享） | 跨 agent 共享记忆 |
| Project Memory | 项目 | 项目内事实与决策 |
| Private Annotation | 单个 agent | 私有解读 |

## 1. 整体架构（四层）

```
接入层：MCP 薄壳 + REST（管理面独立鉴权域）
  鉴权：服务端分配 agent_id / token↔id 焊死 / 短TTL / 吊销即时（每调用入口）/ 失败锁定
服务层（HTTP 底座）：
  记忆装配器（唯一预算分配器；persona 带 floor，用户可 pin）
  召回引擎（权限前置硬过滤 → 双路检索 → 复核注入）
  消歧裁决（高分直取 / 低置信反问；LLM 消歧 P2）
  写入闸门（if-chain；授权映射到意图而非工具）
  supersede 合并器（只出提案走宿主确认流；可回放）
  Proposal 队列（同逻辑记忆 FIFO + 版本重验 + 无长锁，见 6 节）
  统一 Writer 队列 + Outbox 异步索引
存储层（Storage SPI 六原语）：
  SQLite(WAL+Writer队列) + 持久化 HNSW（Manifest 校验；重建仅损坏兜底，后台重建+原子切换）
  链尾唯一性：存储层条件写 + 确定性 tie-break
  graph-traverse 契约：hub 抑制 / 扩散预算 / decay 优先队列截断
扩展层：具身（JSON 位）/ 跨设备 / 云托管 / 多用户 owner_id —— 全部预留
```

**Embedding Worker**：独立常驻进程；查询向量缓存+批量计算+模型版本管理+维度校验；升级=旧向量标记版本→后台重算→原子切换。

## 2. 数据模型

### 2.1 节点（五类归属 × 双维度状态）

**记忆节点（不可变）**：blob 引用、modality、置信度、provenance（agent 身份 + origin + method + source_refs + producer_version + generated_at + confidence）、双时间轴、superseded_by。
**sensitivity = 独立可变覆盖层**（键=node_id，记审计；硬过滤前置读覆盖层；链上最高继承+边级应用；用户面板整链降级唯一通道）。
**实体节点**（指向当前版本，hub 受剪枝）· **空间节点**（JSON 位）· **私有注解节点**（联动规则见 3.4）· **人格块**（常驻带上限、用户可 pin）。

### 2.2 双维度状态机

| 维度 | 状态 |
|---|---|
| 版本 | CURRENT / SUPERSEDED |
| 内容 | FULL / STUB / TOMBSTONE / PURGED |

两维正交组合；行为矩阵按组合定义。

### 2.3 边（四种，容量分立）

| 边类型 | 容量约束 | 满额策略 |
|---|---|---|
| 共现边 | 每节点 top-K（默认 32） | **确定性淘汰**：评分=cooccurrence_count(单会话计入 distinct_session_count)×last_reinforced_at 衰减项的纯函数；并列淘汰 created_at 较旧者；Writer 队列串行；淘汰审计记原因+评分+触发新边；被淘汰关系可从 RAW 重建 |
| 显式 Link | 独立存量 ≤20（初始参数，实测校准） | **三分**：pinned 不淘汰 / explicit 满额拒绝新增并告知容量 / inferred 可按确定性规则淘汰；跨类型互不挤占 |
| Supersede 边 | 链长上限 | 触顶走历史归档或可追溯链压缩，**绝不破坏版本历史** |
| Annotation 边 | **不设单边上限，配额治理见第 6 节** | 宿主 PURGED 时联动清理 |

**扩散吸收边界**：TOMBSTONE/PURGED 为吸收边界；sensitivity 继承应用到边。

## 3. 生命周期与行为矩阵

### 3.1 删除三操作

| 操作 | 语义 | 普通 recall |
|---|---|---|
| Minimize | 删原文留摘要与关联 | 可见（摘要） |
| Forget | 软删除 TOMBSTONE | **完全不可见** |
| Purge | 硬擦除受控存储+全部派生数据 | 物理消失 |

STUB 历史仅经独立历史查询接口（显式授权）访问。

### 3.2 行为矩阵（按组合状态，表驱动测试不过不合并）

- 写工具对 TOMBSTONE/PURGED 短路（`MEM_TOMBSTONED`/`MEM_PURGED`）
- Forget×FULL=转 TOMBSTONE（宿主 UI 确认）；Minimize×FULL=转 STUB（可逆）
- Purge×(STUB|TOMBSTONE|FULL)=purge() 唯一硬擦除入口（单次高危确认；审计仅记 id/操作者/时间戳/原因类别）
- recall：FULL=W；SUPERSEDED+FULL=时间显式命中正常权重沿链返回、非时间命中硬降权；TOMBSTONE/PURGED=**E 不可见**
- revive：仅 TOMBSTONE 显式恢复；re-created_from 独立节点不回挂
- introspect：只返回权限位；suspended 只读；revoked 401

权限模板三级 × 写意图三级（append/状态更新/破坏性）；授权映射到**意图**；二次确认由宿主 UI（MCP elicitation/REST 回调），宿主 LLM 无权自确认。

### 3.3 Purge Marker 防复活

Marker 独立于节点（id+删除序列号+时间戳，不含正文）；随导出携带全量；导入先应用 Marker 再导节点；全链检查（Blob/FTS/HNSW/缓存/WAL/备份/日志）；边界声明：完全离线备份无法远程撤销；restore 重放本机 purge 审计。

### 3.4 宿主状态迁移 × 注解联动

SUPERSEDED 注解原位；Minimize/Forget 跟随内容状态；Purge 先墓碑再联动；agent revoked 注解+persona 整体处置（默认 tombstone，可选归档）。

### 3.5 生命周期分层

结绳 RAW（FIFO，TTL 7-30 天，配额 500MB；到期摘要**新建节点**内联标 source_expired）→ 竹简（情节层）→ 河图（语义层/人格层，两段式确认可回滚）→ 归档遗忘（conflict 仅数值/日期/显式否定保守触发，绝不自动改写）

## 4. 写入管线

归属路由（五类）→ 质量闸门 → 原子化抽取 → 四操作决策（ADD/UPDATE/DELETE/MERGE_INTO，按意图集授权）→ 建边（别名表+显式确认合并）→ 落盘（append-only；单事务只做 DB 写，Embedding/HNSW/图谱/权重全走 Outbox 异步）。

**后台三层（架构共识）**：

| 层次 | 内容 | MVP 策略 |
|---|---|---|
| Data Integrity | Raw Event Capture、事务、权限、删除、备份、版本一致性 | 必须可靠运行 |
| Memory Processing | **Session Digest（默认开启）**、确定性抽取、Embedding、索引维护 | 有界运行 |
| Memory Intelligence | LLM Reflection、跨会话归纳、复杂推断 | 默认 OFF（ON-DEMAND 可用 / SCHEDULED 接口预留） |

**Session Digest 可靠性（v1.3 收敛 1）**：
Raw Event 先持久化（Data Integrity）→ 会话结束 → Digest 任务经 Outbox 登记（幂等键）→ 执行（确定性规则：实体/事实/时间/意图/片段引用；**确定性摘要不得自动写入高可信语义记忆**）→ source_event_watermark 记录覆盖范围 → 提交成功前对应 RAW 不 GC → 异常（进程崩溃/连接中断/重复消费/删除联动）全场景覆盖 → 崩溃会话恢复扫描补偿触发。

## 5. 召回管线（权限前置）

```
身份认证 → Scope 检查 → Sensitivity 硬过滤（节点级）
  → 向量/BM25 检索 → RRF 候选合并
  → 最终权限复核（边级继承+图扩散复查+缓存复查）
  → 上下文注入
```
候选预算：Vector 30/BM25 30/Graph 20/合并 80/精排 30/注入 5-15。图扩散硬限+失败降级不影响基础 recall。
装配削减顺序：叙事线→Top-N 长尾→persona 最后（persona 可 pin）。

## 6. v1.3 收敛新增（外部协商定稿）

### 6.1 Annotation 容量治理（体验优先、全局有界）

- **per-agent 软上限**：超限告警（管理面板+trace）但允许继续写入——注解体验不受硬配额破坏
- **全局硬存储预算**：达限时拒绝 Annotation 写入返回容量错误（`MEM_QUOTA_EXCEEDED`），**不影响共享事实读写**
- **双维度统计**：条数 + 实际存储字节数，不能只按数量
- **原子化预留**：全局预算检查与预留走 Writer 队列内的原子操作，防并发突破
- **异常增长监控** + revoked agent 注解归档清理策略（已有 3.4）

### 6.2 Proposal 状态机与 FIFO（逻辑顺序控制、无长锁）

- **队列键 = logical_memory_id（聚合根）**，不按物理 node_id 分组（节点不可变会不断产生新 id）
- **状态机**：`PENDING → APPROVED → APPLIED`；旁路 `REJECTED / STALE / EXPIRED / CANCELLED`
  - APPROVED ≠ APPLIED：用户批准与实际提交是两阶段
- **等待期零长锁**：不持有 DB 事务/Writer 锁/任何阻塞读写的资源
- **过期机制**：提案带 TTL，过期转 EXPIRED，不永久阻塞队列
- **重验规则**：前位提案状态变化后，后位提案自动重验（检查节点版本/关联边版本/权限状态）；**若操作含义已变化 → 重新生成提案要求用户再确认，不得只更新 revision_id 继续执行**
- **底线原则**：自动重验 ≠ 自动授权——系统可自动判断提案是否仍成立，但不能擅自改变用户原本批准的操作含义
- **提交原子性**：APPROVED 后执行仍需存储层 CAS 检查节点版本/边版本/权限，原子提交；Writer 队列只保证调度顺序，不变量由存储层保障

### 6.3 Proposal 操作类型（统一对象）

ADD / SUPERSEDE / MERGE / LINK_CREATE / LINK_UPDATE / ARCHIVE——全部走写入闸门与授权确认流。

## 7. 洛书（交换格式）契约

### 7.1 三概念分离（幂等 ≠ 版本冲突解决）

- **node_id**：记忆稳定身份
- **revision_id / revision_sequence**：内容版本
- **content_hash**：完整性校验

### 7.2 Restore 与 Merge 分离

| | Restore 模式 | Merge 模式 |
|---|---|---|
| 节点/边 | 原样恢复 | 冲突检查后合并 |
| 边权/状态/版本关系 | 保留原始 | 按当前库状态执行确定性淘汰 |
| Top-K 淘汰 | **不重跑**（防改变原图谱） | 执行 |
| Purge Marker | 优先于旧备份节点 | 同左 |
| 冲突处理 | 完整性验证 | 无法自动解决的生成报告+导入审计 |

### 7.3 派生来源链

洛书节点 provenance 含：origin（session-digest/hot-path/reflection）/ method（规则/模型/用户确认）/ source_refs / producer_version / model_id / generated_at / confidence。
**派生链不重复计数**：原始事实 A → Digest A → Reflection A 不得算作三个独立来源。

### 7.4 导入幂等与冲突

幂等键 (owner_id, node_id, content_hash) 用于识别重复；版本冲突按 revision_id 比较——旧快照不覆盖新版本；同 ID 不同内容判冲突生成报告；悬空 superseded_by 建占位墓碑记 warning；Purge Marker 永远优先。

## 8. 评测与运维

- golden QA（召回/消歧/噪声+权限泄漏专项 200 条级）
- 行为矩阵表驱动测试（矩阵即规格即测试）
- 洛书 round-trip + fuzz + **Restore/Merge 分离测试**
- **Proposal 异常场景测试**：等待/过期/重验/批准执行/并发预留（v1.3 新增）
- **全局容量并发一致性测试**（v1.3 新增）
- 性能验收：Recall P95 ≤150ms / Persona 装配 P95 ≤10ms / 热点缓存命中 ≥95% / 增量索引 ≤1s / 后台影响 ≤10%
- 监控十指标+Trace ID；批量读取防 N+1；备份快照+WAL+restore 重放+Purge Marker；schema 版本化迁移 SPI

## 9. 实施路线图（四阶段）

1. **数据正确性与安全**：双维度状态机 / 三操作语义 / 权限 Scope / 硬过滤 / 洛书契约 / Purge Marker
2. **性能基础设施**：HNSW 持久化 / Embedding Worker / Writer 队列+Outbox / Recall Fast Path / 批量读取 / 监控
3. **基础记忆能力（MVP）**：记/忆/忘/察四工具 + 导入导出 + 跨会话回忆 + 删除恢复测试。验收=真实 adapter 走通「记住→跨会话召回→删除→不再出现→导出重建」
4. **智能化扩展（P2）**：图谱扩散 / 反思（资源配额就绪）· LLM 消歧 · 实体合并 · 程序性记忆 · 多 Agent 调度

## 10. 审查与协商记录

| 轮次 | 交付 | 关键产出 |
|---|---|---|
| 1-4 | 红队逐节+矩阵 | 投毒防御、身份分配、意图授权、复活链封死 |
| 5 | 架构终审 | 链尾存储层唯一、装配器唯一预算、扩散吸收边界、YAGNI 减法 |
| 6 | 致命专项 | sensitivity 覆盖层、restore 重放、合并器提案流 |
| 7 | 外部评审 | 状态机双维度、删除三操作、Purge Marker、权限前置、五类归属、Embedding Worker、候选预算、性能标准 |
| 8 | 后台协商 | 双轨制、Session Digest、Top-K 淘汰、边容量分立 |
| **9** | **收敛协商** | **Annotation 体验优先全局有界、Proposal 状态机+FIFO+无长锁、洛书三概念分离、Restore/Merge 分离** |
