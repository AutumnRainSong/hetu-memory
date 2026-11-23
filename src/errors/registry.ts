/** 河图统一错误码注册表（主规格 §3.2/§4.3/洛书 v0.3）
 *  唯一事实源：新增错误码必须先在此登记，再使用。
 */
export const ErrorCodes = {
  STATE_CONFLICT: 'STATE_CONFLICT',           // 状态不允许该操作（含 SUPERSEDED × 删除/归档态不可达组合）
  PURGED_FINAL: 'PURGED_FINAL',               // 已永久擦除（Purge Ledger 命中，不可恢复）
  STUB_IMMUTABLE: 'STUB_IMMUTABLE',           // 摘要节点不可补写原文
  ARCHIVE_MISSING: 'ARCHIVE_MISSING',         // Minimize 归档原文丢失/哈希不匹配（恢复降级为摘要级）
  INVALID_STATE: 'INVALID_STATE',             // 操作对该状态无意义
  QUOTA_HARD_LIMIT: 'QUOTA_HARD_LIMIT',       // 全局硬预算达限（Annotation 等）
  PERMISSION_DENIED: 'PERMISSION_DENIED',     // 层归属/visibility 校验失败
  WRITE_PAUSED: 'WRITE_PAUSED',               // RAW 背压死线：拒绝写入（recall 不受影响）
  MARKER_CONFLICT: 'MARKER_CONFLICT',         // 导入内容命中 Purge Ledger（防复活拦截）
  RAW_QUOTA_EXCEEDED: 'RAW_QUOTA_EXCEEDED',   // RAW 配额超限
  SESSION_RAW_QUOTA: 'SESSION_RAW_QUOTA',     // 单 Session RAW 上限（50MB）
  DISK_FULL: 'DISK_FULL',                     // 宿主磁盘真满（独立于配额，只读保护）
  CAS_CONFLICT: 'CAS_CONFLICT',               // 条件写版本冲突（重读最新状态后重试）
  SCOPE_INVALID: 'SCOPE_INVALID',             // 洛书节点 scope 块不自洽
  PRIVATE_LEAK: 'PRIVATE_LEAK',               // 导入文件含 visibility≠owner 的 private_annotation（全文件拒绝）
  LUOSHU_OWNER_MISMATCH: 'LUOSHU_OWNER_MISMATCH', // 跨 owner 导入整包拒绝
  MEM_ARCHIVE_EXPIRED: 'MEM_ARCHIVE_EXPIRED', // 归档 TTL 过期，Revive 降级摘要级
  MEM_TOMBSTONED: 'MEM_TOMBSTONED',           // TOMBSTONE 节点写入短路（行为矩阵标准码）
  MEM_PURGED: 'MEM_PURGED',                   // PURGED 节点写入短路（账本方案下由 Ledger 检查产出）
} as const;
export type ErrorCode = keyof typeof ErrorCodes;
