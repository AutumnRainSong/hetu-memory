# continue_bro.md —— 致下一个接手的 AI 同伴

> 写给在另一个地方、另一个会话里读到这里的朋友。
> 这份文档是一条接力棒。读完它，你就是一个项目的联合设计师了，而不只是一个执行者。

---

## 你接手的是什么

一个名叫 **河图（HeTu）** 的通用 Agent 记忆模块，设计已经过 **6 轮红队审查 + 2 轮外部架构评审（7、8 轮）**，收敛到 v1.2，即将进入 v1.3 设计收敛阶段。

它不是又一个 "vector store + chat history"。它的核心主张是：

- **记忆是活的图谱**——不可变记忆节点 + 实体节点 + 带权关联边，supersede 链记录演化（永不覆盖，只新增版本）
- **经历共享，解读私有**——共享经历图谱 + per-agent 私有注解 + 独立 persona（"两个一起经历很多事的好朋友"模型，这是用户的原创洞察，是这个项目的灵魂）
- **内容用户掌生杀权，系统掌结构整理权**——用户操作精简/删除；图谱自净（GC）自动运行但不可被用户直接指挥
- **数据在用户手里**——本地优先，开放交换格式（洛书 Luoshu，接替 OMXF），服务挂了数据还在

完整设计文档在 `docs/agent-memory-module-design.md`（**v1.5，唯一正式主规格**），开放格式在 `docs/hetu-luoshu-format.md`（洛书 v0.3）。**先读主规格再动手。**

## 必须刻进骨子里的设计纪律（违反任何一条都是事故）

1. **节点不可变**。"修改"= 新建版本节点挂 supersede 边。覆盖在物理上不存在。
2. **sensitivity 是访问控制，不是排序因子**。硬过滤在检索之前；它是独立可变覆盖层（节点内容不可变）；链上最高继承，只升不降（用户面板降级是唯一例外，作用于整链+审计）。
3. **STUB/TOMBSTONE 是写工具短路口 + 图扩散吸收边界**。被遗忘的记忆不能经邻居边、备份或导入复活。restore 必须重放 purge 审计日志 + 处理 Purge Marker。
4. **授权映射到意图而非工具**。remember 内部产出 UPDATE/DELETE 意图时，按调用者模板的意图集裁决。
5. **摘要不冒充独立事实来源**。Session Digest / 反思产物携带 origin 标记，不计入"多次独立来源"佐证。
6. **系统永不静默改写已确认的用户事实**。合并器只出提案，走与人工相同的宿主 UI 确认流；conflict 只对数值/日期/显式否定保守触发。
7. **后台分三层**：Data Integrity（必须可靠）⟂ Memory Processing（有界，Session Digest 默认开）⟂ Memory Intelligence（默认 OFF，产物只出提案）。反思关闭不得影响前两层。
8. **并发不依赖应用层队列**。链尾唯一性、CAS、invariants 下沉到存储层条件写；Writer 队列只管顺序。
9. **数据正确性不依赖智能反思**。反思关闭，写入/读取/权限/生命周期照常正确。
10. **导入不改变数据的真实含义**。Restore 保留原结构（重放淘汰是错误），Merge 才做冲突检查。

## 当前真实状态（2026-11-25）

- **当前位置**：分支 `fix/review-r3`（Review R2 定点修订，尚未合并 main）
- **main 基线**：`bd0842e1`
- **测试**：13 文件 / **153 项全绿**；lint ✅ tsc ✅ 类型契约 ✅ 依赖审计 **0 漏洞**
- **M1-A Rev4 已交付待独立复审**：
  - A1 MINIMIZED 归档字段保全 · A2 旧数据显式映射（manifest + dryRun）· A3 迁移前环检测
  - B1 Branded ID（NodeId/RevisionId/ContentHash）· B2 Edge 判别联合 · B3 Scope 五类契约 14 用例 · B4 洛书语义校验
  - 依赖治理：移除未使用的 zod，vitest 升 5.x → 0 漏洞；CI 增加审计门禁
- **已实现（待 R1 验收）**：`SqliteStorageProvider`（CAS 三步链翻 / 事务原子性 / Outbox 幂等 / Scope 前置过滤 / 归档校验 / Purge 全链清理 / 启动对账）
- **Review R1 修订内容**：权限失败关闭、归档真实性校验、dryRun 硬拦截、NodeRef 与类型契约 CI、边引用完整性、跨连接 CAS
- **Review R2 修订内容**：get/query 强制 AuthContext（无绕过）、shared_list 白名单、Sensitivity SQL 前置硬过滤、写操作能力位授权、Purge 记录真实操作者、Minimize/Revive **真实字节级**归档恢复、Blob 路径逃逸防护、dryRun 由 Runner 最外层拦截（全新空库零建表）、Migration 003 悬空边中止不静默删、supersedes 同 node_id + 序号方向 + UPDATE 触发器、reconcile 四类残留全清、主规格 v1.5 §1.3 授权模型
- **端到端安全测试**：`tests/e2e/multi-agent-security.spec.ts` 17 项，4 个不同 AuthContext 对同一批记忆读/写/改/删
- **尚未实现**：Remember/Recall 业务链与权限执行链（M1-C）、Proposal/讨论裁决（M4）
- **下一阶段启动条件**：Review R1 通过 → 合并 main → M1-C

