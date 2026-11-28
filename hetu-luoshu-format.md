# 洛书 Luoshu · 开放记忆交换格式 v0.3

> 河图 HeTu 的数据契约——"数据在用户手里"的载体。任何第三方工具可读取；导入幂等。
> v0.3（与主规格 v1.4 收敛定稿同基线）：——节点级 Scope 契约 / Purge Ledger（含 content_hash）/ Minimize 归档字段 / Restore-Merge 共用权限管线。

**节点级是权威数据，文件级仅传输容器；冲突节点级胜出。**

---

## 三概念分离（v0.2 核心）

| 概念 | 含义 | 用途 |
|---|---|---|
| **node_id** | 记忆稳定身份 | 跨版本不变 |
| **revision_id / revision_sequence** | 内容版本 | 冲突比较 |
| **content_hash** | 内容完整性 | 校验、幂等识别 |

**规则**：幂等键 = (owner_id, node_id, content_hash)，仅用于识别重复；版本冲突按 revision_id 比较——旧快照不覆盖新版本；同 ID 异内容 → 冲突报告。

## 文件结构

```json
{
  "format": "luoshu",
  "version": "0.3",
  "exported_at": "2026-11-23T09:00:00+08:00",
  "exporter": { "product": "hetu", "version": "0.1.0" },
  "owner_id": "default",
  "purge_ledger": [
    { "purge_seq": 42, "node_id": "mem_X", "content_hash": "sha256:...", "timestamp": "...", "reason_category": "user-request" }
  ]
}
```

## 节点

```json
{
  "node_id": "mem_01ABC",
  "revision_id": "rev_01ABC_3",
  "revision_sequence": 3,
  "content_hash": "sha256:9f2c...",  // 节点正文哈希（防复活拦截键）
  "kind": "memory | entity | annotation | persona_block",
  "version_state": "current | superseded",
  "content_state": "full | minimized | stub | tombstone",
  "content_ref": "blobs/0001.txt",
  "stub_summary": "一句话摘要（content_state=stub 时必有）",
  "modality": "text",
  "confidence": 0.82,
  "provenance": {
    "agent_id": "claude-main",
    "origin": "hot-path | session-digest | reflection",
    "method": "rule | model-assisted | user-confirmed",
    "source_refs": ["raw_001", "raw_002"],
    "producer_version": "hetu 0.1.0",
    "model_id": null,
    "generated_at": "2026-11-23T09:00:00Z",
    "confidence": 0.9
  },
  "valid_from": "2026-11-01T00:00:00Z",
  "valid_until": null,
  "ingested_at": "2026-11-01T08:00:00Z",
  "superseded_by": null,
  "sensitivity_override": "normal | sensitive | restricted",
  "minimized_blob_ref": "archive/mem_01ABC/rev_3.txt",  // 洛书包内相对路径（state=minimized 时必填）
  "minimized_at": null,
  "minimized_blob_hash": null,                         // 归档原文完整性校验
  "scope": {
    "owner_id": "default",
    "layer": "user_identity | agent_persona | global | project | private_annotation",
    "project_id": null,
    "agent_id": null,
    "visibility": "owner | project_agents | all_agents | shared_list",
    "shared_with": []
  },
  "extensions": { }
}
```

## 边

```json
{
  "type": "cooccur | supersedes | annotation | link",
  "link_class": "pinned | explicit | inferred",
  "from": "mem_01ABC",
  "to": "ent_xiaoming",
  "weight": 0.7,
  "created_at": "2026-11-01T08:00:00Z",
  "last_reinforced_at": null
}
```

## 硬性约束

- **导出剔除集**：TOMBSTONE / PURGED 节点与 RAW 层永不出现
- **SUPERSEDED/STUB**：导出 stub_summary 与全部关联边（时间回溯依赖）
- **Purge Ledger（导出投影，原 Purge Marker）**：随每次导出携带全量；**导入先应用 Ledger 再导普通节点**
- **私有内容**：默认仅导出共享事实；per-agent 注解/persona 需显式授权且单独文件
- **派生链不重复计数**：origin=session-digest / reflection 的节点不计入"独立来源"佐证
- **Restore vs Merge**：Restore 不重跑淘汰（原样恢复）；Merge 按当前库执行确定性淘汰；无法自动解决的冲突生成报告；**两者共用同一套节点级导入权限验证管线**
- **导入四步验证**：①scope 自洽（`SCOPE_INVALID` 整节点拒绝）②PRIVATE_LEAK（private 节点 visibility≠owner）→ **全文件拒绝** ③无权限（layer/project 不匹配）→ 跳过+导入报告计数（`IMPORT_SKIPPED`）④sensitivity 覆盖层取更严者
- **Purge Ledger**：导出携带全量 Ledger（purge_seq/node_id/content_hash/timestamp/reason_category，导出版脱敏去 operator）；导入先应用 Ledger，同 id 或同 content_hash 命中 → `MARKER_CONFLICT` 拒绝

## archive/ 与 blobs/

- `blobs/<hash前缀>/<hash>`：主区原文，按 content_hash 寻址
- `archive/<node_id>/rev_N.txt`：Minimize 受控归档原文（仅显式授权包携带）
- 恢复完整性：Revive 时对归档文件计算 SHA-256 与 `minimized_blob_hash` 比对，不匹配 → `ARCHIVE_MISSING`
