# 河图 v1.4 · 第一版开发前技术收敛报告（收敛产出已并入 v1.4 收敛定稿，工程基线版本号保持 v1.4）

> 五项收敛任务（P0-1/P0-2/P0-3/P1-4/P1-5）专项分析 · 每项按统一七段格式交付
> 本报告为 v1.5 修订依据；范围约束：不推翻 v1.4 架构、不加新功能、不提前实现 P2 项

---

## P0-1：Minimize 的可逆性与原文保留机制

**1. 问题分析**
v1.4 中 Minimize 定义为"删除原文、保留摘要与关联"，又标记"可逆"——原文物理删除后恢复失去依据。若实现者按字面"物理删原文"，可逆性成为虚假承诺；若私下保留原文，则与 Purge"物理擦除"的承诺冲突（Purge 过 Minimize 过的节点时，归档里的原文算不算残留？）。两种理解都导致实现分歧。

**2. 最终方案：方案 (a) 受控归档**
原文在 Minimize 时**移入受控归档区**（controlled archive，独立存储目录），主库只留摘要节点（content_state=STUB）；普通召回路径完全不触达归档区；唯一合法访问 = 独立历史查询接口（显式授权 + 审计）。Revive（恢复）= 从归档区取回原文 → 节点转回 FULL——可逆性有真实依据。Purge 语义随之闭合：Purge 时**受控归档区的原文一并物理删除**（Purge 承诺覆盖全部副本，与备份重放+Purge Marker 同机制）。

**3. 替代方案及不采用原因**
方案 (b) 原文真删仅留摘要：Minimize 变成"低配版 Forget"，与 Forget 的区别只剩 recall 可见性——用户预期"精简=可挽回的省空间"落空，误操作 Minimize 后原文永久丢失，产品不可接受。代价比较：方案 (a) 存储成本 = 原文留存（归档区计入 RAW 类配额，TTL 更长默认 180 天），隐私成本 = 原文仍在本地（但 Purge 边界已闭合）。**风险**：归档区若被遗忘清理会膨胀——归档区单独计数进管理面板。

**4. 异常场景**
归档写入失败（磁盘满）→ Minimize 整体失败回滚（摘要不落盘），错误 `MEM_ARCHIVE_FAIL`；Revive 时归档缺失（已被 180 天 TTL 清理）→ 返回 `MEM_ARCHIVE_EXPIRED`，降级恢复到 STUB 并提示；Purge 与 Revive 并发 → 经 Writer 队列串行，Purge 先执行则 Revive 返回 `MEM_PURGED`。

**5. MVP/P2 边界**
MVP：归档区 + Revive + TTL + Purge 联动。P2：归档压缩（对长期未 revive 的归档做二次精简）。

**6. 测试标准**
① Minimize→revive→原文一致（content_hash 相等）② Minimize→普通 recall 不可见原文仅见摘要 ③ Minimize→Purge→归档区无残留（文件系统级断言）④ Minimize→TTL 过期→revive 返回 `MEM_ARCHIVE_EXPIRED` ⑤ 归档读写权限：普通 recall 路径 0 次触达归档（mock 断言）。

**7. 文档影响**
主设计 3.1 表格 Minimize 行改写 + 新增 3.1.1 受控归档小节；洛书 v0.3 节点增加 `archived_ref` 字段（可选）；行为矩阵 STUB 行的 revive 规则改为"FULL 恢复或 ARCHIVE_EXPIRED 降级"；执行者.md 存储主程职责加归档区。

---

## P0-2：完整行为矩阵与维度统一

**1. 问题分析**
双维度 2×4=8 组合已在 v1.4 确立，但文档只给了规则片段；"工具数"在 Markdown 版表述中出现过 4/7/8 三种（MVP 四工具 vs 全量八操作），测试数量表述也随之漂移。工程师无法确定要实现哪张表。

**2. 最终方案：全量矩阵以"操作全集 × 8 状态组合"单表定义**
操作全集定为 **9 个**：MVP 实现 4（记 remember / 忆 recall / 忘 forget / 察 introspect）+ 设计全量 5（minimize / supersede / reinforce / annotate / link）。矩阵统一表达为：

```
矩阵[状态组合][操作] = ALLOW(迁移) | DENY(错误码) | N/A(逻辑不可能)
```

