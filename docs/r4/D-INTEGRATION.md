# D 组集成说明 · Storage / Maintenance 运行时隔离（供 Lead 接入）

> **交付方**：D 组（agt-api） · **目标**：在保留 178 项既有测试不弱化的前提下，
> 让业务面 `service` 在**运行时**不再暴露任何维护能力（`'x' in service === false`），
> 且 `createStorage()` 返回冻结 Facade，不暴露底层 provider 实例。

---

## 1. 现状（需 Lead 在 `sqlite-provider.ts` 上处理）

`SqliteStorageProvider` 目前**同时**携带业务方法与维护方法，两者都在同一实例上：

| 能力 | 当前暴露形态（实例方法/getter） |
|---|---|
| 业务 | `get` / `put` / `query` / `graphTraverse` / `vectorSearch` |
| 生命周期（事务面） | `putWithRevision` / `minimize` / `revive` / `purge` |
| 维护 | `unsafeInternalGet` / `reconcile` / `close` |
| 维护 | `get blobRef()`（R3-04 标记为"仅内部"，但仍在业务实例上） |
| 维护 | `get raw()`（原始 SQLite 句柄，直接可写库） |

这些方法在**同一个对象**上。若把 provider 原样当作 `service` 传给调用方，
`service.raw` / `service.reconcile` / `service.close` 在运行时都是**可访问**的——
这正是 R4 §7 要消除的：不能只是类型区分。

---

## 2. 本组已交付（D-1…D-4）

- `src/storage/spi.ts`（D 组独占）：`StorageProvider` 已**剥离维护方法**，只保留
  `get` / `put` / `query` / `graphTraverse` / `vectorSearch` 五法；`blobRef` 已移除。
  `StorageTx extends StorageProvider` 保留 `putWithRevision`/`minimize`/`revive`/`purge`。
- `src/storage/maintenance.ts`（D 组独占）：`MaintenanceApi` 含 `unsafeInternalGet` /
  `reconcile` / `close` / `blobRef` / `dangerousRawForTests` 五法。
- `src/storage/factory.ts`（D 组独占，新）：`createStorage(provider)` 返回
  `{ service, maintenance }` 两个**互斥封装对象**并 `Object.freeze` 三者。
  `service` = 5 个业务方法闭包；`maintenance` = 5 个维护方法闭包（`blobRef`、
  `close`、`reconcile`、`unsafeInternalGet`、`dangerousRawForTests`）。
  **不返回 provider 实例**——调用方无法 `Object.freeze` 反向解冻。

> 关键：`createStorage` 采用**闭包转接**而非 `provider` 原样返回，所以：
> `service.raw`、`service.reconcile`、`service.unsafeInternalGet` 在运行时 `undefined`
> （`'x' in service === false`），`maintenance.get` / `put` / `query` 同理。

---

## 3. 需 Lead 在 `sqlite-provider.ts` 做的接入（供参考，不代改）

契约 §10：`sqlite-provider.ts` 为 Lead 独占，D 组只交说明。**二选一**，二更彻底。

### 方案 A（最省，依赖现有的 `createStorage` 封装）
保持 provider 现有方法不动。接入方统一通过 `createStorage(sp)` 取得后，
**只把 `service` 交给服务层 / Agent / MCP**，`maintenance` 仅保存在受信任服务层。
无需改 provider。

### 方案 B（推荐，配合契约 §7 "provider 移除 raw/blobRef"）
在 provider 上增加两个**只读 getter** 作为语义化的"视图身份"，同时移除
业务面上的 `raw` 改名为 `dangerousRawForTests`：

```ts
// 在 SqliteStorageProvider 类内新增（方向性建议，最终由 Lead 定稿）
get serviceView(): StorageProvider {
  // 返回只含业务方法的封装；或直接 return this（但此时维护方法仍在），故推荐由
  // factory.createStorage(sp).service 承担 —— 见工厂。
}
get maintenanceView(): MaintenanceApi {
  return ...; // 同理；或把维护方法收敛成独立 facade
}
```

并将：
- `get raw(): Db` → **改名为 `dangerousRawForTests(): Db`**（方法形态）；
- `blobRef(hash): Promise<BlobHandle>` 从业务面语义上**迁入 `MaintenanceApi`**；
- `unsafeInternalGet` / `reconcile` / `close` 在业务面上继续存在亦可，但**运行时
  隔离由工厂闭包保证**——只要调用方拿的是 `service` 封装而非 provider 实例。

> **为什么必须依赖工厂而非单纯类型**：即使把 provider 声明成 `StorageProvider`，
> 实例上仍保留 `raw`/`reconcile` 等运行时属性。只有**新对象闭包 + freeze** 才成立
> `'x' in service === false`。故无论 A/B，最终接入都要走 `createStorage()`。

---

## 4. 本组测试文件（`tests/api/*`）

| 文件 | 覆盖 |
|---|---|
| `maintenance-shape.spec.ts` | D-1：MaintenanceApi 五法签名齐全、blobRef 返回 BlobHandle、dangerousRawForTests 可执行、handles 冻结 |
| `service-shape.spec.ts` | D-2：service 满足 StorageProvider、恰好 5 个业务方法键、无私有字段 |
| `factory.spec.ts` | D-3：返回互斥 handles、三者冻结、freeze 后注入抛错、不暴露 provider 实例 |
| `isolation.spec.ts` | D-4：`in` 断言 service 无维护方法、maintenance 无业务方法、Object.assign 无法注入 |

运行：`npx vitest run tests/api/`

---

## 5. 集成后验收（供 Lead 在接入后复核）

```ts
const { service, maintenance } = createStorage(sp);
('reconcile' in service) === false   // 必须 true（运行时）
('get'     in maintenance) === false // 必须 true
Object.isFrozen(service) === true
Object.isFrozen(maintenance) === true
Object.isFrozen(handles) === true
```