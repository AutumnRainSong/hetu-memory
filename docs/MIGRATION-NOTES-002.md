# Migration 002 · 旧数据兼容策略说明（Rev4）

> 交付物 8 / 对应《M1-A 数据模型修订任务书 Rev3》任务 A、B
> 适用版本：Migration 001（M0 结构）→ Migration 002

## 1. 迁移做了什么

Migration 002 通过**重建 nodes 表**施加真实约束（SQLite 无法用 `ALTER TABLE` 添加 `NOT NULL`）：

| 变更 | 方式 |
|---|---|
| Scope 六字段 | `owner_id` / `layer` / `visibility` **NOT NULL**；`shared_with` **CHECK json_valid + json_type='array'** |
| 字段关系约束 | `layer='project' → project_id NOT NULL`；`layer∈{agent_persona,private_annotation} → agent_id NOT NULL`；`layer='private_annotation' → visibility='owner'` |
| RevisionId 分离 | 新增 `superseded_by_revision`；旧 `superseded_by` 废弃为只读（写入触发 `MEM_DEPRECATED_FIELD`） |
| 索引 | 恢复 `idx_nodes_current`（链尾唯一）、`idx_nodes_chain`、`idx_nodes_revseq`、Scope 四索引 |
| 触发器 | 不可变内容（NULL 安全）、生命周期元数据守卫、引用完整性、防自引用、防成环、废弃列保护 |

## 2. 旧数据归属（Scope 回填）策略

**迁移不会擅自把旧记忆归入某个用户。**

- 数据库**已有记忆记录**且未显式提供 owner → 迁移**中止**，报错 `MIGRATION_ABORTED` 并列出待处理记录（最多 20 条 revision_id）。
- 显式提供 owner 后迁移继续：`legacyOwnerId` 选项 / 环境变量 `HETU_LEGACY_OWNER`。
- 回填默认值：`layer='project'`、`project_id='default-project'`、`visibility='project_agents'`、`shared_with='[]'`、`agent_id=NULL`（Global/Project 层允许）。
- 空数据库迁移无需提供 owner。

## 3. 旧 `superseded_by` 转换策略

迁移前逐行校验旧值语义：

| 旧值情况 | 处理 |
|---|---|
| 同 `node_id` 下存在该 `revision_id` | ✅ 迁入 `superseded_by_revision`，关系保留 |
| 匹配到某 `node_id`（跨版本歧义） | ❌ 中止迁移，报 `[AMBIGUOUS]` 并列出记录 |
| 匹配不到任何 revision | ❌ 中止迁移，报 `[DANGLING]` 并列出记录 |

**中止时事务整体回滚**，数据库保持 Migration 001 状态，不存在"迁移成功但关系丢失"。
修复方式：人工确认每条记录应指向的 revision_id（或置 NULL），修正后重跑迁移。

## 4. 回滚

`rollbackTo(db, 1)` 真实执行 Down：按真实触发器名逆序删除 → 重建 001 结构表 →
`superseded_by_revision` 折叠回 `superseded_by` → 恢复 001 索引。
回滚后数据仍在、001 结构可用、可再次 Up（Up/Down 循环测试覆盖）。

## 5. 字段级不变量（任务 D）

**不可变（创建后永不可改）**：`content_hash`、`content_ref`、`ingested_at`、`provenance`
→ 用 NULL 安全比较 `IS NOT`，覆盖 NULL↔非 NULL 的全部变更路径。

**生命周期元数据（允许随合法状态迁移变化）**：`content_state`、`stub_summary`、
`minimized_blob_ref`、`minimized_blob_hash`、`superseded_by_revision`、sensitivity 覆盖层。

守卫：`minimized_*` 只允许在 `content_state='MINIMIZED'` 期间存在，否则 `STATE_CONFLICT`。

## 6.5 Dry Run（Rev4 / P1-C）

`dryRun: true` **在任何条件下都不得修改数据库**（即使 Manifest 完整、即使显式接受默认映射）。

无论是否提供映射、库是否为空，只要 `dryRun=true`，迁移**在写库前统一返回报告并中止**，报告包含：
总记录数 / 显式映射条数 / 未映射条数 / superseded_by 待转换数（含歧义与悬空）/ 历史环数 / 旧 owner 是否提供 / 待映射记录清单。

Manifest 键语义统一为 **revision_id → LegacyScopeEntry**（不是 node_id）。

## 6. 本轮未实现（属于 M1-B）

完整 CAS（同一 NodeId 恰好一个 CURRENT、事务原子回滚、并发冲突单写成功）
由 `StorageTx` 负责（任务 F）。迁移层只保证：引用完整性、序号唯一、防自引用/成环、
`idx_nodes_current` 的"最多一个 CURRENT"存储层防线。
