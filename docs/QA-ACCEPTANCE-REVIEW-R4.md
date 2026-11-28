# 河图 HeTu · R4 独立 QA 验收报告

> **审查对象**：R4 修订（Purge 两阶段 / Blob 引用 + 对象状态机 / owner 工作空间隔离 / 生命周期 CAS / API 运行时隔离 / Preflight）
> **最终集成 HEAD**：`e361162af0aef75b7001e7b1afe2aa54e92ff30a`（`r4/integration` 分支）
> **QA 组**：agt-qa（独立于 A–E 实现组）　**QA 性质**：独立验证，**不参与任何 `src/**` 实现**
> **验收原则**：只接受走真实 Provider / BlobStore API 的可复现测试证据；不以 CI 绿灯或任务数量代替架构验收；不通过删除/弱化测试过关。

---

## 一、总结论

| 项 | 结论 | 证据 |
|---|---|---|
| **全量测试** | ✅ | **62 文件 / 375 项通过**（含原有 R3 基线 + R4 新增） |
| **QA 专项（tests/qa-r4）** | ✅ | 16 文件 / **34 项通过**（交叉并发 + 故障注入 + 隔离 + 回归清单） |
| **lint** | ✅ | 0 errors / 0 warnings |
| **build** | ✅ | `tsc --noEmit` 0 错 |
| **Branded IDs 类型契约** | ✅ | `tsc -p tsconfig.typetest.json` 0 错 |
| **Migration 测试** | ✅ | 通过 |
| **单元 / 集成 / E2E** | ✅ | 全绿 |
| **依赖安全审计** | ✅ | 0 漏洞 |
| **HEAD 一致性** | ✅ | 所有结果均对 `e361162` 同一 HEAD 执行 |

---

## 二、R4 六条架构裁决验收（对照 `R4-CONTRACTS.md`）

| 裁决 | 验收 | 证据（测试文件） |
|---|---|---|
| **1 · Purge 两阶段**（逻辑删除先提交、物理删除事务外、失败可重试、共享保留） | ✅ | `purge-plan` / `purge-cleanup` / `purge-reconcile` / `qa-r4/shared-ref-protection` / `qa-r4/migration-004-rollback` |
| **2 · 引用事实 + 对象状态机 + 原子认领**（`ACTIVE→DELETING→DELETED`；归零+认领原子；DELETING 拒新引用） | ✅ | `blob-claim`（原子认领单 SQL） / `qa-r4/refzero-newref-race` / `qa-r4/deleting-write-race` |
| **3 · owner 物理隔离**（同 owner 去重、跨 owner 独立文件、Main+Archive 一致） | ✅ | `blob-isolation` / `qa-r4/cross-owner-isolation` / `qa-r4/reuse-same-owner` / `qa-r4/main-archive-consistency` |
| **4 · BlobStore 文件安全**（目标/父目录 symlink、root realpath、TOCTOU、仅 ENOENT 幂等） | ✅ | `blob-symlink-*` / `blob-root-realpath` / `blob-atomic` / `blob-remove-errors` / `qa-r4/symlink-race` / `qa-r4/unlink-failure` |
| **5 · Minimize/Revive 条件提交**（事务内重校验 + CAS UPDATE + changes===1 + 跨连接并发） | ✅ | `lifecycle-cas-unit` / `lifecycle-concurrent` / `lifecycle-cross` / `qa-r4/concurrent-providers` |
| **6 · Migration 004 Down 方案 A**（有未完成任务 → 拒绝回滚） | ✅ | `004-rollback` / `qa-r4/migration-004-rollback` |

---

## 三、QA 专项测试清单（`tests/qa-r4/`，16 文件 / 34 用例）

> 每项标注前置、并发方式、预期、失败数据态（完整断言见各文件，可复现）。