8 组合枚举：C-FULL / C-STUB / C-TOMB / C-PURGED / S-FULL / S-STUB / S-TOMB / S-PURGED（S=SUPERSEDED）。关键行（未在此列出的组合遵循同构规则，全表见测试数据文件）：

| 组合 | remember | recall | forget | minimize | supersede | revive |
|---|---|---|---|---|---|---|
| C-FULL | W(闸门) | W | W→C-TOMB | W→C-STUB | W(建链) | N/A |
| S-FULL | DENY(MEM_SUPERSEDED,附指针) | 时间显式=正常权重沿链；否则硬降权 | W→S-TOMB(整链) | W→S-STUB | W(链尾继续) | N/A |
| C-STUB | DENY(MEM_STUB_IMMUTABLE) | W(仅摘要) | N/A(已是 STUB) | N/A | DENY(无原文) | 经归档 W→C-FULL；归档过期→保持 STUB |
| S-STUB | DENY 短路 | W(仅 stub 句供链追溯) | N/A | N/A | DENY | DENY |
| *-TOMB | DENY 短路 | **E 不可见** | N/A | N/A | DENY | W(显式恢复→回 FULL，宿主确认) |
| *-PURGED | W(等同全新记忆) | E | E | E | E | E（re-created_from 独立节点） |

注：C-TOMB 的 forget×TOMBSTONE 是 purge() 豁免口（v1.3 已定）；`N/A` = 操作对状态逻辑无意义（如对已是 STUB 的节点再 Minimize），返回 `MEM_INVALID_STATE`；所有 DENY 必须附错误码，不留空。

**3. 替代方案**
仅维护"MVP 四工具 × 当前版本状态"的窄表：省事但 SUPERSEDED 分支无人定义，第二批工具接入时必然撞表。不采用。

**4. 异常场景**
并发 supersede 分叉 → 存储层条件写保证单链（v1.4 已定）；introspect 对任意状态可用（返回权限位）。

**5. MVP/P2**
MVP 实现全表（表驱动测试 8×9=72 格全覆盖）；minimize/supersede/reinforce/annotate/link 的**工具入口**可 P2 开放，但矩阵语义 MVP 必须定死——闸门内部意图已会产生这些状态迁移。

**6. 测试标准**
矩阵数据文件 `behavior-matrix.testdata.json` 每格一条用例；CI 断言：实现行为 == 表，一格不过全不合并。**72 格 + 错误码断言，全通过。**

**7. 文档影响**
主设计 3.2 整节替换为本矩阵；错误码表新增 `MEM_INVALID_STATE`/`MEM_ARCHIVE_EXPIRED`；continue_bro.md 纪律第 3 条补"72 格"数字。

---

## P0-3：PURGED 的最终语义

**1. 问题分析**
Purge 要求物理删除，PURGED 又是状态机的终态——若 PURGED 是节点上的字段，则"物理删除的节点"还带着字段躺在库里，自相矛盾；若节点删了，"状态"又依附在什么上？不解决则 Purge Marker 与状态机的关系悬空。

**2. 最终方案：方案 (b) 独立擦除账本（Erasure Ledger）**
**PURGED 不是节点状态，而是擦除账本中的一条记录**。Purge 执行 = ①物理删除节点行/边/blob/向量/FTS/缓存 ②在 erase ledger 追加一条 `{node_id, purge_seq, operator, timestamp, reason_class}`（无任何内容字段）③Purge Marker 同步（导出携带的即此账本的快照）。数据库中不再存在该节点的任何行——**状态机里的 PURGED 从节点状态改为账本引用**：查询某 id 时先查 ledger，命中即返回 `MEM_PURGED`。这同时给出防复活的最强形式：restore 后 ledger 重放有据可依（ledger 本身随备份走且只增不减）。

**3. 替代方案及不采用原因**
方案 (a) PURGED 作为库内逻辑终态（节点行保留、内容清空）：实现简单，但"节点行还在"意味着 id 索引、revision 链指针、边引用都可能成为复活通路，且每条 PURGED 记录长期占用主库——**擦除的彻底性依赖开发者的持续自觉，不可接受**。代价对比：(b) 需要 ledger 单独表 + 所有 id 查询前置 ledger 检查（一次索引查询，开销可忽略）。

