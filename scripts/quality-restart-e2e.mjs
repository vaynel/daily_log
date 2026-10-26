// TASK-26 AC-4: real OS worker SIGKILL during quality regeneration, then fresh process.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';
import { JobQueue, QualityRejectedError } from '../apps/server/dist/jobs/queue.js';
import { MonthlyLedger } from '../apps/server/dist/budget/ledger.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const mode = process.argv[2];
if (mode) {
  const pool = new pg.Pool({ connectionString: url });
  const handlers = {
    source: { execute: async () => ({ result: 'original-source' }) },
    render: { execute: async ctx => {
      if (mode === 'first' && ctx.qualityGeneration === 1) {
        console.log('READY_TO_KILL');
        await new Promise(() => {});
      }
      return { result: { file: `generation-${ctx.qualityGeneration}.mp4` } };
    } },
    quality: { execute: async () => { throw new QualityRejectedError({ passed: false, reason: 'fixture-quality-failure' }, ['render', 'quality'], true); } },
  };
  const q = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers: { video: handlers }, leaseMs: 100 });
  const j = await q.enqueue({ kind: 'video', subjectId: 'restart-fixture', stages: Object.keys(handlers), idempotencyKey: 'quality-restart' });
  if (mode === 'second') {
    // Parent verifies the old process exited before expiring its lease.
    await q.recover();
  }
  while (await q.tick()) { /* run until blocked */ }
  const result = await q.get(j.id);
  console.log(JSON.stringify(result));
  await pool.end();
} else {
  const schema = `t26_restart_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const live = new Set();
  function child(kind) {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), kind], { env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` }, stdio: ['ignore', 'pipe', 'inherit'] });
    live.add(p);
    let output = '';
    p.stdout.on('data', d => { output += d; });
    const done = new Promise((resolve, reject) => { p.on('error', reject); p.on('exit', (code, signal) => { live.delete(p); resolve({ code, signal, output }); }); });
    return { p, done, output: () => output };
  }
  const timeout = setTimeout(() => { for (const p of live) p.kill('SIGKILL'); }, 30_000);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    const dir = new URL('../apps/server/dist/db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await admin.query(readFileSync(new URL(f, dir), 'utf8'));
    const a = child('first');
    while (!a.output().includes('READY_TO_KILL')) {
      await Promise.race([new Promise(r => setTimeout(r, 20)), a.done.then(() => { throw new Error('worker exited before checkpoint'); })]);
    }
    let row = (await admin.query('SELECT * FROM jobs')).rows[0];
    assert.equal(row.quality_regenerations_used, 1);
    assert.equal(row.auto_retries_used, 0);
    a.p.kill('SIGKILL');
    assert.equal((await a.done).signal, 'SIGKILL');
    await admin.query("UPDATE jobs SET lease_until=now()-interval '1 second'");
    const b = child('second');
    assert.equal((await b.done).code, 0);
    row = (await admin.query('SELECT * FROM jobs')).rows[0];
    assert.equal(row.state, 'FAILED');
    assert.equal(row.quality_regenerations_used, 1);
    assert.equal(row.auto_retries_used, 1);
    assert.deepEqual(row.quality_reasons, ['QUALITY_EXHAUSTED']);
    assert.equal((await admin.query("SELECT attempts FROM job_stages WHERE stage='source'")).rows[0].attempts, 1);
    assert.equal((await admin.query('SELECT count(*)::int n FROM job_quality_reviews')).rows[0].n, 2);
    console.log('PASS SIGKILL during q1 -> fresh process recover: quality=1, processing_retry=1, FAILED/QUALITY_EXHAUSTED, source attempts=1, reviews=2');
  } finally {
    clearTimeout(timeout);
    for (const p of live) p.kill('SIGKILL');
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
