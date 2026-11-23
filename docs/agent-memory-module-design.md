# 河图 HeTu · 通用 Agent 记忆模块 —— 架构规格 v1.4（定稿）

> **名实**：系统 **河图 HeTu**（"河出图"——龙马负出的那张最早的图，点即节点、位势即边）
> **版本**：v1.4 定稿 · 2026-11-23 · 9 轮审查协商闭环（红队×4 / 复核×1 / 致命专项×1 / 外部评审×2 / 工程协商×2）
> **状态**：设计冻结。本版本为团队实现的唯一依据；此后设计变更一律走"提案 → 用户/评审确认 → 文档先行 → 代码跟进"。
> **配套**：洛书 Luoshu 交换格式（第 7 节）· continue_bro.md（AI 结对入职）· 执行者.md（团队画像）

---

## 0. 定位与边界

- **定位**：跨框架通用记忆层——任何 agent 框架（Claude Code / Cursor / DSH / 自研）均可接入，一份记忆处处可用
- **理念**：本地优先、数据归用户（洛书开放格式）；记忆是活的图谱；**内容用户掌生杀权，系统掌结构整理权**
- **明确不做（MVP）**：跨设备同步 / 云托管 / 多用户（owner_id 预留）/ 具身实现（JSON 扩展位）/ 内置大模型
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
│ 具身（JSON 扩展位）/ 跨设备同步 / 云托管 / 多用户 owner_id  │
└────────────────────────────────────────────────────────┘

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
| 内容 | FULL / STUB / TOMBSTONE / PURGED |

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
| Minimize 精简 | 删原文留摘要与关联 | 可见（摘要） |
| Forget 删除 | 软删除 → TOMBSTONE | **完全不可见** |
| Purge 擦除 | 清理受控存储+全部派生数据 | 物理消失 |

STUB 历史仅经独立历史查询接口（显式授权）访问。

### 3.2 行为矩阵（5 内容状态 × 工具，表驱动测试不过不合并）

| 规则 | 内容 |
|---|---|
| 写短路 | TOMBSTONE/PURGED 对 reinforce/annotate/link/remember 短路（`MEM_TOMBSTONED`/`MEM_PURGED`） |
| Forget×FULL | 转 TOMBSTONE（宿主 UI 确认）；×STUB 同左 |
| Minimize×FULL | 转 STUB（可逆）；×TOMBSTONE=E |
| Purge 入口 | ×(STUB\|TOMBSTONE\|FULL)=purge() 唯一硬擦除入口；单次高危确认；审计仅 id/操作者/时间戳/原因类别 |
| recall | FULL=W；SUPERSEDED+FULL=时间显式命中正常权重沿链返回、非时间命中硬降权；TOMBSTONE/PURGED=**E 不可见** |
| revive | 仅 TOMBSTONE 显式恢复；re-created_from 独立节点不回挂旧链 |
| introspect | 仅权限位；suspended 只读；revoked 401 |

权限模板三级（只读/可写注解/全读写）× 写意图三级（append/状态更新/破坏性）；**授权映射到意图**；二次确认由宿主 UI（MCP elicitation / REST 回调），宿主 LLM 无权自确认。

### 3.3 Purge Marker 防复活

Marker 独立于节点（id+删除序列号+时间戳，不含正文）；随导出携带全量；**导入先应用 Marker 再导节点**；全链检查（Blob/FTS/HNSW/缓存/WAL/备份/日志）；restore 重放本机 purge 审计。**边界声明**：完全离线长期未同步的备份无法远程撤销——产品文档明示。

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

node_id（稳定身份）· revision_id（版本）· content_hash（完整性校验）。

### 7.2 Restore 与 Merge 分离

| | Restore | Merge |
|---|---|---|
| 节点/边/边权/状态 | 原样恢复 | 冲突检查后合并 |
| Top-K 淘汰 | **不重跑** | 执行（确定性规则） |
| Purge Marker | 优先于旧备份节点 | 同左 |
| 冲突 | 完整性验证 | 无法自动解决→报告+导入审计 |

### 7.3 派生来源链

洛书节点 provenance 含七字段（origin/method/source_refs/producer_version/model_id/generated_at/confidence）。**派生链不重复计数**：A → Digest A → Reflection A ≠ 三个独立来源。

### 7.4 导入幂等与冲突

幂等键 (owner_id, node_id, content_hash) 识别重复；revision_id 比较版本——旧快照不覆盖新版本；同 ID 异内容→冲突报告；悬空 superseded_by→占位墓碑+warning；Purge Marker 永远优先。

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
| **一 数据正确性与安全** | 双维度状态机 / 三操作 / 权限 Scope / 硬过滤 / 洛书契约 / Purge Marker | 大师专项审查 |
| **二 性能基础设施** | HNSW 持久化 / Embedding Worker / Writer 队列+Outbox / Fast Path / 批量读取 / 监控 | 性能验收数据 |
| **三 基础记忆能力（MVP）** | 记/忆/忘/察 + 导入导出 + 跨会话回忆 + 删除恢复 | 毕业考（见 §11） |
| **四 智能化扩展（P2）** | 图谱扩散 / 反思 SCHEDULED / LLM 消歧 / 实体合并 / 程序性记忆 / 多 Agent 调度 | 按需启动 |

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
| **10（终审）** | **框架定稿** | **大师裁定：框架无异议，P2 延后；v1.4 为实现依据** |

---

> 龙马负图，图已成形。剩下的，是把这张图画进代码里。
