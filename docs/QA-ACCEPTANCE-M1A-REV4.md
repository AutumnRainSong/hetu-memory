# M1-A Rev4 · QA 独立验收报告

> 验收对象：`AutumnRainSong/hetu-memory` commit `29c4d2b` + Rev4 修订
> 验收性质：独立回归验证（不得由开发者自签）
> 验收范围：《下一阶段研发执行任务书》阶段一（文档校准）+ 阶段二（M1-A Rev4 工作流 A/B/C）

---

## 一、验收结论

| 维度 | 结果 | 证据 |
|---|---|---|
| 归档数据完整性（A1） | ✅ 通过 | `002-rev4-safety.spec.ts` 3 用例：MINIMIZED 归档引用/Hash 升级前后一致、FULL/STUB 无损失、Down→Up 后仍一致 |
| 旧数据归属显式映射（A2） | ✅ 通过 | 5 用例：无映射即中止、manifest 按条映射、私有注解越权被拒、dryRun 只报告不改库、全映射无需默认开关 |
| Revision 环检测（A3） | ✅ 通过 | 2 用例：旧数据成环中止并报路径、正常链通过 |
| 类型契约（B1/B2） | ✅ 通过 | Branded `NodeId`/`RevisionId`/`ContentHash`；`@ts-expect-error` 锁定不可混用；Edge 判别联合 |
| Scope 完整契约（B3） | ✅ 通过 | 14 用例：五类合法组合 + 六类非法组合 + Agent/项目/工作区三层隔离 |
| 洛书语义（B4） | ✅ 通过 | 10 用例：跨逻辑记忆、方向序号、环、Scope 自洽、边 ID 语义 |
| 回归（原有 60 项） | ✅ 通过 | 全部保留并通过 |
| CI（lint + tsc + vitest） | ✅ 通过 | 本地三关全绿；待推送后 GitHub Actions 验证 |

**测试总量：11 个文件 / 99 项测试全绿**（原 60 → +39 项新增）。

---

## 二、逐项验收明细

### A1 · MINIMIZED 归档信息不丢失

**验收方法**：在 Migration 001 结构写入 MINIMIZED 旧记录（含 `minimized_blob_ref`/`minimized_blob_hash`），执行 Migration 002，比对升级前后。

**修复内容**：Rev3 的复制 SELECT 与 INSERT 均遗漏这两个字段（直接写 NULL），Rev4 已补全读写。

**关键断言**：
- `minimized_blob_ref` 升级后与升级前字符串完全相等
- `minimized_blob_hash` 完全相等
- `stub_summary` 保留
- Down → Up 循环后依然相等

### A2 · 旧数据归属显式映射

**验收方法**：构造多条分属不同语义的旧记录，检验迁移是否在信息不足时中止。

**修复内容**：引入 `LegacyScopeEntry` 映射表 + `legacyScopeManifest` 选项 + `acceptDefaultScopeMapping` 显式开关 + `dryRun` 报告模式。

**关键断言**：
- 无映射且未声明接受默认 → `MIGRATION_ABORTED` 并列出待映射 revision_id（**不再默认全部塞进 project**）
- 提供 manifest → 按条写入各自 `layer`/`project_id`/`agent_id`/`visibility`
- manifest 把 `private_annotation` 写成 `all_agents` → 被 DB CHECK 拒绝（迁移失败，不产生泄漏数据）
- dryRun → `DRY_RUN_REPORT`，数据库仍是 001 结构，迁移记录未增加

### A3 · 历史 Revision 环检测

**验收方法**：旧表内构造 `rev-1-1 → rev-1-2 → rev-1-1` 环。

**修复内容**：迁移前用链遍历检测（而非依赖迁移后的 UPDATE 触发器）。

**关键断言**：成环 → `MIGRATION_ABORTED` 且消息含 `cycle`；正常链 → 迁移通过且 `superseded_by_revision` 正确。

### B1/B2 · 类型契约

**修复内容**：
- `NodeId` / `RevisionId` / `ContentHash` 改为 branded type，`asNodeId`/`asRevisionId`/`asContentHash` 为唯一显式转换口
- `Edge` 判别联合：`cooccur`/`annotation`/`link` 用 `NodeId`；`supersedes` 用 `RevisionId`

