# 河图 HeTu · R4 统一任务看板

> **基线**：`ebcd1310e8aa0ac988bd0f6c9fdb1e50b220a148`
> **集成人**：lead　|　**更新**：状态随集成实时刷新
> **图例**：⬜ 未开始　🟦 进行中　🟨 待集成　🟩 已验收　🟥 阻塞

---

## 一、任务总表

| ID | 工作线 | 任务 | 负责人 | 状态 | 依赖 | 分支 | Commit SHA | 测试状态 | 阻塞/风险 |
|---|---|---|---|---|---|---|---|---|---|
| **P0-1** | 集成 | 冻结接口契约（§2.1–2.6） | lead | 🟩 已完成 | — | `r4/integration` | 本文档 | — | 待产品负责人批准 |
| **P0-2** | 集成 | 建 6 条工作分支 | lead | ⬜ 未开始 | P0-1 | — | — | — | 等批准 |
| A-1 | A · Purge | `blob_refs` 台账表（Migration 005） | agt-purge | ⬜ 未开始 | 契约 | `r4/a-purge` | — | — | — |
| A-2 | A · Purge | `registerBlobRefs()` 纯函数（供 put 调用） | agt-purge | ⬜ 未开始 | A-1 | `r4/a-purge` | — | — | 接入由集成人打补丁 |
| A-3 | A · Purge | `planAndMarkPurge()` 逻辑删除 + 引用计数判定 | agt-purge | ⬜ 未开始 | A-1 | `r4/a-purge` | — | — | — |
| A-4 | A · Purge | `runBlobCleanup()` 物理清理 + 二次确认 + 重试 | agt-purge | ⬜ 未开始 | A-3, B-1 | `r4/a-purge` | — | — | 依赖 owner 化路径 |
| A-5 | A · Purge | Migration 004 回滚安全 | agt-purge | ⬜ 未开始 | — | `r4/a-purge` | — | — | 策略待定（见 §八.4） |
| A-6 | A · Purge | 共享 Blob 保护（引用>0 不删） | agt-purge | ⬜ 未开始 | A-3 | `r4/a-purge` | — | — | — |
| A-7 | A · Purge | 跨 owner 隔离删除互不影响 | agt-purge | ⬜ 未开始 | A-4, B-6 | `r4/a-purge` | — | — | — |
| B-1 | B · Blob | `mainRefFor(ownerId,hash)` / `archiveRefFor(ownerId,...)` | agt-blob | ⬜ 未开始 | 契约 | `r4/b-blobstore` | — | — | **最优先，A 组依赖** |
| B-2 | B · Blob | 目标文件 symlink → write/remove 拒绝 | agt-blob | ⬜ 未开始 | B-1 | `r4/b-blobstore` | — | — | — |
| B-3 | B · Blob | root 真实路径校验 | agt-blob | ⬜ 未开始 | — | `r4/b-blobstore` | — | — | — |
| B-4 | B · Blob | 临时文件 + rename 原子写（防 TOCTOU） | agt-blob | ⬜ 未开始 | B-3 | `r4/b-blobstore` | — | — | — |
| B-5 | B · Blob | `remove()` 区分 ENOENT 与其他错误 | agt-blob | ⬜ 未开始 | — | `r4/b-blobstore` | — | — | — |
| B-6 | B · Blob | 跨 owner 物理隔离验证 | agt-blob | ⬜ 未开始 | B-1 | `r4/b-blobstore` | — | — | — |
| C-1 | C · 生命周期 | Minimize 事务内重校验 + 条件 UPDATE + changes 检查 | agt-lifecycle | ⬜ 未开始 | 契约 | `r4/c-lifecycle` | — | — | — |
| C-2 | C · 生命周期 | Revive 同上（含 ref/hash CAS） | agt-lifecycle | ⬜ 未开始 | C-1 | `r4/c-lifecycle` | — | — | — |
| C-3 | C · 生命周期 | 失败孤儿文件登记 | agt-lifecycle | ⬜ 未开始 | C-1, A-1 | `r4/c-lifecycle` | — | — | — |
| C-4 | C · 生命周期 | 跨连接真实并发测试 | agt-lifecycle | ⬜ 未开始 | C-1, C-2 | `r4/c-lifecycle` | — | — | Windows 稳定性 |
| C-5 | C · 生命周期 | 既有测试 `sp.raw` 适配（待 D 组清单） | agt-lifecycle | ⬜ 未开始 | D-3 | `r4/c-lifecycle` | — | — | 等 D 组 |
| D-1 | D · API | `MaintenanceApi` + `createStorage()` 工厂 | agt-api | ⬜ 未开始 | 契约 | `r4/d-api-isolation` | — | — | — |
| D-2 | D · API | `StorageProvider` 剥离维护方法 | agt-api | ⬜ 未开始 | D-1 | `r4/d-api-isolation` | — | — | — |
| D-3 | D · API | Provider 移除 `raw` getter、`blobRef` 迁维护面 | agt-api | ⬜ 未开始 | D-2 | `r4/d-api-isolation` | — | — | 交集成人打补丁 |
| D-4 | D · API | 运行时断言（`in` 检查而非类型检查） | agt-api | ⬜ 未开始 | D-3 | `r4/d-api-isolation` | — | — | — |
| D-5 | D · API | 持有边界文档 | agt-api | ⬜ 未开始 | — | `r4/d-api-isolation` | — | — | — |
| E-1 | E · 迁移 | `preflight()` 纯只读函数 | agt-migration | ⬜ 未开始 | 契约 | `r4/e-preflight` | — | — | — |
| E-2 | E · 迁移 | `runMigrations`/`rollbackTo` 改用 preflight | agt-migration | ⬜ 未开始 | E-1 | `r4/e-preflight` | — | — | — |
| E-3 | E · 迁移 | 普通 edge 悬空检查 | agt-migration | ⬜ 未开始 | E-1 | `r4/e-preflight` | — | — | 当前缺失 |
| E-4 | E · 迁移 | supersedes edge 悬空检查 | agt-migration | ⬜ 未开始 | E-1 | `r4/e-preflight` | — | — | 当前缺失 |
| E-5 | E · 迁移 | 环/歧义/未映射全覆盖 + `blocking` | agt-migration | ⬜ 未开始 | E-3, E-4 | `r4/e-preflight` | — | — | — |
| E-6 | E · 迁移 | blocking 与真实中止一一对应测试 | agt-migration | ⬜ 未开始 | E-5 | `r4/e-preflight` | — | — | — |
| F-1 | F · QA | A×B 交叉：共享 Blob 引用保护 + 跨 owner 隔离 | agt-qa | ⬜ 未开始 | A,B 完成 | `r4/f-qa` | — | — | — |
| F-2 | F · QA | A×C 交叉：purge 与 minimize/revive/新写入并发 | agt-qa | ⬜ 未开始 | A,C 完成 | `r4/f-qa` | — | — | — |
| F-3 | F · QA | B×C 交叉：symlink 下生命周期 + 删除失败重试 | agt-qa | ⬜ 未开始 | B,C 完成 | `r4/f-qa` | — | — | — |
| F-4 | F · QA | 故障注入：EACCES / 进程中断 / rename 失败 | agt-qa | ⬜ 未开始 | A,B | `r4/f-qa` | — | — | — |
| F-5 | F · QA | Migration：004 回滚、005、preflight 一致性 | agt-qa | ⬜ 未开始 | A,E | `r4/f-qa` | — | — | — |
| F-6 | F · QA | API 运行时隔离验收 | agt-qa | ⬜ 未开始 | D | `r4/f-qa` | — | — | — |
| F-7 | F · QA | 178 项回归零弱化 | agt-qa | ⬜ 未开始 | 全部 | `r4/f-qa` | — | — | — |
| F-8 | F · QA | 独立 QA 报告 | agt-qa | ⬜ 未开始 | F-1..F-7 | `r4/f-qa` | — | — | — |
| **I-1** | 集成 | 打 `sqlite-provider.ts` 接入补丁（A-2/A-4 调用） | lead | ⬜ 未开始 | A/B/C | `r4/integration` | — | — | — |
| **I-2** | 集成 | 打 D-3 补丁（移除 raw、迁 blobRef） | lead | ⬜ 未开始 | D | `r4/integration` | — | — | — |
| **I-3** | 集成 | 最终全量门禁（同 HEAD） | lead | ⬜ 未开始 | 全部 | `r4/integration` | — | — | — |
| **I-4** | 集成 | 合并申请 + 交付 | lead | ⬜ 未开始 | F-8, I-3 | `r4/integration` | — | — | — |

