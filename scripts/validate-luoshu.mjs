/** 洛书包校验（正式 AJV 实现，T-F-01 已接入）：node 必须通过 luoshu-v0.3.schema.json。
 *  用法：node scripts/validate-luoshu.mjs [包文件.json]
 */
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const schema = JSON.parse(readFileSync('schemas/luoshu-v0.3.schema.json', 'utf8'));
const file = process.argv[2] ?? 'schemas/luoshu-v0.3.sample.json';
const doc = JSON.parse(readFileSync(file, 'utf8'));

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(doc)) {
  console.error('洛书包校验失败:');
  for (const e of validate.errors ?? []) console.error(' -', e.instancePath, e.message);
  process.exit(1);
}
// 附加契约（Schema 之外的语义级检查）
const errors = [];
const nodeIds = new Set((doc.nodes ?? []).map(n => n.node_id));
const leak = (doc.nodes ?? []).some(n => n.scope?.layer === 'private_annotation' && n.scope?.visibility !== 'owner');
if (leak) errors.push('PRIVATE_LEAK: 全文件拒绝');
const dup = new Set();
for (const n of doc.nodes ?? []) {
  const k = `${n.node_id}/${n.revision_sequence}`;
  if (dup.has(k)) errors.push(`重复 revision: ${k}`);
  dup.add(k);
}
const revIds = new Set();
for (const n of doc.nodes ?? []) {
  if (revIds.has(n.revision_id)) errors.push(`重复 revision_id: ${n.revision_id}`);
  revIds.add(n.revision_id);
}
/* 边 ID 语义（任务 E）：supersedes 必须引用包内 revision_id；
   cooccur/annotation/link 必须引用包内 node_id */
for (const e of doc.edges ?? []) {
  if (e.type === 'supersedes') {
    for (const [side, v] of [['from', e.from], ['to', e.to]]) {
      if (!revIds.has(v)) errors.push(`supersedes 边的 ${side}=${v} 不是包内 revision_id（应为 RevisionId 语义）`);
    }
  } else {
    for (const [side, v] of [['from', e.from], ['to', e.to]]) {
      if (!nodeIds.has(v)) errors.push(`${e.type} 边的 ${side}=${v} 不是包内 node_id（应为 NodeId 语义）`);
    }
  }
}
/* B4：Revision 图语义校验 —— supersedes 必须同属一个逻辑记忆、方向正确、无环 */
const byRevision = new Map((doc.nodes ?? []).map(n => [n.revision_id, n]));
const supersedeEdges = (doc.edges ?? []).filter(e => e.type === 'supersedes');

for (const e of supersedeEdges) {
  const fromNode = byRevision.get(e.from);
  const toNode = byRevision.get(e.to);
  if (!fromNode || !toNode) continue; // 引用存在性已由上方检查覆盖
  if (fromNode.node_id !== toNode.node_id) {
    errors.push(`supersedes 边跨逻辑记忆：${e.from}(${fromNode.node_id}) → ${e.to}(${toNode.node_id})`);
  }
  if (fromNode.revision_sequence <= toNode.revision_sequence) {
    errors.push(
      `supersedes 方向/序号非法：${e.from}(seq=${fromNode.revision_sequence}) 应大于 ${e.to}(seq=${toNode.revision_sequence})`
    );
  }
}

// 环检测：沿 supersedes 边遍历
const adj = new Map();
for (const e of supersedeEdges) {
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push(e.to);
}
const state = new Map(); // 0=未访问 1=栈中 2=已完成
const hasCycle = (v) => {
  if (state.get(v) === 1) return true;
  if (state.get(v) === 2) return false;
  state.set(v, 1);
  for (const w of adj.get(v) ?? []) if (hasCycle(w)) return true;
  state.set(v, 2);
  return false;
};
for (const v of adj.keys()) {
  if (hasCycle(v)) {
    errors.push(`supersedes 边存在环（起点 ${v}）`);
    break;
  }
}

// Scope 自洽性（节点级）
const LAYER_NEEDS = {
  project: ['project_id'],
  agent_persona: ['agent_id'],
  private_annotation: ['agent_id'],
};
for (const n of doc.nodes ?? []) {
  const sc = n.scope ?? {};
  for (const f of LAYER_NEEDS[sc.layer] ?? []) {
    if (!sc[f]) errors.push(`${n.node_id}: layer=${sc.layer} 必须提供 ${f}`);
  }
  if (sc.layer === 'private_annotation' && sc.visibility !== 'owner') {
    errors.push(`${n.node_id}: private_annotation 的 visibility 必须为 owner`);
  }
  if (sc.visibility === 'shared_list' && !(sc.shared_with ?? []).length) {
    errors.push(`${n.node_id}: visibility=shared_list 但 shared_with 为空`);
  }
}

if (errors.length) { console.error('洛书包语义校验失败:'); for (const e of errors) console.error(' -', e); process.exit(1); }
console.log(`洛书包校验通过: ${doc.nodes?.length ?? 0} nodes, ${doc.purge_ledger?.length ?? 0} ledger entries`);
