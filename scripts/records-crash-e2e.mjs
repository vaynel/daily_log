// 서버 측 중단 E2E (TASK-11 AC-2): 빌드된 별도 OS 프로세스를 SIGKILL로 강제 종료하고
// 새 프로세스에서 같은 DB로 재접속해 복구 결과를 실측한다. `npm run build` 이후 실행.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const schema = `t11_crash_${randomBytes(5).toString('hex')}`;
const env = { ...process.env, DATABASE_URL: url, PGOPTIONS: `-c search_path=${schema}` };

const admin = new pg.Pool({ connectionString: url, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
const c = await admin.connect();
await c.query(`SET search_path TO ${schema}`);
for (const f of readdirSync(join(dist, 'db/migrations')).sort()) await c.query(readFileSync(join(dist, 'db/migrations', f), 'utf8'));
c.release();

function child(...args) {
  const p = spawn(process.execPath, [join(dist, 'records/crash-child.js'), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
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
  const exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  const waitFor = async (pred) => {
    for (;;) {
      const l = lines.find(pred);
      if (l) return l;
      await Promise.race([new Promise((r) => waiters.push(r)), exited.then(() => { throw new Error(`자식 조기 종료: ${lines.join('|')}`); })]);
    }
  };
  return { p, lines, waitFor, exited };
}

const owner = 'crash-owner';
const lifeDate = new Date(Date.now() + 9 * 3600_000 - 5 * 3600_000).toISOString().slice(0, 10);
let failed = false;
try {
  // 1) 저장 스트림 중 SIGKILL
  const a = child('stream', owner, lifeDate);
  const started = await a.waitFor((l) => l.startsWith('STARTED '));
  const interviewId = started.split(' ')[1];
  await a.waitFor((l) => l.startsWith('SAVED 5 '));
  a.p.kill('SIGKILL');
  const ex = await a.exited;
  assert.equal(ex.sig, 'SIGKILL');
  const acked = a.lines.filter((l) => l.startsWith('SAVED ')).map((l) => Number(l.split(' ')[1])).at(-1);
  console.log(`1) SIGKILL 시점 마지막 확인된 저장: ${acked}`);

  const d1 = child('dump', owner, lifeDate);
  const snap1 = JSON.parse((await d1.waitFor((l) => l.startsWith('SNAPSHOT '))).slice(9));
  await d1.exited;
  const n = snap1.items.length;
  assert.ok(n >= acked, `확인된 저장(${acked})이 모두 복구되어야 함: ${n}`);
  assert.deepEqual(snap1.items.map((i) => i.seq), Array.from({ length: n }, (_, i) => i + 1), 'seq 연속');
  assert.equal(snap1.attachments.length, n, '항목마다 첨부 연결(항목-첨부 원자성)');
  const itemIds = new Set(snap1.items.map((i) => i.id));
  assert.ok(snap1.attachments.every((x) => itemIds.has(x.itemId)), '첨부가 대화 항목에 연결됨');
  assert.equal(snap1.interview.id, interviewId);
  assert.equal(snap1.interview.lifeDate, lifeDate);
  assert.equal(snap1.interview.status, 'IN_PROGRESS');
  assert.equal(snap1.interview.revision, 1);
  assert.deepEqual(snap1.pipeline, { production: 'NONE', review: 'NONE', backup: 'NONE' });
  assert.equal(snap1.resumes.length, 1);
  console.log(`   복구: 항목 ${n}건·첨부 ${snap1.attachments.length}건·seq 연속·버전 revision=1·상태 IN_PROGRESS/NONE`);

  // 2) 트랜잭션 중간(항목 INSERT 후, 첨부 INSERT 전)에 SIGKILL
  const m = child('mid', owner, lifeDate, interviewId);
  await m.waitFor((l) => l === 'MID');
  m.p.kill('SIGKILL');
  assert.equal((await m.exited).sig, 'SIGKILL');
  assert.ok(!m.lines.includes('UNEXPECTED_COMPLETE'));
  const d2 = child('dump', owner, lifeDate);
  const snap2 = JSON.parse((await d2.waitFor((l) => l.startsWith('SNAPSHOT '))).slice(9));
  await d2.exited;
  assert.equal(snap2.items.length, n, '중간 종료한 항목이 남지 않아야 함');
  assert.ok(!snap2.items.some((i) => i.body.includes('저장 도중')));
  assert.equal(snap2.attachments.length, n);
  assert.deepEqual(snap2.items.map((i) => i.seq), snap1.items.map((i) => i.seq));
  assert.equal(snap2.resumes.length, 2);
  const stale = await admin.query(`SELECT count(*) FROM ${schema}.conversation_items WHERE idempotency_key = 'mid-key'`);
  assert.equal(Number(stale.rows[0].count), 0);
  console.log('2) 트랜잭션 중간 SIGKILL: 부분 항목·첨부 0건, 이전 저장분 그대로');
  console.log('PASS');
} catch (e) {
  failed = true;
  console.error('FAIL', e);
} finally {
  await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
  await admin.end();
}
process.exit(failed ? 1 : 0);
