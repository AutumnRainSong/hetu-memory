/** 洛书 v0.3 Schema 校验测试：正式样例必须通过校验器；泄露样例必须被拒绝。 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALIDATOR = 'node scripts/validate-luoshu.mjs';

describe('luoshu-v0.3 sample', () => {
  it('正式样例通过校验器', () => {
    const out = execSync(`${VALIDATOR} schemas/luoshu-v0.3.sample.json`, { encoding: 'utf8' });
    expect(out).toContain('洛书包校验通过');
  });

  it('PRIVATE_LEAK 样例被全文件拒绝', () => {
    const doc = JSON.parse(readFileSync('schemas/luoshu-v0.3.sample.json', 'utf8'));
    doc.nodes[0].scope = { ...doc.nodes[0].scope, layer: 'private_annotation', agent_id: 'a1', visibility: 'all_agents' };
    const leakPath = join(tmpdir(), 'leak.json');
    writeFileSync(leakPath, JSON.stringify(doc));
    let failed = false;
    try { execSync(`${VALIDATOR} ${leakPath}`, { encoding: 'utf8' }); }
    catch { failed = true; }
    expect(failed, 'PRIVATE_LEAK 必须被拒绝').toBe(true);
  });

  it('STUB 缺 stub_summary 被拒绝', () => {
    const doc = JSON.parse(readFileSync('schemas/luoshu-v0.3.sample.json', 'utf8'));
    doc.nodes[1].content_state = 'stub';
    doc.nodes[1].stub_summary = null;
    const badPath = join(tmpdir(), 'badstub.json');
    writeFileSync(badPath, JSON.stringify(doc));
    let failed = false;
    try { execSync(`${VALIDATOR} ${badPath}`, { encoding: 'utf8' }); }
    catch { failed = true; }
    expect(failed).toBe(true);
  });
});
