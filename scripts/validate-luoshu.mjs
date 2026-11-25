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
if (errors.length) { console.error('洛书包语义校验失败:'); for (const e of errors) console.error(' -', e); process.exit(1); }
console.log(`洛书包校验通过: ${doc.nodes?.length ?? 0} nodes, ${doc.purge_ledger?.length ?? 0} ledger entries`);
