import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool } from 'pg';

const DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Forward-only SQL migrations, each applied in its own transaction, guarded by an advisory lock. */
export async function migrate(pool: Pool): Promise<string[]> {
  const c = await pool.connect(); const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, "appliedAt" timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const f of readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(DIR, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); applied.push(f); }
      catch (e) { await c.query('ROLLBACK'); throw new Error(`Migration ${f} failed: ${(e as Error).message}`); }
    }
  } finally { await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {}); c.release(); }
  return applied;
}
