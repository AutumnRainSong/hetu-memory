# 河图 HeTu · 研发团队组建与任务认领书

> 依据：外部评审《第一版研发团队组建及全量工程任务分配书》 · 主规格 v1.4 收敛定稿 · 洛书 v0.3
> 本文档为"实际执行计划"——岗位、认领、依赖、里程碑、验收标准全部落实到可指派粒度。

---

## 一、编制确认（3 核心 + 配套）

| 岗位 | 编制 | 技术负责人角色 | 招聘顺序 |
|---|---|---|---|
| **存储引擎工程师** | 1 全职 · 资深 Staff | ✅ **正式技术负责人**（经存储岗位工程能力考核任命，非自动兼任） | 第一 |
| **服务与安全工程师** | 1 全职 · 中高级 | 服务层与安全负责人 | 第二 |
| **QA / SDET** | 1 全职（预算受限最低 0.5 FTE，从阶段一即参与） | 质量负责人，**独立 Stop-ship 权限** | 第三（尽量与二同步到岗） |
| DevOps / 平台 | 0.2-0.3 FTE 兼职 | CI/CD、构建、打包、Trace | 第四 |
| 外部架构评审 | 阶段末专项 | 阶段一/二/三末三次审查 | 已就位 |
| AI 工程协作 | 不占编制 | 测试生成/矩阵覆盖/fuzz/PR 审查/文档一致性 | 已就位（continue_bro.md 入职） |

管理权责：用户 = 产品负责人（哲学/语义/体验/重大架构批准）；当前员工 = 项目交付负责人（招聘/拆解/进度/风险/汇报）；**存储主程 = 技术负责人**（技术方案/工程标准/技术风险）——不以项目交付身份自动兼任，须经存储岗位能力考核。

## 二、招聘执行顺序与面试考核（照 执行者.md 筛人题执行）

1. **存储主程**：多进程 CAS / SQLite WAL / Purge 后恢复旧备份 三题 + Schema 设计实操
2. **服务与安全工程师**：Scope 隔离 / Sensitivity 前置过滤 / Proposal 两阶段确认 三题 + 接口契约实操
3. **QA/SDET**：Purge 防复活 / RAW Digest 故障恢复 / 洛书 Fuzz 三题 + property-based/fuzz 实操

## 三、工作包认领表（A-H 全量，含依赖与出口）

| 工作包 | 主责 | 协作 | 前置依赖 | 交付物 | 验收标准 | 阶段 |
|---|---|---|---|---|---|---|
| **A 规格/版本/工程基础** | 存储主程 | 服务、QA、交付负责人 | 无 | 唯一基线版本声明（v1.4 收敛定稿，无 v1.5）/ README 修正 / continue_bro 路径修正 / 洛书 version=0.3 与标题统一 / Schema Migration 框架 / 错误码注册表 / behavior-matrix.testdata / CI 门禁 | 全部文档单一事实源；CI 跑通矩阵测试 | 0 |
| **B 状态机与行为矩阵（P0）** | 存储主程 | 服务、QA | A | 10 组合（2 版本 × 5 内容，3 组不可达）× 9 操作矩阵 / 状态迁移图 / 8+ 错误码 / YAML 夹具 / 不可达组合可达性属性测试 | 72+ 格零空格；夹具即测试；N/A 格有可达性证明 | 1 |
| **C Minimize/Forget/Purge/归档（P0）** | 存储主程 | 服务、QA | B | 受控归档区 / Revive 流程 / 归档 TTL 与容量统一策略 / 崩溃对账 / 归档压力测试 | Minimize→Revive hash 一致；Minimize→Purge 归档零残留 | 1 |
| **D Purge Ledger 与防复活（P0）** | 存储主程 | 服务、QA | B | Ledger Schema / 两阶段 Purge / 启动对账 / 五通道防复活 / content_hash 隐私评估（低熵内容泄露+owner-scoped 摘要评估） | 五处残留断言全空；旧备份恢复不复活；kill -9 任意时刻对账收敛 | 1 |
| **E RAW/Digest/背压（P1）** | 存储主程 | 服务、QA | A | Session Digest 全流程 / watermark（**按 Session 分区，防单会话阻塞全局 GC**）/ 三级背压 / 单 session 50MB / stuck 告警 / **RAW_EMERGENCY_DROP 有损性裁决（摘要不构成安全归档，见 §五）** | 底线断言：任何故障序列零未归档 RAW 删除 | 1 |
| **F 洛书 Scope 与数据交换** | 服务与安全 | 存储主程、QA | A/B | 洛书 JSON Schema 定稿（version=0.3 / content_state 四值 / purge_ledger 字段）/ scope 校验器 / Restore+Merge 共用权限管线 / minimized_blob_ref 包内相对路径+完整性验证 / 文件级 vs 节点级 owner 验证关系 | 跨 Agent 隔离属性测试全绿；Restore/Merge 权限判定一致 | 1-2 |
| **G Proposal/Writer/并发** | 服务工程师 | 存储主程（存储层 CAS 共责）、QA | B/E | Proposal 状态机 / logical_memory_id FIFO / 两阶段确认 / TTL/STALE/EXPIRED / Writer 边界 / 多进程并发 | 异常场景测试全过；批准≠提交两阶段验证 | 1-2 |
| **H 检索/Embedding/装配** | 服务工程师 | 存储主程、QA | A/F | Embedding 选型+版本管理 / HNSW+BM25 / RRF / 候选预算 / 批量权限过滤（防 N+1）/ persona pin+floor / Fast Path | 性能四指标达标的分链路耗时报告（冷/热/全链路分列） | 2-3 |

