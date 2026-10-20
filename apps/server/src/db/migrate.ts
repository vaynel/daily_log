import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigOrExit } from '../config.js';
import { createPool } from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
const client = await pool.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await client.query('SELECT pg_advisory_lock(8008)');
  const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(8008)').catch(() => {});
  client.release();
  await pool.end();
}
