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
const leak = (doc.nodes ?? []).some(n => n.scope?.layer === 'private_annotation' && n.scope?.visibility !== 'owner');
if (leak) errors.push('PRIVATE_LEAK: 全文件拒绝');
const dup = new Set();
for (const n of doc.nodes ?? []) {
  const k = `${n.node_id}/${n.revision_sequence}`;
  if (dup.has(k)) errors.push(`重复 revision: ${k}`);
  dup.add(k);
}
if (errors.length) { console.error('洛书包语义校验失败:'); for (const e of errors) console.error(' -', e); process.exit(1); }
console.log(`洛书包校验通过: ${doc.nodes?.length ?? 0} nodes, ${doc.purge_ledger?.length ?? 0} ledger entries`);