**主设计 §10 十二项待详设**：已按分配书第六节映射到岗位（存储主程 5 项 / 服务工程师 6 项 / QA 主责 1 项），全部登记独立任务 ID，"对应模块实施前交付参数+规则+测试方法+完成定义"。

**跨模块工程问题 10 项**（分配书第七节）：登记技术负责人任务清单，阶段 0-1 内逐项给出契约结论；其中"Minimize/Purge/Archive 的文件系统+DB 崩溃恢复"与"SQLite 多进程写锁策略"列为阶段一 P0。

## 四、`RAW_EMERGENCY_DROP` 有损性裁决（工作包 E 特指问题）

**裁决：摘要不构成安全归档；`RAW_EMERGENCY_DROP` 从设计中移除。**

理由：RAW 的存在价值 = 反思（P2）可回看原始事件 + Digest 失败时的重放来源 + Minimize/Revive 的恢复依据。摘要是有损压缩，一旦允许"摘要内联成功即可删 RAW"，就打开了"压力下静默有损"的口子，违反底线原则。替代策略：死线时**只拒写、不删任何东西**（v1.4 收敛版已是此语义），系统进入只读保护；解除条件 = Digest 恢复或用户显式执行"归档导出+确认清理"（用户主动有损，系统不自动有损）。错误码 `RAW_EMERGENCY_DROP` 移除，保留 `WRITE_PAUSED`。

## 五、里程碑与验收门禁（与主设计 §9、第一版研发计划统一为 M0-M4 五里程碑）

| 里程碑 | 工期 | 内容 | 出口门禁 |
|---|---|---|---|
| **M0 工程准备与设计冻结** | 1-2 周 | 工作包 A 全部 + 六项 P0 DDR + 工程骨架 + CI + 矩阵夹具（80 单元） | 文档单一事实源；DDR-001~006 全 DECIDED；CI 首跑 |
| **M1 最小记忆闭环** | 3-4 周 | Remember → Persist → Recall / 权限过滤 / BM25 基础检索 / 重启持久（内部技术原型） | 六条功能验收 + QA 签认 |
| **M2 记忆生命周期** | 3-4 周 | Revision / Supersede / Minimize / Revive / Forget / Purge / Purge Ledger | 删除与 Purge 验收（通过前不承载真实敏感数据） |
| **M3 后台可靠性** | 3-4 周 | RAW / Outbox / Session Digest / Watermark / Backpressure / 故障恢复 | 底线断言 + 压力测试 |
| **M4 完整 MVP 与发布** | 4-6 周 | 洛书 / Proposal / Embedding / HNSW / RRF / 真实 Adapter / 完整验收 | 毕业考七条门禁 + 大师终验 |