| 场景 | 文件 | 用例 | 覆盖 |
|---|---|---|---|
| 同 owner 多 Agent/Project/Revision 复用同一 Blob | `reuse-same-owner` | 2 | 引用不重复、物理一文件 |
| 不同 owner 同 Hash 物理隔离 | `cross-owner-isolation` | 3 | 两文件、删一另一仍在 |
| Main 与 Archive 引用/清理一致性 | `main-archive-consistency` | 2 | 引用登记与清理一致 |
| 引用归零后另一连接尝试登记新引用 | `refzero-newref-race` | 1 | 原子认领 vs 新登记竞态 |
| Blob 进入 DELETING 后另一 Agent 写相同内容 | `deleting-write-race` | 1 | DELETING 拒新引用 |
| 删除中进程中断 → 重启 reconcile 恢复 | `crash-recovery` | 1 | 中断恢复可续跑 |
| unlink 权限/IO 错误 → 任务保留重试 | `unlink-failure` | 1 | 失败可追踪可重试 |
| 共享引用未归零 → Purge 不删物理文件 | `shared-ref-protection` | 1 | 共享保留 |
| Migration 004 有 pending/failed → 回滚拒绝 | `migration-004-rollback` | 2 | 不丢任务、不 DROP |
| 目标/父目录 symlink + 路径替换竞态 | `symlink-race` | 3 | 外部文件不被触碰 |
| 不同 Provider 同库并发 Minimize/Revive | `concurrent-providers` | 1 | 单向成功 + CAS |
| Minimize/Revive/Supersede/Purge 交叉并发 | `lifecycle-cross` | 3 | 状态机 + 无悬空引用 |
| 新记忆写入与 Purge 并发一致性 | `write-vs-purge` | 2 | 无「有引用但文件缺失」悬空 |
| Dry Run 零写入 + 两类边悬空检查 | `preflight-zero-write` | 2 | 零写入 + 边悬空 |
| Maintenance API 运行时不可绕过 | `api-isolation-runtime` | 4 | `in` 断言隔离 |
| 178→375 回归清单（原断言零弱化） | `regression-inventory` | 7 | 既有测试文件完整、断言保留 |

---

## 四、交叉并发与故障注入专项

- **A×B 交叉**：共享 Blob purge 引用保护 + 跨 owner 同 Hash 隔离（`shared-ref-protection` / `cross-owner-isolation`）
- **A×C 交叉**：purge 与 minimize/revive/new-write 并发（`concurrent-providers` / `write-vs-purge` / `deleting-write-race`）
- **B×C 交叉**：symlink 目录下生命周期 + 删除失败重试（`symlink-race` / `unlink-failure`）
- **故障注入**：`crash-recovery`（进程中断）、`unlink-failure`（EACCES/IO）、`refzero-newref-race`（归零 vs 新登记）
- **并发正确性**：`lifecycle-concurrent` 对照组明确断言「现状双成功缺陷已修复 → 现恰好一成功一 STATE_CONFLICT」

---

## 五、关键修复验证（Lead 集成后由 QA 复跑确认）

| 缺陷 | 修复 | 验证 |
|---|---|---|
| **归档 Blob 永久泄漏（P0，发现于集成）** | minimize 事务内 `registerArchiveForMinimize()` 登记归档对象（ACTIVE+引用）再 CAS 更新 | `r3-security` MINIMIZED purge + `provider` Revive 恢复 |
| reconcile 补偿失效 | reconcile 前置 `reconcileBlobs()`（事务外） | `r3-security` reconcile + `purge-reconcile` |
| F-13 写-删并发死锁 | 改确定性两顺序（purge-first / write-first）走真实 API | `write-vs-purge` |
| 候选 bug（planPurge 删 refs 顺序） | 澄清为 **node 作用域删除、非真 bug** | `purge-shared` / `purge-cross-owner` |

---

## 六、执行命令与结果（均对最终 HEAD `e361162`）

```bash
npx vitest run
#   Test Files  62 passed (62)
#   Tests       375 passed (375)

npx vitest run tests/qa-r4/
#   Test Files  16 passed (16)
#   Tests       34 passed (34)

npx tsc -p tsconfig.json --noEmit        # 0 错误
npx tsc -p tsconfig.typetest.json --noEmit  # 0 错误（Branded IDs 类型契约）
npx eslint src tests                      # 0 errors, 0 warnings
npm audit --registry=https://registry.npmjs.org/  # found 0 vulnerabilities
```

---

## 七、残余风险 / 边界（诚实声明）

1. **HEAD 一致性**：本报告针对 `e361162`；若接手者在别处分叉/继续开发，必须对**新 HEAD** 重跑全部命令，不能沿用本数字。
2. **M1-C 信任链未实现**：`AuthContext` 仍为类型契约；Token 解析、会话绑定、项目成员关系查询归 M1-C，**存储层保证"上下文不完整即拒绝"，但不自行验证签名**。Agent/MCP 直接访问未开放（符合 R4 边界）。
3. **跨设备物理擦除**：不在本轮范围；Purge 物理删除针对本地同一文件系统，跨设备/多副本一致性属 M4。
4. **回归清单断言的粒度**：`regression-inventory` 确认既有测试文件完整存在且 `it(`/`expect(` 计数未下降；极端情况下断言语义等价改写需人工抽查（本报告附 Lead 集成时对 7 项失败逐条判定为「旧断言随 R4 语义更新」的记录）。

---

## 八、签署

- **QA（agt-qa）**：＿＿＿＿＿＿＿＿（待签署）
- **技术负责人 / 集成人（Lead）**：＿＿＿＿＿＿＿＿（待签署）
- **产品负责人 / 架构审查方**：＿＿＿＿＿＿＿＿（待签署）

> 本报告由 QA 独立出具；实现组自测结果与 QA 独立结果**一致**（375 全绿），但 QA 结论不依赖任一实现组的自我声明。