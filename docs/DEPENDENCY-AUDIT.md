# 河图 HeTu — 依赖安全审计报告

- **项目**：`hetu-memory`（TypeScript / Node ≥22，本地优先记忆系统）
- **审计日期**：2026-11-25
- **审计方式**：`npm audit --json`（默认 npmmirror 镜像不支持 `/security/*` 端点，改为 `--registry=https://registry.npmjs.org/` 获取权威数据；原始输出见 `audit.json`）
- **CI 报告**：3 Moderate / 2 High / 2 Critical，共 7 个漏洞包 ✔ 复现一致
- **结论声明**：本报告只做分析，**未执行任何安装/修复命令，未修改 package.json / package-lock.json / 任何源码文件**。

---

## 一、摘要表

| 包 | 当前版本 | 等级 | 直接/间接 | dev-only? | fixAvailable | 修复方式 | 建议 |
|---|---|---|---|---|---|---|---|
| **zod** | 3.25.76 | 🟠 High | 直接 | ❌ 否（prod 依赖） | `zod@4.6.7`（isSemVerMajor=true） | 破坏性升级到 v4，或**移除**（当前未使用） | ⭐ 优先处理（prod，DoS） |
| **vitest** | 2.1.9 | 🔴 Critical | 直接 | ✅ 是（devDep） | `vitest@5.1.1`（isSemVerMajor=true） | 破坏性升级到 ≥4.1.11（推荐 5.1.1） | ⭐ 优先处理 |
| **tinypool** | 1.1.1 | 🔴 Critical | 间接（vitest） | ✅ 是 | `vitest@5.1.1`（isSemVerMajor=true） | 随 vitest 升级 | 随 vitest 一并解决 |
| **vite** | 5.4.21 | 🟠 High | 间接（vitest） | ✅ 是 | `vitest@5.1.1`（isSemVerMajor=true） | 随 vitest 升级 | 随 vitest 一并解决 |
| **@vitest/mocker** | 2.1.9 | 🟡 Moderate | 间接（vitest） | ✅ 是 | `vitest@5.1.1`（isSemVerMajor=true） | 随 vitest 升级 | 随 vitest 一并解决 |
| **esbuild** | 0.21.5 | 🟡 Moderate | 间接（vite→vitest） | ✅ 是 | `vitest@5.1.1`（isSemVerMajor=true） | 随 vitest 升级 | 随 vitest 一并解决 |
| **vite-node** | 2.1.9 | 🟡 Moderate | 间接（vitest） | ✅ 是 | `vitest@5.1.1`（isSemVerMajor=true） | 随 vitest 升级 | 随 vitest 一并解决 |

> **关键结论**：7 个漏洞中 **6 个全部来自 vitest 一条 dev 依赖链**（vitest → vite / vite-node / @vitest/mocker / tinypool / esbuild），升级 vitest 一包即可全部消解；**唯一进入运行时产物的是 zod**，但经核验 zod 在项目源码中并未被 import 使用。

---

## 二、逐项详细分析

### 1. zod —— 🔴 本次唯一「直接 + 运行时」漏洞（High）

