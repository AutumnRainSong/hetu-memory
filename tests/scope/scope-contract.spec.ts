/** 任务 B3：五类 Scope 的完整字段约束与权限语义（产品目标校准 §1.3）。 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from '../../src/storage/sqlite.ts';
import { runMigrations } from '../../src/storage/migrate.ts';
import { insertNode } from '../helpers/db.ts';

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
});

describe('五类 Scope — 合法组合', () => {
  it('user_identity：属于用户本人，不需 agent_id', () => {
    expect(() =>
      insertNode(db, { layer: 'user_identity', project_id: null, agent_id: null, visibility: 'owner' })
    ).not.toThrow();
  });

  it('agent_persona：必须绑定 agent_id', () => {
    expect(() =>
      insertNode(db, { layer: 'agent_persona', agent_id: 'agent-a', project_id: null, visibility: 'owner' })
    ).not.toThrow();
  });

  it('global：工作空间内共享，visibility=all_agents', () => {
    expect(() =>
      insertNode(db, { layer: 'global', project_id: null, visibility: 'all_agents' })
    ).not.toThrow();
  });

  it('project：必须有 project_id', () => {
    expect(() =>
      insertNode(db, { layer: 'project', project_id: 'proj-1', visibility: 'project_agents' })
    ).not.toThrow();
  });

  it('private_annotation：必须绑定 agent 且 visibility=owner', () => {
    expect(() =>
      insertNode(db, {
        layer: 'private_annotation',
        agent_id: 'agent-a',
        project_id: null,
        visibility: 'owner',
      })
    ).not.toThrow();
  });
});

describe('五类 Scope — 非法组合必须被拒绝', () => {
  it('agent_persona 缺 agent_id → 拒绝', () => {
    expect(() =>
      insertNode(db, { layer: 'agent_persona', agent_id: null, project_id: null })
    ).toThrow(/CHECK|constraint/);
  });

  it('private_annotation 缺 agent_id → 拒绝', () => {
    expect(() =>
      insertNode(db, { layer: 'private_annotation', agent_id: null, visibility: 'owner' })
    ).toThrow(/CHECK|constraint/);
  });

  it('private_annotation visibility=all_agents → 拒绝（不能泄漏到共享）', () => {
    expect(() =>
      insertNode(db, { layer: 'private_annotation', agent_id: 'a1', visibility: 'all_agents' })
    ).toThrow(/CHECK|constraint/);
  });

  it('private_annotation visibility=project_agents → 拒绝', () => {
    expect(() =>
      insertNode(db, { layer: 'private_annotation', agent_id: 'a1', visibility: 'project_agents' })
    ).toThrow(/CHECK|constraint/);
  });

  it('project 缺 project_id → 拒绝', () => {
    expect(() => insertNode(db, { layer: 'project', project_id: null })).toThrow(/CHECK|constraint/);
  });

  it('owner_id 为 NULL → NOT NULL 拒绝', () => {
    expect(() => insertNode(db, { owner_id: null as unknown as string })).toThrow(/NOT NULL/);
  });
});

describe('Agent 隔离 — SQL 层（业务权限链在 M1-C）', () => {
  it('Agent A 的 private_annotation 按 agent_id 过滤，B 查不到', () => {
    insertNode(db, {
      node_id: 'n-a',
      revision_id: 'r-a',
      layer: 'private_annotation',
      agent_id: 'agent-a',
      project_id: null,
      visibility: 'owner',
    });
    insertNode(db, {
      node_id: 'n-b',
      revision_id: 'r-b',
      layer: 'private_annotation',
      agent_id: 'agent-b',
      project_id: null,
      visibility: 'owner',
    });

    const aSees = db.prepare('SELECT revision_id FROM nodes WHERE agent_id=?').all('agent-a');
    expect(aSees.length).toBe(1);
    expect((aSees[0] as { revision_id: string }).revision_id).toBe('r-a');

    // 共享查询（global/project 层）不应带出任何私有注解
    const shared = db
      .prepare("SELECT revision_id FROM nodes WHERE layer IN ('global','project')")
      .all();
    expect(shared.length).toBe(0);
  });

  it('项目隔离：proj-1 的查询查不到 proj-2', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1', layer: 'project', project_id: 'proj-1' });
    insertNode(db, { node_id: 'n2', revision_id: 'r2', layer: 'project', project_id: 'proj-2' });

    const p1 = db.prepare('SELECT revision_id FROM nodes WHERE project_id=?').all('proj-1');
    expect(p1.length).toBe(1);
  });

  it('跨 owner 隔离', () => {
    insertNode(db, { node_id: 'n1', revision_id: 'r1', owner_id: 'ws-1' });
    insertNode(db, { node_id: 'n2', revision_id: 'r2', owner_id: 'ws-2' });
    const w1 = db.prepare('SELECT revision_id FROM nodes WHERE owner_id=?').all('ws-1');
    expect(w1.length).toBe(1);
  });
});
