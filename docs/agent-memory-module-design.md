# 通用 Agent 记忆模块 · 设计文档

> 版本：v1.2（终稿 · 外部评审 + 协商修订版） · 日期：2026-11-20
> 共同设计：用户 × AI 框架设计师 · 经 6 轮红队审查闭环 + 外部架构评审（P0×6/P1×9/P2×9）+ 后台任务/边衰减专项协商
> 落盘位置：C:\Users\F1245552\Desktop\agentMemory\

---

## 0. 定位与边界

- **定位**：跨框架通用记忆层——任何 agent 框架（Claude Code / Cursor / DSH / 自研 agent）均可接入，一份记忆处处可用
- **理念**：本地优先、数据归用户（开放 JSON 格式）、记忆是"活的图谱"、内容用户掌生杀权而系统掌结构整理权
- **明确不做（MVP）**：跨设备同步、云托管、多用户（schema 预留 owner_id）、具身实现（仅 JSON 扩展位）、内置大模型

### 0.1 五类记忆归属（v1.1 P0-5 修订）

> 外部评审确认：原三层归属未回答"Identity 属于用户还是 Agent"。现拆为五类，每节点独立判归属与可见性，**不依赖导出文件 scope 声明判断权限**。

| 归属类 | 属主 | 示例 |
|---|---|---|
| **User Identity** | 用户 | 长期稳定的身份、偏好、事实 |
| **Agent Persona** | agent（用户授予） | 特定 agent 的工作习惯、行为偏好、角色设定 |
| **Global Memory** | 用户（授权共享） | 授权后跨 agent 共享的记忆 |
| **Project Memory** | 项目 | 项目范围内的事实与决策 |
| **Private Annotation** | 单个 agent | 某个 agent 的私有解读 |

---

## 1. 整体架构（四层）

```
┌─ 接入层 ──────────────────────────────────────────────┐
│ MCP Server（薄壳）+ REST API（管理面独立鉴权域）          │
│ 鉴权：服务端分配 agent_id、token↔id 焊死、短 TTL、        │
│       吊销列表即时生效（每工具调用入口检查）、失败锁定      │
├─ 服务层（HTTP 底座）───────────────────────────────────┤
│ 记忆装配器（唯一预算分配器；persona 为带 floor 的租户）    │
│ 召回管线（见 5 节：权限前置硬过滤 → 双路检索 → 复核注入）   │
│ 消歧裁决（高分直取 / 低置信反问；LLM 消歧 P2）            │
│ 写入闸门（if-chain 决策；授权映射到意图而非工具）          │
│ supersede 合并器（只出提案，执行走宿主确认流；可回放）      │
│ 统一 Writer 队列 + Outbox 异步索引更新（v1.1 P1-9）       │
├─ 存储层（Storage SPI）────────────────────────────────┤
│ 六原语：get/put/query/graph-traverse/vector-search/blob  │
│ MVP：SQLite(WAL+Writer队列) + 持久化 HNSW                │
│   （v1.1：索引持久化+Manifest 校验；全量重建仅作损坏兜底，  │
│    后台重建+原子切换）                                    │
│ 链尾唯一性：存储层条件写 + 确定性 tie-break               │
│ 开放 JSON 导入导出（OMXF v0.2，见配套文档）               │
├─ 扩展层（预留）────────────────────────────────────────┤
│ 具身（JSON 扩展位）/ 跨设备 / 云托管 / 多用户 owner_id    │
└──────────────────────────────────────────────────────┘
```

### Embedding Worker（v1.1 P1-8 新增）

- **独立常驻进程**，不放在 SQLite 长事务内、不随请求加载模型
- 查询向量缓存 + 批量计算 + 模型版本管理 + 向量维度校验
- 模型升级 → 旧向量标记版本号 → 后台批量重算 → 原子切换索引

---

## 2. 数据模型

### 2.1 节点（按五类归属 × 双维度状态）

| 节点 | 关键字段 |
|---|---|
| **记忆节点（不可变）** | content blob 引用、modality、置信度、provenance（含 agent 身份）、双时间轴（valid_from/until + ingested_at）、superseded_by。**sensitivity 为独立可变覆盖层**（键=node_id，记审计；召回硬过滤与边继承读覆盖层） |
| **实体节点** | 指向当前版本；hub 实体受 graph-traverse 剪枝契约约束 |
| **空间节点（预留）** | 仅 JSON 扩展位 |
| **私有注解节点** | per-agent；宿主状态迁移联动（3.4） |
| **人格块** | persona（常驻、带上限、**用户可 pin 固定**，不能纯靠引用淘汰）+ 程序性规则（P2） |