工作包与里程碑映射：A→M0；B→M2（夹具在 M0）；C/D→M2；E→M3；F→M4（schema 在 M0）；G→M4；H→M4。


## 五·补：执行任务认领表（Task ID 级，唯一责任人制）

> 负责人以 GitHub 账号占位（`@lead-assignment` = 待招聘认领）；工作量单位 = 人日；状态 = TODO/IN_PROGRESS/DONE/BLOCKED。
> §10 十二项待详设已编号映射（T-DDR-01~12）。

### M0（工程准备，1-2 周）

| Task ID | 任务 | 负责人 | 协作 | 依赖 | 工作量 | 代码路径 | 测试路径 | 状态 |
|---|---|---|---|---|---|---|---|---|
| T-A-01 | 工程骨架 + CI + lint | DevOps | 全员 | 无 | 2 | `ci/` `.github/` | — | TODO |
| T-A-02 | Migration 框架 + Schema v1（nodes/revisions/edges/outbox/ledger） | 存储主程 | QA | T-A-01 | 3 | `src/storage/migrations/` | `tests/migrations/` | TODO |
| T-A-03 | 错误码注册表（8+4 错误码） | 服务工程师 | QA | T-A-01 | 1 | `src/errors/registry.ts` | `tests/errors/` | TODO |
| T-A-04 | behavior-matrix.testdata.json（80 单元） | QA | 技术负责人 | DDR-001 | 3 | `tests/fixtures/behavior-matrix.testdata.json` | `tests/matrix/` | TODO |
| T-A-05 | DDR-001~006 收敛会 + DDR 记录 | 技术负责人 | 全员+产品 | 无 | 2 | `docs/development/DDR/` | — | TODO |

### M1（最小闭环，3-4 周）

| Task ID | 任务 | 负责人 | 量 | 代码路径 | 测试路径 |
|---|---|---|---|---|---|
| T-B-01 | StorageTx.putWithRevision（Node+Revision+Edge+Outbox 原子） | 存储主程 | 3 | `src/storage/tx.ts` | `tests/tx/atomic.spec.ts` |
| T-B-02 | 链尾唯一性条件写 + CAS_CONFLICT 语义 | 存储主程 | 2 | `src/storage/cas.ts` | `tests/cas/concurrent.spec.ts` |
| T-C-01 | Identity/Token/Scope 校验中间件 | 服务工程师 | 3 | `src/auth/` | `tests/auth/isolation.spec.ts` |
| T-C-02 | remember 工具（闸门 ADD） | 服务工程师 | 2 | `src/tools/remember.ts` | `tests/tools/remember.spec.ts` |
| T-C-03 | recall 工具（BM25+权限前置） | 服务工程师 | 3 | `src/tools/recall.ts` | `tests/tools/recall.spec.ts` |
| T-C-04 | introspect 工具 | 服务工程师 | 1 | `src/tools/introspect.ts` | `tests/tools/introspect.spec.ts` |
| T-C-05 | MCP Server 装配 + 错误响应 | 服务工程师 | 2 | `src/mcp/server.ts` | `tests/mcp/adapter.spec.ts` |
| T-QA-01 | 闭环验收套件（重启持久/隔离/复现） | QA | 3 | `tests/e2e/closed-loop.spec.ts` | — |

### M2（生命周期，3-4 周）

| Task ID | 任务 | 负责人 | 量 | 代码路径 | 测试路径 |
|---|---|---|---|---|---|
| T-B-03 | supersede 链 + 链尾级联 | 存储主程 | 3 | `src/storage/chain.ts` | `tests/chain/` |
| T-C-01a | Minimize 归档区 + Revive（hash 校验/降级） | 存储主程 | 3 | `src/storage/archive.ts` | `tests/archive/` |
| T-C-02a | Forget→TOMBSTONE | 存储主程 | 1 | `src/storage/lifecycle.ts` | `tests/lifecycle/forget.spec.ts` |
| T-D-01 | Purge Ledger 表 + 两阶段 Purge + 启动对账 | 存储主程 | 4 | `src/storage/ledger.ts` | `tests/ledger/` |
| T-D-02 | content_hash 隐私评估（低熵泄露/owner-scoped 摘要方案） | 存储主程+QA | 2 | `docs/development/DDR/DDR-110.md` | — |
| T-QA-02 | 防复活五通道测试 + 矩阵 80 单元全跑 | QA | 4 | `tests/revival/` | — |

