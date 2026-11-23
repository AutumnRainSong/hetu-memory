# 河图 HeTu

> 通用 Agent 记忆模块 · 跨框架、本地优先、数据归用户
> 设计规格 v1.4（定稿）· 11 轮审查协商闭环

**河出图**——龙马负出的那张图，是华夏最早的结构化知识图谱：点是节点，位势是边。河图把这张图变成 agent 的记忆：不可变节点、supersede 版本链、带权关联边、权限前置过滤、可带回溯的生命周期。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/agent-memory-module-design.md](docs/agent-memory-module-design.md) | **主规格 v1.4**——架构、数据模型、行为矩阵、治理规则、路线图 |
| [docs/hetu-luoshu-format.md](docs/hetu-luoshu-format.md) | 洛书——开放记忆交换格式（数据在用户手里的契约） |
| [continue_bro.md](continue_bro.md) | AI 结对执行者入职文档（十条设计纪律 + 交接） |
| [docs/执行者.md](docs/执行者.md) | 实现团队画像——岗位、筛人题、验收门禁 |
| [docs/reviews/](docs/reviews/) | 审查与协商档案（外部评审往返记录） |

## 十条设计纪律（速览）

1. 节点不可变，修改 = supersede 新版本
2. sensitivity 是访问控制（硬过滤前置），不是排序因子；独立覆盖层
3. TOMBSTONE/PURGED 是写短路口 + 图扩散吸收边界
4. 授权映射到意图，不映射到工具
5. 摘要不冒充独立事实来源
6. 系统永不静默改写已确认事实（合并器只出提案）
7. 后台三层：Data Integrity ⟂ Memory Processing ⟂ Memory Intelligence（默认 OFF）
8. 并发不变量在存储层（CAS/条件写），不在应用层队列
9. 数据正确性不依赖智能反思
10. 导入不改变数据的真实含义（Restore ≠ Merge）

## MVP 毕业考

```
记住 → 跨会话召回 → 删除 → 不再出现 → 导出（洛书）→ Restore → Purge 内容不复活
```

## 实施路线

阶段一 数据正确性与安全 → 阶段二 性能基础设施 → 阶段三 MVP（记/忆/忘/察）→ 阶段四 智能化扩展

---

> 别让设计变成更长的文档——让它变成能跑起来的东西。
