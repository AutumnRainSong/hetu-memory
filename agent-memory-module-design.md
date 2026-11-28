# ⚠️ 此文件已废弃（Deprecated）

## 请使用唯一正式主规格：`docs/agent-memory-module-design.md`（v1.5）

> 本根目录文件曾为 v1.4 规范，现已由 `docs/agent-memory-module-design.md`（**v1.5**）取代。
>
> v1.5 相对 v1.4 的修订（见该文件顶部 ADR）：
> - `owner_id` 正式定义为**工作空间边界**（非 Agent ID）
> - 新增 `AuthContext`（ownerId / agentId / projectIds / canReadGlobal / maxSensitivity / capabilities）作为所有读写操作的**强制授权上下文**
> - `agent_persona` / `private_annotation` **强制 `visibility='owner'`**（DB CHECK + 触发器）
> - 边引用完整性下沉数据库触发器
> - 多用户共享已进入实现基线（不再"预留"）
>
> 为避免读取到两套冲突契约，本文件不再维护正文。请以 `docs/agent-memory-module-design.md` 为唯一权威规范。