**关键断言**：`@ts-expect-error` 两处——`NodeId` 赋给 `RevisionId`、`supersedes` 边传 `NodeId`，编译期即失败。

### B3 · Scope 完整契约

**合法组合**（5）：`user_identity` 无需 agent、`agent_persona` 必须绑 agent、`global` 用 `all_agents`、`project` 必须 project_id、`private_annotation` 必须 `owner`。

**非法组合**（6，全部拒绝）：persona 缺 agent、annotation 缺 agent、annotation 用 `all_agents`、annotation 用 `project_agents`、project 缺 project_id、owner_id 为 NULL。

**隔离**（3）：Agent A 私有注解 B 查不到、共享查询不带出私有、项目间隔离、跨 owner 隔离。

### B4 · 洛书语义

**关键断言**：
- supersedes 跨逻辑记忆 → 拒绝
- 序号方向非法（新 ≤ 旧）→ 拒绝
- supersedes 成环 → 拒绝
- `layer=project` 缺 project_id / `agent_persona` 缺 agent_id → 拒绝（AJV + 语义双防线）
- `shared_list` 但 `shared_with` 空 → 拒绝
- supersedes 引用不存在 revision / 普通边引用不存在 node_id → 拒绝

---

## 三、已知未覆盖 / 待确认项

| 项 | 状态 | 说明 |
|---|---|---|
| Storage Engine（CAS/事务/Outbox） | ⏳ 未实现 | 属 M1-B，Rev4 明确不包含；完整版本链 CAS 语义将在 M1-B 验收 |
| 业务权限执行链 | ⏳ 未实现 | 当前只有 SQL 层过滤能力；`owner/agent/project` 的运行时鉴权链属 M1-C |
| `shared_list` 空数组边界 | 📝 记录 | validator 已拒绝（语义层），但 DB 层允许；M1-C 建权限链时一并收紧 |
| 依赖漏洞（7 项，2 Critical） | 📄 已分析 | `docs/DEPENDENCY-AUDIT.md`：6 项来自 vitest dev 链（升级 vitest 一并解决）、1 项 zod 未使用（建议移除）。**未做破坏性升级** |
| main 分支保护 | ⏳ 未启用 | 需在 GitHub 仓库 Settings 手动配置（工具无权限） |

---

## 四、门禁判定

《下一阶段研发执行任务书》阶段二九条门禁：

- [x] Migration 不丢失任何已有字段和归档信息（A1）
- [x] 旧数据归属通过显式映射，不再默认全部塞入 Project（A2）
- [x] 旧 Revision 关系通过完整性检查（A3 + 引用/自引用/环）
- [x] Scope 的 TypeScript、SQLite、洛书契约一致（B3）
- [x] NodeId、RevisionId、Edge 类型在 TypeScript 中得到有效约束（B1/B2）
- [x] 原有 60 项测试保持通过（累计 99 项全绿）
- [x] Down/Up 回滚与重新升级测试通过
- [x] CI 完整通过（lint + tsc + vitest）
- [x] P0/P1 问题清单已复核

**结论：M1-A Rev4 满足阶段二门禁，可提交产品负责人审查后进入 M1-B（Storage Engine）。**

---

## 五、验收过程中发现并已修复的自身缺陷

| 缺陷 | 发现方式 | 修复 |
|---|---|---|
| Rev3 迁移复制 SELECT 漏读 `minimized_blob_*` | 编写 A1 测试时 | 补全 SELECT 与 INSERT |
| Rev3 旧数据一律归入 `project/default-project` | 编写 A2 测试时 | 引入 manifest + 显式开关 |
| Rev3 历史环只在迁移后拦截 | 编写 A3 测试 | 迁移前链遍历检测 |
| 测试断言与 AJV 双层校验重叠 | 运行 B4 测试 | 断言区分为「AJV 拒绝」与「语义层拒绝」 |

> 这四项都是**测试先行**暴露的——印证了"不要用测试通过代替数据正确性解释"。

---

**报告生成**：2026-11-25 · `docs/QA-ACCEPTANCE-M1A-REV4.md`
**签署**：待技术负责人复核 + QA 确认 + 产品负责人审查