### 2.2 双维度状态机（v1.1 P0-1 修订）

> 外部评审指出：原单一状态链混合了"版本有效性"与"内容保留度"两个维度。现拆分：

| 维度 | 状态 | 含义 |
|---|---|---|
| **版本状态** | `CURRENT` / `SUPERSEDED` | 本版本是否为该逻辑记忆的当前版本 |
| **内容状态** | `FULL` / `STUB` / `TOMBSTONE` / `PURGED` | 原文保留程度 |

- 历史版本（SUPERSEDED）可保留原文（FULL），也可被精简（STUB）或删除（TOMBSTONE）——两维度正交组合
- 行为矩阵按 **状态组合** 定义（见 3.2）

### 2.3 边（四种）

- **共现边**：每节点 top-K 硬上限；**满额处理 = 确定性淘汰（v1.1 协商决策）**：新边与权重最弱旧边比较，新边更优则替换，否则拒绝；并列规则=权重相等淘汰 created_at 较旧者；并发经 Writer 队列串行化。MVP 权重=共现次数×时间近因的确定性函数（无衰减）；图扩散失败不影响基础 recall
- **边类型容量约束（分立）**：共现边 top-K；**显式 link 边独立存量上限**（限流只控速率不控存量，默认每节点 ≤20 可配）；supersede 边受链长上限约束（不随时间失效）；annotation 边不设数量上限但宿主 PURGED 时联动清理
- **supersede 边**：单链+链尾存储层唯一+链长上限；旧版本向量索引摘除（仅向量路，BM25 保留全版本）
- **annotation 边**：私有解读 → 共享事实
- **link 边**：初值 ≤ 共现基准 + 限流 + 跨层降置信

**扩散吸收边界**：TOMBSTONE/PURGED 为图扩散吸收边界；sensitivity 继承应用到边。

---

## 3. 生命周期与行为矩阵

### 3.1 删除三操作语义（v1.1 P0-2 修订，消除 MVP 验收矛盾）

> 外部评审发现：原设计 `recall × STUB = 返回摘要` 与验收项"删除后不再出现"矛盾。现三分：

| 操作 | 语义 | 普通 recall 可见？ |
|---|---|---|
| **Minimize（精简）** | 删除原文，保留摘要与关联 | 可见（返回摘要） |
| **Forget（删除）** | 软删除（TOMBSTONE） | **完全不可见** |
| **Purge（硬擦除）** | 清理受控存储与全部派生数据（含向量/FTS/缓存/WAL/备份） | 不可见，物理消失 |

- STUB 的历史信息仅可经**独立历史查询接口**访问（显式授权，与普通 recall 严格分离）
- MVP 验收"删除后不再出现"对应 Forget/Purge，不再与 Minimize 混淆

### 3.2 行为矩阵（按状态组合重定义，v1.1）

核心规则（全表由组合状态驱动，表驱动测试覆盖）：

- 写工具对 TOMBSTONE/PURGED 短路（`MEM_TOMBSTONED` / `MEM_PURGED`）
- Forget × FULL = 转 TOMBSTONE（宿主 UI 确认）；Forget × STUB = 同左
- Minimize × FULL = 转 STUB（可逆）；Minimize × TOMBSTONE = E
- Purge × (STUB|TOMBSTONE|FULL) = purge() 唯一硬擦除入口（单次高危确认 + 最小化审计：id/操作者/时间戳/原因类别）
- recall：FULL(或 STUB 经历史接口)=W；TOMBSTONE/PURGED=**E 不可见**；SUPERSEDED+FULL=时间显式命中正常权重沿链返回，非时间命中硬降权
- revive：仅 TOMBSTONE 可显式恢复；re-created_from 建独立节点不回挂旧链
- introspect：只返回权限位，不暴露内容；suspended 只读、revoked 401

权限模板三级（只读/可写注解/全读写）× 三级写意图（append/状态更新/破坏性）；授权映射到**意图**而非工具；二次确认由宿主 UI 执行，宿主 LLM 无权自确认。