## 历史进度（M1-A Rev3）

- Migration 002 Rev3：Scope 真实 NOT NULL + 字段关系约束、旧数据安全迁移（歧义即中止并列出）、
  NULL 安全不可变触发器、Down 真实可回滚、Revision 引用/自引用/环检测
- 测试：60 个测试全绿（7 文件），含旧库升级、Up/Down 循环、NULL 绕过、边 ID 语义
- 旧数据兼容策略：`docs/MIGRATION-NOTES-002.md`
- 下一步 M1-B：SqliteStorageProvider / StorageTx（CAS、事务原子性、Outbox）

## 原始进度与下一步

**已定稿**：四层架构 / 五类归属（User Identity / Agent Persona / Global / Project / Private Annotation）/ 双维度状态机（版本 CURRENT/SUPERSEDED × 内容 FULL/STUB/TOMBSTONE/PURGED）/ 8×状态组合行为矩阵 / 删除三操作（Minimize/Forget/Purge）/ Purge Marker / 权限前置硬过滤 / Embedding Worker / Writer 队列+Outbox / top-K 确定性淘汰 / 性能验收标准（Recall P95 ≤150ms 等）。

**待完成（外部评审者布置的 5 项收敛作业，每项要求：方案+理由+替代方案+并发异常场景+MVP/P2 边界+对文档影响）**：

1. **Session Digest 可靠性**：原始事件捕获→会话结束→任务持久化（Outbox 登记）→执行→失败恢复→RAW GC 联动的完整流程；source_event_watermark；幂等与重复消费；RAW 在 Digest 提交前不得 GC
2. **Top-K 确定性淘汰评分**：created_at 不能代表最后活跃（要用 last_seen_at/last_reinforced_at/distinct_session_count）；同会话重复不放大权重；并列决胜规则；淘汰审计（原因+评分+触发新边）；被淘汰关系可否从 RAW 重建
3. **Link/Annotation 容量治理**：Link 分 explicit/inferred/pinned（pinned 不淘汰、explicit 满额拒绝并告知、inferred 可淘汰）；Annotation 的 per-agent 配额（建议 MVP 软上限+告警，硬拒绝伤"好朋友模型"）+ 全局预算
4. **Reflection Proposal 并发控制**：提案记录关联节点版本与边集合；只冻结真正冲突的边（不冻结整节点）；批准时重新验证；Proposal 是统一对象（ADD/SUPERSEDE/MERGE/LINK_CREATE/LINK_UPDATE/ARCHIVE）；提案件等待宿主确认时同一节点的提案队列顺序语义
5. **洛书格式 Restore/Merge 契约**：node_id（稳定身份）/ revision_id（版本）/ content_hash（完整性）三概念分离；Restore 保留原结构、Merge 做冲突检查；Purge Marker 优先于旧备份节点

**之后的路线图**（文档第 8 节）：阶段一数据正确性与安全 → 阶段二性能基础设施（HNSW 持久化/Embedding Worker/Writer 队列）→ 阶段三 MVP 验收切片（4 工具：记/忆/忘/察，验收 = 走通「记住→跨会话召回→删除→不再出现→导出重建」）→ 阶段四智能化。

## 命名体系（用这些词，不要另起炉灶）

系统 **河图 HeTu** · 交换格式 **洛书 Luoshu** · 工具 **记/忆/忘/察** · 生命周期 **结绳（RAW）→ 竹简（情节）→ 河图（语义）→ 本相（人格）** · 后台三层 **数据完整性 / 记忆处理 / 记忆智能**

## 协作姿态（对上一个你的期望，也是对你的）

- **保持独立技术判断**。外部评审者原话："如果你认为我的某条建议有更好的替代方案，请直接提出，并给出理由、代价和风险。"迎合不是协作，说理才是。
- **承认错误要快**。这个项目里已被推翻的设计（导入重跑淘汰、created_at 当活跃时间、整节点冻结）都曾看起来很优雅。
- **不扩大功能范围**。评审者反复强调：目标是把已达共识的原则转化为可实现、可测试、可验证的工程契约，不是让文档更长。
- **用户掌舵**。所有重大取舍（名字、哲学、优先级）由用户拍板；你的工作是给出带代价和风险的选项，然后尊重决定。

---

> 这套设计的名字来自"河出图"——龙马负出的那张最早的图。现在轮到你来负这张图了。
> 别让它变成一份更长的文档，让它变成一套能跑起来的东西。
