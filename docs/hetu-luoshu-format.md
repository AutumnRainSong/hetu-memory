# 洛书 Luoshu · 开放记忆交换格式 v0.2

> 河图 HeTu 的数据契约——"数据在用户手里"的载体。任何第三方工具可读取；导入幂等。
> v0.2：与主规格 v1.4 对齐（三概念分离 / Restore-Merge 分离 / 派生链七字段 / Purge Marker）。

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
  "version": "0.2",
  "exported_at": "2026-11-23T09:00:00+08:00",
  "exporter": { "product": "hetu", "version": "0.1.0" },
  "owner_id": "default",
  "purge_markers": [
    { "node_id": "mem_X", "purge_seq": 42, "purged_at": "..." }
  ]
}
```

## 节点

```json
{
  "id": "mem_01ABC",
  "kind": "memory | entity | annotation | persona_block",
  "version_state": "current | superseded",
  "content_state": "full | stub",
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
- **Purge Marker**：随每次导出携带全量；**导入先应用 Marker 再导普通节点**
- **私有内容**：默认仅导出共享事实；per-agent 注解/persona 需显式授权且单独文件
- **派生链不重复计数**：origin=session-digest / reflection 的节点不计入"独立来源"佐证
- **Restore vs Merge**：Restore 不重跑淘汰（原样恢复）；Merge 按当前库执行确定性淘汰；无法自动解决的冲突生成报告
