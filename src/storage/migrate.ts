/** Migration 运行器：按版本号顺序回放未应用的 migration（幂等）。 */
import { DatabaseSync } from './sqlite.ts';
import { migration as m001 } from './migrations/001_init.ts';
import { migration as m002 } from './migrations/002_scope_revision.ts';

const MIGRATIONS = [m001, m002];

export function runMigrations(db: InstanceType<typeof DatabaseSync>): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(appliedRows.map(r => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(m.version, m.name);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    ran.push(m.version);
  }
  return { applied: ran };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.HETU_DB ?? 'hetu.db');
  const { applied } = runMigrations(db);
  console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'already up to date');
}