### 3.3 Purge Marker 防复活机制（v1.1 P0-3 新增）

> 场景：A 机 purge → 旧备份导入 B 机 → 复活。原 restore 重放仅覆盖本机备份。

- **Purge Marker** 独立于节点存在：记录节点 ID + 删除序列号/版本 + 时间戳，**不含任何被删正文**
- 随每次导出包携带全量 Marker 列表
- **导入顺序**：先应用 Marker（删除命中项）→ 再导入普通节点
- 旧备份恢复时执行防复活检查；Blob/FTS/HNSW/缓存/WAL/备份/日志全链检查
- **边界声明**：完全离线且长期未同步的备份无法被远程撤销——产品文档明示
- restore 流程保留：重放本机 purge 审计日志

### 3.4 宿主状态迁移 × 注解联动

ACTIVE→SUPERSEDED：注解原位保留；Minimize/Forget：注解跟随内容状态；Purge：注解先墓碑再联动清理；agent revoked：其注解+persona 整体处理（默认 tombstone，用户可选归档），清理主体=服务端 GC。

### 3.5 生命周期分层

RAW（FIFO，TTL 7-30 天，配额 500MB；到期摘要**新建节点**内联，provenance 标 source_expired，系统摘要不计入独立来源）→ 情节层 → 语义层/人格层（多次独立来源=不同会话；两段式确认可回滚）→ 归档遗忘（conflict 仅数值/日期/显式否定保守触发，绝不自动改写）

---

## 4. 写入管线（六步 + 异步解耦）

1. 归属路由（五类归属）→ 2. 质量闸门 → 3. 原子化抽取 → 4. 四操作决策（按意图集授权）→ 5. 建边（别名表+显式确认合并）→ 6. 落盘

**v1.1 解耦原则**：单事务只做数据库写入；Embedding 计算、HNSW 更新、图谱更新、邻域权重刷新全部经 **Outbox 异步**由后台任务消化（受控 Writer 队列，写事务短事务化）。

双通道：hot path（可开关）+ **后台任务双轨制（v1.1 外部协商修订）**：

- **基础设施任务（Data Maintenance，始终运行，不受反思开关控制）**：Embedding 增量计算、HNSW/BM25 索引更新、Outbox 消费、缓存失效、WAL Checkpoint、清理备份、**Session Digest（会话结束摘要——单会话有界提取，MVP 默认开启，是 RAW 到期摘要内联的生成来源）**
- **智能反思任务（Memory Intelligence，可配置）**：三种模式 **OFF（MVP 默认）/ ON-DEMAND（手动触发，MVP 可用）/ SCHEDULED（接口预留，P2 实现）**
- 未来开启反思时的硬约束：不阻塞实时 Recall、独立资源预算、任务去重/幂等/重试/取消、只用空闲资源、产物必须过写入闸门、对已确认事实只产生可审查可回滚的提案
- **冲突划界（反思×边衰减同时开启时）**：反思只动节点内容（提案=supersede），边衰减只动共现/link 权重；节点有未决提案时边冻结衰减；边衰减永不触碰 supersede/annotation 边；每节点单写者（维护任务注册表+节点级锁，接口现在预留）

## 5. 召回管线（v1.1 P0-4 修订：权限前置）

> 外部评审确认：敏感信息是**访问控制**问题而非相关性问题——高相关的高敏记忆不得因权重进入上下文。

```
身份认证 → Scope 权限检查 → Sensitivity 硬过滤（节点级）
  → 向量/BM25 检索 → 候选合并（RRF 融合）
  → 最终权限复核（边级继承 + 图扩散过程复查 + 缓存读取复查）
  → 上下文注入
```

**候选预算**（初始压测参数，可调）：Vector 30 / BM25 30 / Graph 20 / 合并上限 80 / 精排候选 30 / 最终注入 5-15。

图扩散硬限：最大节点访问数/最大边访问数/最大扩散时间/最大单节点扇出/超时降级——**图谱扩散失败不影响基础 recall 返回**。

装配：persona 常驻严格限大小（用户可 pin）+ 长期稳定记忆可缓存 + 项目记忆按项目加载 + 历史原文仅按需加载；削减顺序：叙事线→Top-N 长尾→persona 最后。

## 6. 安全防线

