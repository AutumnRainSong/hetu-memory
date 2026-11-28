# Review R1 · 独立验收报告

> 审查基线：`bd0842e1` → 修订分支 `fix/review-r1`
> 审查性质：《M1-B Review R1 定点修订任务书》P0-A / P0-B / P1-C / P1-D / P1-E / P1-F / P1-G 逐项验收
> 验收原则：**不接受"仅测试代码通过"作为结论**；每项必须有真实 Provider 调用或真实 DB 约束的证据

---

## 一、总结论

| 任务 | 结论 | 关键证据 |
|---|---|---|
| **P0-A** Scope 与 Agent 私有空间安全 | ✅ 闭环 | 8 个隔离用例；DB CHECK + 触发器双重约束；无 auth 即拒绝 |
| **P0-B** Minimize / Revive / Purge 数据完整性 | ✅ 闭环（含能力边界） | 归档存在性+Hash 校验，失败不改库；Purge 全链清理+全版本 Ledger |
| **P1-C** Migration Dry Run | ✅ 闭环 | 三种情形（完整映射/默认映射/空库）全部零写库 |
| **P1-D** 类型与编译期测试 | ✅ 闭环 | 独立 `tsconfig.typetest.json`，CI 执行 `npm run typecheck`；`@ts-expect-error` 真实生效 |
| **P1-E** Edge 引用完整性 | ✅ 闭环 | 普通边端点校验 node_id、supersedes 校验 revision_id、重复边拒绝覆盖 |
| **P1-F** 跨连接并发 CAS | ✅ 闭环 | 两个独立 Provider 连同一文件库，同时 CAS → 仅 1 成功、无双链尾 |
| **P1-G** 文档校准 | ✅ 闭环 | README/主规格 v1.5 ADR/研发计划/Migration 说明/continue_bro 全部同步 |

**测试总量：12 个文件 / 126 项测试全绿**（R1 前 115 → +11 项新增，且**未降低任何既有断言**）。

---

## 二、P0-A · Scope 与 Agent 私有空间安全

**问题（审查原话）**：`only if 调用者主动传 scope 才过滤` → 不传可取出全部记录，不能作为正式安全访问方式；`agent_persona` 未强制私有。

**修复**：

1. **`AuthContext` 强制授权上下文**（`src/auth/context.ts`）：`ownerId` / `agentId` / `projectIds` / `canReadGlobal`
2. **`query()` 失败关闭**：`auth` 缺失或字段为空 → 抛 `AuthRequiredError`（`PERMISSION_DENIED`）
3. **授权推导不可绕过**：
   - 强制 `owner_id = auth.ownerId`（工作空间绝对隔离）
   - `project` 层：`project_id ∈ auth.projectIds`（可信成员关系，非客户端自述）
   - `global` 层：需 `canReadGlobal`
   - `persona` / `annotation`：仅 `agent_id = auth.agentId`
4. **客户端 scope 只能收窄**：传未授权 `project_id` → 返回空数组（不泄漏存在性）；传他人 `agent_id` → 空数组
5. **数据库层强制**（Migration 003）：
   - `CHECK (layer NOT IN ('agent_persona','private_annotation') OR visibility = 'owner')`
   - `trg_nodes_persona_private_upd`：UPDATE 时放宽度可见性 → `PERMISSION_DENIED`
6. **`get()` 同样受授权约束**：不可见 → 返回 `null`（等同不存在）

**验收用例（8 项，全部通过真实 Provider 调用）**：

| 用例 | 结果 |
|---|---|
| 无 AuthContext 的 query → 拒绝 | ✅ `PERMISSION_DENIED` |
| 跨 owner 隔离 | ✅ 返回空，不泄漏存在性 |
| Agent A 的 persona 不被 B 读到 | ✅ A 可见 / B 不可见 |
| Agent A 的 annotation 不被 B 读到 | ✅ 同上 |
| 非项目成员读该项目记忆 | ✅ 空结果 |
| `canReadGlobal=false` 读不到 global | ✅ |
| `get` 带 auth 不可见返回 null | ✅ |
| persona 用 `all_agents` 写入被 DB 拒绝 | ✅ 不能靠业务自律 |

---

## 三、P0-B · Minimize / Revive / Purge 数据完整性

**问题（审查原话）**：Minimize 没真归档；Revive 不读归档、先改状态再返回错误（会 COMMIT）；Purge 用 revision_id 删 node_id 边 → 悬空；Ledger 只记一条 revision。

**修复**：

**Minimize**
- `blobRoot` 未配置 → 直接返回 `ARCHIVE_MISSING`（**不允许假成功**）
- 归档文件必须已存在且 SHA-256 与 `archive.hash` 匹配，否则拒绝
- **只有归档校验通过后**才进入事务改 `content_state`（失败即零副作用）

**Revive**
- 归档校验在**任何写操作之前**完成（`verifyArchive` 读文件 + Hash 比对）
- 校验失败 → 返回 `ARCHIVE_MISSING`，**数据库状态不变**（不再出现"返回失败却已 COMMIT"）
- 通过后才在事务内转 `FULL` 并清空 `minimized_*`

**Purge**
- 作用域 = **整个逻辑记忆**（按 `node_id` 查所有 revision）
- Ledger 写入**全部 revision 的 content_hash**（防旧版本经备份/导入复活）
- 普通边按 `node_id` 删除；`supersedes` 边按 `revision_id` 删除
- 验收断言：purge 后**悬空边数 = 0**，Ledger 条目数 = 被擦除 revision 数

**能力边界声明**：生命周期三方法在归档能力未真正完成前不得对外宣称可用；本轮已实现真实归档读写的校验链路，但 `content_ref` 主区 blob 的写入属 M2，README 与 continue_bro 已标注。