---

## 二、阶段进度

| 阶段 | 内容 | 状态 | 出口条件 |
|---|---|---|---|
| **P0** | 契约冻结 + 分支建立 | 🟨 待批准 | 产品负责人批准 R4-EXECUTION-PLAN.md |
| **P1** | A/B/C/D/E 并行开发 | ⬜ | 各组新增测试全绿 + 178 项不退化 |
| **P2** | A+B+C 集成 | ⬜ | Blob 生命周期 + 并发一致性全绿 |
| **P3** | D+E 集成 | ⬜ | API 隔离 + preflight 一致性全绿 |
| **P4** | F 独立验收 | ⬜ | F 报告通过、178 项零弱化 |
| **P5** | 合并申请 | ⬜ | 产品负责人 + 大师审查 |

---

## 三、阻塞项

| 阻塞 | 影响 | 需要谁 |
|---|---|---|
| 计划未获批准 | 全部任务无法开工 | 产品负责人（用户） |
| §八.4 Migration 004 回滚策略未定 | A-5 无法定稿 | 产品负责人（用户） |
| PR #4（R3）未合并 | R4 基线仍是 `fix/review-r3` 分支；不影响 R4 开发，但最终合并需先处理 | 大师 / 用户 |

---

## 四、门禁记录（每个阶段追加）

| 阶段 | HEAD SHA | lint | build | typecheck | test | audit | 结论 |
|---|---|---|---|---|---|---|---|
| 基线 ebcd1310 | `ebcd1310` | ✅ | ✅ | ✅ | 178 ✅ | 0 漏洞 | 基线可用 |
| P2 集成后 | — | — | — | — | — | — | 待填 |
| P3 集成后 | — | — | — | — | — | — | 待填 |
| P4 最终 | — | — | — | — | — | — | 待填 |