**4. 异常场景**
并发 Purge 与 supersede → Writer 队列串行，Purge 优先；备份 restore → ledger 重放二次清除（v1.3 机制）；旧备份导入 → Marker 先应用；Purge 与导出并发 → 导出快照取 purge 前状态则快照含 Marker（下轮导出修正）——接受窗口并在文档声明。

**5. MVP/P2**
MVP：ledger 表 + 查询前置检查 + Marker 全链。P2：ledger 压缩（超老记录归档），需重新评估 Marker 语义——延后。

**6. 测试标准**
① Purge 后 DB 无节点行/边行/blob 文件/向量点（四类存储分别断言）② 任意 id 查询返回 `MEM_PURGED` ③ restore 旧备份后该 id 仍不可见（ledger 重放生效）④ 导出包不含已 purge 内容但含其 Marker ⑤ ledger 记录不含任何 content 字段（schema 断言）。

**7. 文档影响**
主设计 2.2/2.3（状态机与边表）加"PURGED 由擦除账本承载，节点物理不存在"注记；3.3 与账本合并描述；洛书 purge_markers 字段说明改为"擦除账本快照"；行为矩阵 `*-PURGED` 行语义不变（查询前置 ledger 命中即 DENY）。

---

## P1-4：RAW 配额与 Digest 失败的背压机制

**1. 问题分析**
四个保证互相竞争：RAW 不超 500MB / Digest 失败 RAW 不 GC / 新事件持续写入 / 不静默丢未归档记忆。无背压设计时，Digest 故障 + 持续写入 = 配额打满后系统只能"违规 GC"或"停摆"，开发者会在压力下做出静默丢数据的临时方案——这是评审者划的底线。

**2. 最终方案：双阈值 + 分级背压 + Digest 补偿优先**

| 阈值 | 触发 | 行为 |
|---|---|---|
| 软阈值 400MB（80%） | 接近上限 | 告警（面板+trace）；**暂停一切非必要后台任务**（含 P2 反思、归档压缩），Digest Worker 提级为最高优先级；继续接收写入 |
| 硬阈值 500MB（100%） | 达限 | **RAW 写入拒绝**，agent 收到 `RAW_QUOTA_EXCEEDED`（结构化错误，含建议动作"结束会话触发 Digest"）；**热点记忆路径（情节层及以上）不受影响**；已存在 RAW 的会话仍可追加（允许小缓冲 5%） |
| 超大 Session | 单会话 > 剩余容量 | 该会话 RAW 分片落盘 + 立即触发该会话的 Digest（不等会话结束），分片处理完毕即释放 |

**Digest 失败专属策略**：连续失败 3 次 → 该 Digest 任务转 `FAILED_RETRIABLE`，指数退避重试；**RAW 的 GC 水位线永远跟随"最小未完成 watermark"**（最小 watermark 之前的 RAW 才可 GC）——Digest 全挂时 watermark 不前进，RAW 停止 GC、写入被拒，**系统进入"只读保护"而不是"静默清理"**。磁盘真满（写入也失败）→ 最后手段：丢弃最旧 RAW 前必须先把其摘要内联成功（宁可摘要无 RAW，不可 RAW 无摘要）；此行为打 `RAW_EMERGENCY_DROP` 审计。

**3. 替代方案**
"RAW 超限直接 LRU 清理"：实现最简单，但违反底线（清理未归档记忆）。"无配额、只靠 TTL"：磁盘打满风险转嫁给用户。均不采用。

**4. 异常场景**
重启恢复：Outbox 未消化任务按幂等键重放，watermark 从持久化值恢复；Outbox 积压 >1h → 告警 + 拒绝新 Digest 入队（防饿死）但 RAW 写入不受影响；Digest 成功但写摘要失败 → 任务重试，watermark 不前进。

**5. MVP/P2**
MVP：双阈值 + watermark GC + 拒绝错误码 + 重试。P2：分 Session 独立配额、背压时的降级排序策略。

**6. 测试标准**
压力测试用例：①模拟 Digest 全挂 + 持续写入 → RAW 到 500MB 后写入被拒且 0 条未归档 RAW 被 GC（GC 日志断言）②Digest 恢复 → watermark 前进 → 拒绝解除 ③超大 Session 分片 → 单会话 600MB 数据正确消化 ④重启 → watermark 与队列恢复一致。

**7. 文档影响**
主设计 3.5 结绳行扩展 + 新增 5.1 背压小节；错误码 +2（`RAW_QUOTA_EXCEEDED`/`RAW_EMERGENCY_DROP`）；执行者.md 存储主程验收加压力测试三项。

