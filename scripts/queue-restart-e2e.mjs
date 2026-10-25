// 작업 큐 재시작 E2E (TASK-15 AC-2): 워커를 별도 OS 프로세스로 띄워 처리 중 SIGKILL 하고,
// 새 프로세스(임대 만료 후 recover)에서 완료 단계·사용한 재시도 횟수·원장 예약이 유지되는지 DB로 실측한다.
// `npm run build` 이후 실행. 시험은 순차로 돌고 자식 프로세스는 항상 정리한다.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const pg = require('pg');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL 필요');
  process.exit(78);
}
const dist = new URL('../apps/server/dist/', import.meta.url).pathname;
const schema = `t15_restart_${randomBytes(5).toString('hex')}`;
const env = { ...process.env, DATABASE_URL: url, PGOPTIONS: `-c search_path=${schema}` };
const tmp = mkdtempSync(join(tmpdir(), 'queue-e2e-'));
const release = join(tmp, 'release');

const admin = new pg.Pool({ connectionString: url, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
const c = await admin.connect();
await c.query(`SET search_path TO ${schema}`);
for (const f of readdirSync(join(dist, 'db/migrations')).sort()) await c.query(readFileSync(join(dist, 'db/migrations', f), 'utf8'));
c.release();
const q = async (sql, p) => {
  const cl = await admin.connect();
  try {
    await cl.query(`SET search_path TO ${schema}`);
    return (await cl.query(sql, p)).rows;
  } finally {
    cl.release();
  }
};

const live = new Set();
function child(...args) {
  const p = spawn(process.execPath, [join(dist, 'jobs/restart-child.js'), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  live.add(p);
  const lines = [];
  const waiters = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  const exited = new Promise((r) => p.on('exit', (code, sig) => { live.delete(p); r({ code, sig }); }));
  const waitFor = async (pred) => {
    for (;;) {
      const l = lines.find(pred);
      if (l) return l;
      await Promise.race([new Promise((r) => waiters.push(r)), exited.then(() => { throw new Error(`자식 조기 종료: ${lines.join('|')}`); })]);
    }
  };
  return { p, lines, waitFor, exited };
}

async function scenario(kind, { killAt, expect }) {
  rmSync(release, { force: true });
  const e = child('enqueue', kind, release);
  const jobId = (await e.waitFor((l) => l.startsWith('JOB '))).split(' ')[1];
  await e.exited;

  const a = child('work', kind, release);
  await a.waitFor((l) => l === `HANG ${killAt}`);
  const before = (await q(`SELECT auto_retries_used FROM jobs WHERE id=$1`, [jobId]))[0];
  a.p.kill('SIGKILL');
  const ex = await a.exited;
  assert.equal(ex.sig, 'SIGKILL');
  const stagesBefore = await q(`SELECT stage, state FROM job_stages WHERE job_id=$1 ORDER BY stage`, [jobId]);
  console.log(`[${kind}] SIGKILL 시점: auto_retries_used=${before.auto_retries_used} 단계=${stagesBefore.map((s) => `${s.stage}:${s.state}`).join(',')} 실행=${a.lines.filter((l) => l.startsWith('EXEC')).join('|')}`);

  writeFileSync(release, ''); // 재시작한 프로세스의 처리기는 멈추지 않는다
  const b = child('work', kind, release);
  await b.waitFor((l) => l.startsWith('FINAL '));
  await b.exited;
  const execs = (x) => x.lines.filter((l) => l.startsWith('EXEC'));
  console.log(`[${kind}] 재시작 후: ${b.lines.join(' | ')}`);

  const job = (await q(`SELECT state, auto_retries_used FROM jobs WHERE id=$1`, [jobId]))[0];
  const stages = await q(`SELECT stage, state, result FROM job_stages WHERE job_id=$1 ORDER BY stage`, [jobId]);
  assert.equal(job.state, 'SUCCEEDED');
  assert.equal(Number(job.auto_retries_used), expect.retries, '사용한 재시도 횟수 유지');
  assert.deepEqual(stages.map((s) => s.state), ['DONE', 'DONE', 'DONE'], '남은 단계 완료');
  assert.ok(!execs(b).some((l) => l.startsWith('EXEC a')), '완료된 단계 a 는 다시 실행되지 않음');
  assert.deepEqual(execs(b), expect.execsAfter, '재시작 후 실행 목록');
  return { jobId, stages };
}

let failed = false;
try {
  // 1) 유료가 아닌 단계 처리 중 종료: 중단은 일시 오류로 취급되어 자동 재시도 1회를 소모하고 b, c 만 이어서 완료
  await scenario('plain', { killAt: 'b', expect: { retries: 1, execsAfter: ['EXEC b 2', 'EXEC c 1'] } });
  console.log('1) PASS 완료 단계 a 미재실행, 재시도 횟수 DB 유지(0→복구 시 1), b·c 완료');

  // 2) 이미 재시도 1회를 쓴 작업의 유료 단계 요청 직후 종료: 재전송 없이 조회로 확정, 원장 예약 중복 없음
  const { jobId } = await scenario('paid', { killAt: 'b', expect: { retries: 1, execsAfter: ['EXEC c 1'] } });
  const entries = await q(`SELECT state, purpose, idempotency_key FROM budget_entries WHERE idempotency_key LIKE $1`, [`${jobId}:%`]);
  assert.equal(entries.length, 1, '원장 예약 1건만');
  assert.equal(entries[0].state, 'CONFIRMED');
  console.log(`2) PASS 사용한 재시도 1 유지, 유료 b 재전송 없음(LOOKUP 확정), 원장 ${entries.length}건 ${entries[0].state}/${entries[0].purpose}`);
  console.log('queue-restart-e2e PASS');
} catch (e) {
  failed = true;
  console.error('queue-restart-e2e FAIL:', e);
} finally {
  for (const p of live) p.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
process.exit(failed ? 1 : 0);