### M3（后台，3-4 周）

| Task ID | 任务 | 负责人 | 量 | 代码路径 | 测试路径 |
|---|---|---|---|---|---|
| T-E-01 | RAW 层 + TTL + 配额检查器 | 存储主程 | 3 | `src/raw/` | `tests/raw/quota.spec.ts` |
| T-E-02 | Outbox 消费 + Session Digest（幂等+watermark 按 Session 分区） | 存储主程 | 4 | `src/digest/` | `tests/digest/` |
| T-E-03 | 三级背压 + WRITE_PAUSED + digest_stuck | 存储主程 | 2 | `src/raw/backpressure.ts` | `tests/raw/backpressure.spec.ts` |
| T-QA-03 | 背压压力测试（底线断言：零未归档删除）+ 故障注入 | QA | 4 | `tests/pressure/` | — |

### M4（完整 MVP，4-6 周）

| Task ID | 任务 | 负责人 | 量 | 代码路径 | 测试路径 |
|---|---|---|---|---|---|
| T-F-01 | 洛书 v0.3 序列化/反序列化 + JSON Schema | 服务工程师 | 3 | `src/luoshu/` | `tests/luoshu/schema.spec.ts` |
| T-F-02 | Restore 管线（不重跑淘汰）+ Merge 管线（共用权限管线） | 服务工程师 | 4 | `src/luoshu/pipelines.ts` | `tests/luoshu/roundtrip.spec.ts` |
| T-G-01 | Proposal 状态机 + FIFO + 两阶段确认 | 服务工程师 | 4 | `src/proposal/` | `tests/proposal/` |
| T-H-01 | Embedding Worker + HNSW 持久化 + vectorSearch 实现 | 存储主程 | 5 | `src/vector/` | `tests/vector/` |
| T-H-02 | RRF 融合 + 装配器 + persona pin | 服务工程师 | 3 | `src/recall/` | `tests/recall/rrf.spec.ts` |
| T-QA-04 | 毕业考七门禁全量执行 | QA | 5 | `tests/graduation/` | — |

### 十二项待详设任务映射（§10 → Task ID）

| 待详设项 | Task ID | 负责人 |
|---|---|---|
| 1 Top-K 评分函数 | T-B-04 | 存储主程 |
| 2 时间显式命中误判兜底 | T-H-03 | 服务工程师 |
| 3 链长触顶归档 | T-B-05 | 存储主程 |
| 4 Provenance 惩罚公式 | T-H-04 | 服务工程师 |
| 5 注入检测假阳性处置 | T-H-05 | 服务工程师 |
| 6 golden QA 阈值与阻断 | T-QA-05 | QA |
| 7 persona pin/floor 数值 | T-H-06 | 服务工程师+产品 |
| 8 审计日志保留期 | T-D-03 | 存储主程+产品 |
| 9 Embedding 选型/维度 | T-H-07 | 存储主程 |
| 10 RRF k 值 | T-H-08 | 服务工程师 |
| 11 Proposal TTL/复活规则 | T-G-02 | 服务工程师 |
| 12 top-K=32/Link≤20 压测校准 | T-QA-06 | QA+存储主程 |

## 六、待用户确认项

1. QA 全职 vs 0.5 FTE（建议全职；预算受限则 0.5 + AI 结对补位）
2. 存储主程人选来源（外部招聘 / 现有员工经能力考核任命——分配书明确不得自动兼任）
3. DevOps 兼职人选
4. 里程碑日期锚点（M0 起始日）

确认后本文件即为团队组建交付清单的基线，随招聘进度逐项打勾，全勾即触发"开发启动审查"。