provenance 参与置信度/惩罚 · 注入检测+外壳标记 · 项目层隔离+opt-in · **sensitivity 硬过滤（前置）**+覆盖层+边级继承+复查点（含缓存） · token 吊销即时+每调用检查 · 导出按权限过滤 · trace 落盘前过滤 · purge 审计最小化 + **Purge Marker** · restore 重放 · 硬擦除注解联动

## 7. 评测与运维

- golden QA（召回/消歧/噪声 + 权限泄漏专项 200 条级）
- 行为矩阵表驱动测试（不过不合并）
- OMXF round-trip + fuzz
- **性能验收标准（v1.1 新增，作为测试目标而非假定）**：

| 测试项 | 目标 |
|---|---|
| 纯检索 Recall P95 | ≤ 150ms |
| Persona 装配 P95 | ≤ 10ms |
| 热点 Persona 缓存命中率 | ≥ 95% |
| 增量索引延迟 | ≤ 1s |
| 后台任务对实时 Recall 影响 | ≤ 10% |

- **性能监控十指标**（v1.1 P1-15）：Recall P50/P95/P99、Embedding 耗时、BM25 耗时、HNSW 耗时、SQLite Lock Wait、Index Lag、Cache Hit Rate、Context Token Count、Background CPU/GPU、Recall Timeout Rate；每次 Recall 生成 Trace ID
- 批量读取原则：sensitivity/provenance/版本链/blob 元数据一律 batch（防 N+1）
- 备份：快照+WAL checkpoint+restore 重放 purge+Purge Marker
- schema 版本化迁移 SPI

## 8. 实施路线图（v1.1 四阶段，采纳外部评审顺序）

### 阶段一：数据正确性与安全（先行）
统一生命周期双维度状态机 · Forget/Minimize/Purge 三分语义 · 权限与 Scope 统一 · sensitivity 硬过滤规则 · 主设计与 OMXF 契约对齐 · Purge Marker 机制

### 阶段二：性能基础设施
HNSW 持久化+Manifest · Embedding Worker 常驻 · SQLite Writer 队列+Outbox · Recall Fast Path · 覆盖层批量读取 · 缓存与索引一致性 · 分阶段耗时监控

### 阶段三：基础记忆能力（MVP 验收切片）
Remember / Recall / Forget / Introspect 四工具 + 导入导出 + 跨会话回忆测试 + 删除与恢复测试。验收 = 真实 adapter 走通「记住→跨会话召回→删除→不再出现→导出重建」。

### 阶段四：智能化扩展（P2）
图谱扩散 · 后台反思（资源配额就绪后）· LLM 消歧 · 实体合并 · 程序性记忆 · 多 Agent 资源调度

## 9. 待详设清单

1. ~~top-K 共现边满额淘汰规则~~（已定：确定性淘汰，见 2.3）
2. "时间显式命中"意图分类误判兜底
3. supersede 链长触顶中段并入细节
4. provenance 惩罚公式与阈值
5. 注入检测假阳性处置规则
6. golden QA 通过阈值与阻断策略
7. persona pin 与装配器 floor 数值
8. 审计日志保留期限与擦除权边界
9. Embedding 模型选型与向量维度约定
10. RRF 融合参数（k 值）初始值

## 10. 审查记录

| 轮次 | 范围 | 关键修复 |
|---|---|---|
| 1-4 | 红队逐节 + 矩阵审查 | 投毒防御、身份服务端分配、意图级授权、复活链封死等 |
| 5 | 架构终审 | 链尾存储层唯一、装配器唯一预算、扩散吸收边界、YAGNI 减法 |
| 6 | 致命专项 | sensitivity 覆盖层、restore 重放、合并器提案流 |
| **7（外部评审）** | **全设计 + OMXF** | **状态机双维度拆分、删除三操作、Purge Marker、权限前置硬过滤、五类归属、OMXF 契约对齐、Embedding Worker、Writer 队列、候选预算、性能验收标准** |
| **8（外部协商）** | **后台反思 × 边衰减 GC** | **后台任务双轨制（Data Maintenance 常驻 ∥ Memory Intelligence 三模式 OFF/ON-DEMAND/SCHEDULED）**、Session Digest 机制、反思×衰减冲突划界（提案动节点/衰减动边/未决提案冻结边）、Top-K 满额确定性淘汰、边类型分立容量约束（link 存量 ≤20） |