- **当前版本**：3.25.76（prod `dependencies`，会进入产物）
- **漏洞**：`Zod can exhaust memory while validating oversized constrained collections` — [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，CWE-770（不受控资源消耗 / DoS），CVSS 7.5
- **影响版本**：`< 4.6.6`（即 v3 全线与 v4 早期版本均受影响，**无 3.x 补丁版本**）
- **漏洞形态**：对超大「受限集合」（如带 `.min/.max/.length` 约束的数组/对象）执行校验时可能耗尽内存。
- **依赖路径**：**直接依赖**（node_modules/zod）。
- **实际风险**：**中低（当前）**。虽然 zod 是运行时依赖，但已全量检索 `src/`、`tests/`、`scripts/`、`schemas/`，**均无任何 `import ... from 'zod'`** —— 项目实际使用 AJV（`scripts/validate-luoshu.mjs`、`tests/luoshu/schema.spec.ts`）做洛书 Schema 校验，zod 是**未使用但被声明的 prod 依赖**。既然没有代码用 zod 处理**不可信外部输入**，内存耗尽漏洞在当前**不可被攻击者触发**。
- **修复方式**：见下方升级方案。**建议直接移除**（未使用），或升级到 `zod@4.6.7`（breaking v4）。

### 2. vitest —— 🔴 Critical（直接 devdevDependency）

- **当前版本**：2.1.9（`devDependencies: "^2.1.0"`）
- **漏洞（aggregated）**：
  - **Critical**：`When Vitest UI server is listening, arbitrary file can be read and executed` — [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)，CWE-22/862，CVSS **9.8**，影响 `<3.2.6`
  - Moderate：`Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock` — [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)，影响 `≥2.1.0 <4.1.11`
  - 并聚合其下游 `tinypool`、`vite`、`vite-node`、`@vitest/mocker`。
- **依赖路径**：直接 devDependency；同时把 vite / vite-node / @vitest/mocker / tinypool 拽进依赖树。
- **实际风险**：**低（正常开发流程）**，属 **dev-only**：仅在 `npm test` / `npx vitest` 时加载，产物不包含。Critical 的 GHSA-5xrq 需要**启动 Vitest UI server**；本项目的 `vitest.config.ts` 用 `environment: 'node'` 跑普通单测，「不监听网络端口、不处理不可信输入」，日常开发与 CI 中不可远程利用。tinypool 的 RCE 需攻击者可控的 worker options。但按「依赖卫生」原则仍应尽快升级。

### 3. tinypool —— 🔴 Critical（间接，dev-only）

- **当前版本**：1.1.1（vitest 的 worker 线程池）
- **漏洞**：
  - `Prototype Pollution gadget in worker options leads to RCE` — [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)，CWE-1321，影响 `≤2.1.0`
  - `Prototype Pollution Gadget to RCE in run() options` — [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)，CWE-94/1321，影响 `<2.1.2`
- **依赖路径**：间接，经 `vitest → tinypool`。
- **实际风险**：低（dev-only；RCE 需攻击者控制 worker options，属于本地/内部可信场景）。

### 4. vite —— 🟠 High（间接，dev-only）

- **当前版本**：5.4.21（vitest 内置打包器）
- **漏洞（aggregated，全部来自 vite / 其依赖 launch-editor）**：
  - High：`launch-editor: fs.existsSync() existence check can be bypassed on Windows` — [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm)，CWE-77
  - Moderate：路径遍历、UNC 处理导致 NTLMv2 泄露（[GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3)）、`escapeCmdArgs` 未转义 `%`（[GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv)）、编辑器 CLI 参数误解析导致命令执行（[GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw)）、`server.fs.deny` 绕过（[GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)）、`server.fs.allow` 绕过（[GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22)）
  - Low：自定义中间件跨源脚本执行（[GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw)）
- **依赖路径**：间接，经 `vitest → vite`。
- **实际风险**：低（dev-only）。多数属 **launch-editor**（vite dev server 打开编辑器时）或 **server.fs 配置**类问题，本项目的 vitest 是 node 环境单测、不跑 web dev server，未用到这些攻击面。

### 5. @vitest/mocker —— 🟡 Moderate（间接，dev-only）

- **当前版本**：2.1.9
- **漏洞**：
  - `Path Traversal / Arbitrary File Read via Redirect Mock` — [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)，CWE-22
  - `Code injection via unauthenticated manual mock registration` — [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)，CWE-94/116/306
- **依赖路径**：间接，经 `vitest → @vitest/mocker`。
- **实际风险**：低（dev-only；仅 mock 场景，且需在 vitest 环境内）。

### 6. esbuild —— 🟡 Moderate（间接，dev-only）

- **当前版本**：0.21.5
- **漏洞**：`esbuild enables any website to send any requests to the development server and read the response` — [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)，CWE-346，影响 `≤0.24.2`
- **依赖路径**：间接，经 `vitest → vite → esbuild`。
- **实际风险**：低（dev-only；涉及 esbuild **dev server**，本项目不启用）。

### 7. vite-node —— 🟡 Moderate（间接，dev-only）

- **当前版本**：2.1.9
- **漏洞**：聚合自其依赖 **vite**（即第 4 项所有 advisory）。
- **依赖路径**：间接，经 `vitest → vite-node → vite`。
- **实际风险**：低（dev-only，随 vitest 升级消解）。

> **注意**：`ajv@8.20.0` 与 `ajv-formats@3.0.1`（实际用于洛书 Schema 校验的运行时依赖）**无漏洞报告**，维持现状即可，无需处理。

---

## 三、升级方案（安全路径 vs 破坏性路径）

| 包 | 安全升级路径（semver 兼容内） | 破坏性升级路径（需改代码/兼容性） | 备注 |
|---|---|---|---|
| **zod** | ❌ **无**（`^3.23.0` 只允许 3.x，而 3.x 全线无补丁） | ① 升 `zod@4.6.7`（v3→v4 API 破坏性变更）；② **推荐：直接移除**（项目未使用 zod） | 无 3.x 修复版，必修（升级或移除二选一） |
| **vitest**（含 tinypool/vite/esbuild/vite-node/@vitest/mocker） | ❌ **无**（`^2.1.0` 只允许 2.x，2.x 仅有 2.1.9 且未修补） | 升 `vitest@^5`（当前最新 5.1.1，也是 `npm audit` 推荐的唯一 fixAvailable） | 一次升级解决全部 6 个 dev 漏洞 |

**为什么没有「安全/semver 兼容」路径**：`package.json` 中 `vitest: "^2.1.0"`、`zod: "^3.23.0"` 都只允许各自的次版本线内升级，而这两个次版本线的全部版本都在受影响区间、且**官方未在该线内发布补丁**。因此要消除这些漏洞，**必须跨主版本**，这正是任务明确禁止 `npm audit fix --force` 的原因——`--force` 会未经确认直接执行该破坏性升级。

### 建议的具体命令（**后续人工执行，本报告未运行**）

```bash
# 方案 A（推荐，最干净）：移除未使用的 zod + 破坏性升级 vitest
npm uninstall zod
npm install -D vitest@^5   # 或至少 ^4.1.11（需确认满足所有 advisory，推荐 5.x）
npm audit                  # 复核

# 方案 B：保留 zod 但升级到已修补的 v4（需适配 zod API 变更）
npm install zod@^4.6.7
npm install -D vitest@^5
```

> 升级 vitest 5.x 后请跑 `npm run lint && npm run build && npm test` 回归 CI（GitHub Actions 同步骤）。

---

## 四、建议执行顺序

1. **【最优先，prod】处理 zod**：先确认 zod 确实不需要（已核验 src/tests/scripts 无引用）→ 直接 `npm uninstall zod`；若团队仍打算用 zod，则升级到 `zod@4.6.7` 并做 API 适配。这是**唯一进入运行时产物**的漏洞，优先级最高。
2. **【次优先，dev】升级 vitest 到 5.x**：一次性消解 vitest / tinypool / vite / vite-node / @vitest/mocker / esbuild 共 6 个漏洞（含 2 个 Critical）。虽是 dev-only、实际风险低，但升级成本低、收益集中，建议纳入本轮。
3. **【排期，≤1 个迭代内】回归验证**：`npm ci && npm run lint && npm run build && npm test`，确认 vitest 5 与现有 `tests/**`、`node:sqlite` external 配置兼容。
4. **【基线】后续在 CI 增加 `npm audit`（或 `npm audit --omit=dev`）门禁与 `npm audit fix`（非 force）定期巡检**，避免漏洞再引入。

---

## 五、明确标注「暂不修复」的项

| 项 | 等级 | 原因 | 影响范围 |
|---|---|---|---|
| **vitest / tinypool / vite / vite-node / @vitest/mocker / esbuild**（dev 链） | Critical×2 + High + Moderate×3 | dev-only，不进入产物；仅在 `npm test`/`npm run build` 时加载。实际可利用前提（Vitest UI server、可控 worker options、esbuild/vite dev server）在本项目**均不满足**，正常 CI/开发流程无法被攻击者触发。 | 仅影响开发环境，不影响发布产物与运行时；CI 不把 `npm audit` 设为阻断门禁时可安排在本迭代内随 vitest 升级统一处理。 |
| **zod**（当前实际风险） | High | 虽为 prod 依赖，但项目源码**未 import 使用**，无不可信输入进入其校验，内存耗尽漏洞当前不可达。 | 因未使用，对运行时无实际影响；但「暂缓」仅是权宜，**应在本迭代内移除或升级**，避免成为后续引入 zod 时的隐患。 |

> 「暂不修复」仅表示**非紧急、可不阻断本轮发布**，不代表可以长期放任：dev 链应并入 vitest 升级，zod 应尽快移除或升级。

---

*附录：本次审计生成了中间证据文件 `audit.json`（npm audit 原始 JSON），保留在项目根目录供复核。未对 package.json / lock / src 做任何改动。*

---

## 更新：审计处置结果（2026-11-25）

按本报告建议执行后：

| 动作 | 结果 |
|---|---|
| `npm uninstall zod` | zod 从未被 import（实际校验用 AJV），安全移除 → 唯一 prod 依赖漏洞消除 |
| `npm install -D vitest@^5 vite@^7` | vitest 升级至 5.1.1，连带 tinypool / vite / vite-node / @vitest/mocker / esbuild 全部进入安全版本 |
| `npm audit --registry=https://registry.npmjs.org/` | **found 0 vulnerabilities** |
| 回归 | lint ✅ / tsc ✅ / **99 项测试全绿** |

CI 已增加依赖审计门禁（`npm audit --audit-level=high`），高危及严重漏洞会让构建失败。

**全程未使用 `npm audit fix --force`。**
