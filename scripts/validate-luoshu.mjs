/** 洛书包校验：node 示例必须通过 luoshu-v0.3.schema.json。
 *  用法：node scripts/validate-luoshu.mjs schemas/luoshu-v0.3.sample.json
 */
import { readFileSync } from 'node:fs';
const schema = JSON.parse(readFileSync('schemas/luoshu-v0.3.schema.json', 'utf8'));
const file = process.argv[2] ?? 'schemas/luoshu-v0.3.sample.json';
const doc = JSON.parse(readFileSync(file, 'utf8'));

const errors = [];
for (const k of schema.required) if (!(k in doc)) errors.push(`缺顶层字段: ${k}`);
if (doc.format !== 'luoshu') errors.push('format 必须为 luoshu');
if (doc.version !== '0.3') errors.push('version 必须为 0.3');

for (const n of doc.nodes ?? []) {
  for (const k of ['node_id', 'revision_id', 'revision_sequence', 'content_hash', 'version_state', 'content_state', 'provenance', 'scope'])
    if (!(k in n)) errors.push(`${n.node_id}: 缺字段 ${k}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(n.content_hash ?? '')) errors.push(`${n.node_id}: content_hash 格式错`);
  if (n.content_state === 'stub' && !n.stub_summary) errors.push(`${n.node_id}: STUB 必有 stub_summary`);
  if (n.content_state === 'minimized' && !/^archive\//.test(n.minimized_blob_ref ?? ''))
    errors.push(`${n.node_id}: MINIMIZED 必有归档包内相对路径`);
  if (n.content_state === 'full' && !n.content_ref) errors.push(`${n.node_id}: FULL 必有 content_ref`);
  if (n.scope.layer === 'private_annotation' && n.scope.visibility !== 'owner')
    errors.push(`${n.node_id}: PRIVATE_LEAK — private_annotation 的 visibility 必须=owner`);
}
const leak = (doc.nodes ?? []).some(n => n.scope?.layer === 'private_annotation' && n.scope?.visibility !== 'owner');
if (leak) errors.push('PRIVATE_LEAK: 全文件拒绝');

if (errors.length) { console.error('洛书包校验失败:'); for (const e of errors) console.error(' -', e); process.exit(1); }
console.log(`洛书包校验通过: ${doc.nodes?.length ?? 0} nodes, ${doc.purge_ledger?.length ?? 0} ledger entries`);