---

## P1-5：洛书节点级 Scope 与可见性契约

**1. 问题分析**
v0.2 只有文件级 owner_id——导入方无法判断单节点归属，多 agent 场景下私有注解/persona 会随全量导出泄露；"节点可见性"在 v1.4 已是逐节点判定的（0.1 五类归属），导出格式却只有文件级声明，契约不对称。

**2. 最终方案：节点自带完整 Scope 五元组 + 双层过滤**

每节点增加 scope 对象：
```json
"scope": {
  "owner_id": "default",
  "layer": "identity | global | project | persona | annotation",
  "project_id": "proj_001 | null",
  "agent_id": "claude-main | null",
  "visibility": "shared | agent-private"
}
```

**文件级 scope 的职责收缩为**：导出参数声明（这次导出包含哪些 layer/project 的过滤条件）+ 导出者身份——**不是权限的判定依据**。判定永远读节点级 scope。

**导出过滤规则**：默认仅导出 visibility=shared；agent-private（persona/annotation）需显式指定 agent_id 且逐类授权；User Identity 默认导出（属用户本人）。

**导入权限验证**：①导入方身份比对 scope.owner_id（不同 owner → 整包拒绝）②agent-private 节点比对 scope.agent_id 与导入凭证（不匹配 → 跳过该节点 + warning 计数，**不静默注入**）③Restore 与 Merge **使用同一套节点级权限验证规则**（差异只在冲突处理，不在权限判定）④persona 导入到不存在对应 agent 的库 → 落为 pending state 待认领或按配置丢弃。

**3. 替代方案**
"文件级 scope + 信任导入方"：实现零成本但私有泄露通道完整保留（A agent 的全量私有空间被 B 导入）。不采用。

**4. 异常场景**
跨 owner 导入 → 403 语义（`LUOSHU_OWNER_MISMATCH`）整包拒；部分节点 agent 不存在 → skip+warning 计数（fuzz 覆盖）；Restore 场景 agent 已 revoked → 注解按 3.4 联动（tombstone）；Merge 场景同节点双方都改 → 走冲突报告不静默合并。

**5. MVP/P2**
MVP：五元组字段 + 导出过滤 + 导入验证 + 跨 owner 拒绝。P2：细粒度 visibility（按 agent 分组共享白名单）。

**6. 测试标准**
①多 agent 库导出 → 默认包 0 条 agent-private 节点 ②显式授权导出 → 私有节点带 scope 完整 ③B agent 导入含 A 私有节点的包 → A 私有节点被跳过且 warning 计数正确 ④跨 owner 整包拒绝 ⑤Restore 与 Merge 对同一异常包的权限判定结果一致。

**7. 文档影响**
洛书升 **v0.3**（scope 对象 + 双层过滤 + 错误码 `LUOSHU_OWNER_MISMATCH`）；主设计 0.1 补"权限判定只读节点级 scope"；continue_bro.md 纪律第 4 条补充"导出文件级声明不是权限依据"。

---

## 技术债清单（非阻塞，一句话一条）

1. erase ledger 长期膨胀 → P2 压缩（需重估 Marker 语义）
2. 归档区 180 天 TTL 的数值需实测校准
3. RRF k 值、provenance 惩罚公式 → 实现期压测定
4. 超大 Session 分片的 Digest 粒度（分片大小）→ 压测定
5. MCP elicitation 在不同宿主的兼容性差异 → 实现期验证

## 汇总：文档影响总表

| 文档 | 变更 |
|---|---|
| 主设计 | 3.1 重写（受控归档）· 3.2 整节换 8 组合矩阵 · 2.3 加 PURGED 账本注记 · 3.5+5.1 背压 · 错误码 +4 · 0.1 补节点级 scope 原则 |
| 洛书 | v0.3：scope 五元组 / archived_ref / 擦除账本快照 / 双层过滤 / LUOSHU_OWNER_MISMATCH |
| continue_bro.md | 纪律 3 补 72 格数字；纪律 4 补"文件级声明非权限依据" |
| 执行者.md | 存储主程职责+归档区；协议工程师+背压/ledger；测试门禁 +3 项 |
| 测试规范 | behavior-matrix.testdata.json（72 格）+ 背压压力测试 + 防复活四断言 + Scope 隔离五用例 |
