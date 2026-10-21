import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/** 시험 전용 임시 스키마를 만들고 모든 마이그레이션을 적용한다. */
export async function createTempSchema(databaseUrl: string) {
  const schema = `t11_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = await admin.connect();
  try {
    await c.query(`SET search_path TO ${schema}`);
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query(readFileSync(join(migrationsDir, f), 'utf8'));
    }
  } finally {
    c.release();
  }
  return {
    schema,
    pool: () => new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` }),
    drop: async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