**验收用例（6 项）**：无 blobRoot 拒绝 / 归档缺失拒绝 / Hash 不匹配拒绝 / 正确归档成功 / 归档丢失时 revive 失败且状态不变 / purge 后无悬空边 + Ledger 全覆盖。

---

## 四、P1-C · Migration Dry Run

**问题（审查原话）**：完整映射或接受默认映射时，`dryRun: true` 仍可能真实迁移。

**修复**：`dryRun` 检查**前移到迁移最开始**，在加列、回填、建表之前统一拦截并返回报告。报告含总记录数、映射条数、未映射条数、superseded_by 待转换（歧义/悬空）、历史环数、待映射清单。

**验收用例（3 项）**：完整 manifest + dryRun / 默认映射 + dryRun / 空库 + dryRun —— 三者均断言 `PRAGMA table_info(nodes)` 列集合、节点行数、`schema_migrations` 行数**完全不变**。

---

## 五、P1-D · 类型与编译期测试

**问题（审查原话）**：`tsconfig include` 只含 `src/**`，`tests/types` 未被编译；`@ts-expect-error` 未真实生效。

**修复**：
- 新增 `tsconfig.typetest.json`（include `src/**` + `tests/types/**`）
- `package.json` 增加 `typecheck` 脚本
- **CI 增加独立步骤** `npm run typecheck`
- 修正 `@ts-expect-error` 位置（原先放在属性上未生效，已移到语句级并验证真实报错）
- **接口语义分离**：`get(ref: NodeRef)` 区分 `{kind:'node'}` / `{kind:'revision'}`；`minimize/revive` 用 `RevisionId`；`purge` 用 `NodeId`（整逻辑记忆）

**验收证据**：`npx tsc -p tsconfig.typetest.json --noEmit` 通过；人为改坏一行（NodeId→RevisionId 赋值）会立即编译失败。

---

## 六、P1-E · Edge 引用完整性

**问题（审查原话）**：`INSERT OR REPLACE` 无端点校验，测试里指向 `mem-2` 但节点不存在。

**修复**：
- Provider 改 `INSERT`（不再 `OR REPLACE`）
- Migration 003 三个触发器：
  - 普通边 → 端点必须是已存在 `node_id`
  - `supersedes` 边 → 端点必须是已存在 `revision_id`
  - 重复边 → `STATE_CONFLICT`（拒绝静默覆盖）
- 迁移时清理历史悬空边

**验收用例（3 项）**：普通边指向 ghost node 拒绝 / supersedes 指向 ghost revision 拒绝 / 重复边拒绝。**并修正了既有测试中"边指向不存在节点"的隐性缺陷**（先插端点再插边）。

---

## 七、P1-F · 跨连接并发

**问题（审查原话）**：原并发测试同实例 `Promise.all`，无法证明跨连接安全。

**修复与验收**：两个**独立 `SqliteStorageProvider` 实例连接同一 SQLite 文件**，同时以同一 `expectedRevision` 发起 CAS：

| 断言 | 结果 |
|---|---|
| 仅 1 个成功 | ✅ |
| 数据库恰好 1 个 CURRENT | ✅ 无双链尾 |
| WAL + busy_timeout 下的真实冲突处理 | ✅ 未出现 `SQLITE_BUSY` 未捕获 |

---

## 八、P1-G · 文档校准

| 文档 | 变更 |
|---|---|
| `README.md` | 进度改为真实状态：126 测试 / M1-B 已实现待 R1 验收 / 生命周期能力边界声明 |
| `docs/agent-memory-module-design.md` | **升级 v1.5 + ADR**：owner_id = 工作空间边界、AuthContext、私有可见性硬约束、边完整性下沉 DB。**明确标注这是对 v1.4 的显式修订，不静默改变旧结论** |
| `docs/development/第一版研发计划.md` | M1-B 状态改为"已实现，R1 修订中" |
| `docs/MIGRATION-NOTES-002.md` | 升级 Rev4，新增 Dry Run 章节，明确 Manifest 键为 revision_id |
| `continue_bro.md` | 只保留当前分支/基线/真实进度/剩余任务 |
| 本报告 | 新增 |

---

## 九、遗留与明确不做

| 项 | 说明 |
|---|---|
| 主区 blob 真实写入 | 属 M2（Minimize 归档已可校验，但 content_ref 主区文件由 M2 落地） |
| Purge 防复活跨设备 | 需 M4 洛书导入联动 + Purge Marker 端到端测试 |
| Proposal / Discussion / Decision | M4，不属本轮 |
| Remember / Recall 业务链 | M1-C，R1 通过后启动 |
| main 分支保护 | 需仓库 Settings 手动开启（工具无权限），已在报告中标注 |

---

## 十、验收判定

《M1-B Review R1 定点修订任务书》P0-A / P0-B / P1-C / P1-D / P1-E / P1-F / P1-G **七项全部闭环**，且：

- [x] 未降低任何既有断言、未删除旧测试（115 → 126，只增不减）
- [x] 未启动 M1-C，未新增业务功能
- [x] 修订在独立分支 `fix/review-r1`，未直接推 main
- [x] 生命周期能力已标注边界，不作为可用能力对外提供
- [x] `npm audit` 0 漏洞
- [x] CI：lint + build + **typecheck** + test + audit 全绿

**结论：Review R1 可提交 PR 审查；审查通过后方可合并 main 并启动 M1-C。**

---

**报告生成**：2026-11-26 · `docs/QA-ACCEPTANCE-REVIEW-R1.md`
**签署**：待技术负责人复核 · QA 确认 · 产品负责人审查
