# 开放记忆交换格式（OMXF）v0.1 草案

> 通用 Agent 记忆模块的导出/导入格式——"数据在用户手里"的契约载体
> 任何第三方工具可读取；导入幂等；本格式与主设计文档 2.1/7 节配套

## 文件结构

```json
{
  "format": "omxf",
  "version": "0.1",
  "exported_at": "2026-11-20T14:35:00+08:00",
  "exporter": { "product": "agent-memory", "version": "0.1.0" },
  "scope": { "owner_id": "default", "layers": ["identity", "global", "project:my-app"] }
}
```

## 节点

```json
{
  "id": "mem_01ABC",
  "kind": "memory | entity | annotation | persona_block",
  "state": "active | superseded | stub",
  "content_ref": "blobs/0001.txt",
  "stub_summary": "一句话摘要（state=stub 时必有，原文已删）",
  "modality": "text",
  "confidence": 0.82,
  "provenance": { "agent_id": "claude-main", "session": "s-01", "root": "user-utterance" },
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
{ "type": "cooccur | supersedes | annotation | link",
  "from": "mem_01ABC", "to": "ent_xiaoming",
  "weight": 0.7, "created_at": "..." }
```

## 约束（与主设计文档 7 节一致）

- **导出剔除集**：TOMBSTONE、PURGED 节点与 RAW 层永不出现
- **SUPERSEDED/STUB**：导出 stub_summary 与全部关联边
- **导入幂等**：按 id 去重；遇悬空 superseded_by → 建占位墓碑节点 + warning
- **私有内容**：默认仅导出共享事实；per-agent 注解/persona 需显式授权且单独文件
- **sensitivity_override**：覆盖层值随导出（重放安全：不含 PURGED 即无复活风险）

## blobs/

原文按 content_ref 存放，UTF-8，文件名与节点 id 对应。
