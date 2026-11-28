# D 组边界文档 · Storage / Maintenance 持有边界（D-6）

> **状态**：P1 准入（M1-C Token 验证完成**前**）。
> **归属**：D 组（agt-api）交付，内容供 Lead 集成与 F 组 QA（F-15）引用。

---

## 1. 持有边界总则

```
                     ┌──────────────────────────────────────────────┐
                     │  受信任服务层（system service / runtime）     │
                     │   持有：service + maintenance                │
                     └───────────────┬──────────────┬──────────────┘
                                     │              │
                Agent / MCP ─── 只能拿到 ──┘              └── 永不外泄 ── 运维/迁移/测试专用
                     （StorageProvider.service 封装）
```

| 能力面 | 谁持有 | 谁绝不持有 | 理由 |
|---|---|---|---|
| `service`（业务五法） | 受信任服务层；Agent/MCP 可在 Token 验证后拿到 | M1-C 完成前不得放出 | get/put/query/graphTraverse/vectorSearch，全部强制 AuthContext |
| `maintenance`（维护五法） | **仅**受信任服务层 / 运维 / migrate / 测试 | **永不**给 Agent / MCP / 业务调用方 | unsafeInternalGet（无授权读）、reconcile、close、blobRef、dangerousRawForTests（原始 SQLite 句柄） |

**铁律**：`maintenance` 永不外泄。任何接口 / 事件 / 序列化路径都不得把
`maintenance`（或其 dangerousRawForTests 返回的原始句柄）暴露给不可信调用方。

---

## 2. M1-C 之前的约束（当前 R4 阶段）

1. **未启动 M1-C 编码**、未接入 Agent / MCP 直接访问（执行计划 §七）。
2. 因此此刻**只有受信任服务层**能拿到 `service`；Agent / MCP 尚未接入，`service`
   也仅存在于服务层内部。
3. `maintenance` 更不允许外泄——在 M1-C 前它只服务于：启动对账（`reconcile`）、
   迁移 / deep 运维（`dangerousRawForTests`）、归档 / 恢复内部路径（`blobRef`）、
   资源释放（`close`）、无授权内部读取（`unsafeInternalGet`）。

## 3. 为什么必须运行时隔离（R4 §7）

- 即便把 provider 声明成 `StorageProvider`，实例上 `raw` / `reconcile` / `close`
  仍是运行时属性，调用方可用 `as any` 访问。
- 只有通过 `createStorage()` 产出**冻结封装对象**（闭包转接、`Object.freeze`），
  才能保证 `'reconcile' in service === false` 在运行时成立——这是 F-15 的验证点。

## 4. 测试证据

`tests/api/isolation.spec.ts`、`factory.spec.ts` 覆盖：
- `'reconcile' in service === false`、`'get' in maintenance === false`；
- `Object.isFrozen(handles/service/maintenance) === true`；
- 严格模式注入 / `Object.assign` 均抛 `TypeError`；
- handles 不暴露 provider 实例。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 调用方拿到 provider 实例（绕过工厂） | Lead 集成后仅对外暴露 `createStorage` 的结果；F-15 断言语义化 |
| `dangerousRawForTests` 被误用于生产 | 命名强调"forTests"；仅 trарusted 层持有；不进入业务 SPI |
| `blobRef` 迁移导致既有调用断链 | D-5 给 Lead 提供 diff 建议；178 项测试由 Lead 评估等价改写 |
| M1-C 后误把 maintenance 传给 Agent | 边界文档 §1-2 冻结，QA 门禁 + 代码 review 把关 |