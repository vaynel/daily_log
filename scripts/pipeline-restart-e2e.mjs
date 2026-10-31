// 제작 파이프라인 SIGKILL 재시작 E2E (TASK-117 AC-3): 모의 제공자로 실제 처리기 체인을 별도 OS 프로세스에서 돌리다
// 렌더 도중 / 음성 합성 도중 SIGKILL 하고, 새 프로세스에서 이어서 완료되는지·유료 호출이 중복되지 않는지 DB 원장으로 실측한다.
// `npm run build -w apps/server` 이후 실행. 실제 유료 호출·네트워크 없음. 시험은 순차로 돌고 자식 프로세스는 항상 정리한다.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const pg = require('pg');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL 필요'); process.exit(78); }
const dist = new URL('../apps/server/dist/', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'pipeline-e2e-'));
const admin = new pg.Pool({ connectionString: url, max: 1 });
const schemas = [];

async function newSchema() {
  const schema = `t117_${randomBytes(5).toString('hex')}`;
  schemas.push(schema);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = await admin.connect();
  await c.query(`SET search_path TO ${schema}`);
  for (const f of readdirSync(join(dist, 'db/migrations')).filter((x) => x.endsWith('.sql')).sort()) await c.query(readFileSync(join(dist, 'db/migrations', f), 'utf8'));
  c.release();
  const q = async (sql, p) => { const cl = await admin.connect(); try { await cl.query(`SET search_path TO ${schema}`); return (await cl.query(sql, p)).rows; } finally { cl.release(); } };
  return { schema, q };
}

const live = new Set();
function child(schema, ...args) {
  const env = { ...process.env, DATABASE_URL: url, PGOPTIONS: `-c search_path=${schema}`, UV_THREADPOOL_SIZE: '2' };
  const p = spawn(process.execPath, [join(dist, 'video/pipeline-restart-child.js'), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  live.add(p);
  const lines = []; const waiters = []; let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } waiters.splice(0).forEach((w) => w()); });
  const exited = new Promise((r) => p.on('exit', (code, sig) => { live.delete(p); r({ code, sig }); }));
  const waitFor = async (pred) => { for (;;) { const l = lines.find(pred); if (l) return l; await Promise.race([new Promise((r) => waiters.push(r)), exited.then(() => { throw new Error(`자식 조기 종료: ${lines.join('|')}`); })]); } };
  return { p, lines, waitFor, exited };
}

const mediaInfo = (file) => {
  let err = '';
  try { execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { err = String(e.stderr ?? ''); }
  const size = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(err);
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(err);
  return { w: Number(size?.[1]), h: Number(size?.[2]), sec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : NaN };
};

async function scenario(name, hangAt) {
  const { schema, q } = await newSchema();
  const dir = join(tmp, name);
  const release = join(tmp, `${name}.release`);
  const seed = child(schema, 'seed', dir, release, 'none');
  const jobId = (await seed.waitFor((l) => l.startsWith('JOB '))).split(' ')[1];
  await seed.exited;

  const a = child(schema, 'work', dir, release, hangAt);
  await a.waitFor((l) => l === `HANG ${hangAt}`);
  a.p.kill('SIGKILL');
  assert.equal((await a.exited).sig, 'SIGKILL');
  const entriesAtKill = await q('SELECT idempotency_key, state FROM budget_entries ORDER BY idempotency_key');
  const stagesAtKill = await q('SELECT stage, state FROM job_stages WHERE job_id=$1 ORDER BY stage', [jobId]);
  console.log(`[${name}] SIGKILL 시점: 단계=${stagesAtKill.map((s) => `${s.stage}:${s.state}`).join(',')} 원장=${entriesAtKill.length}건(${entriesAtKill.map((e) => e.state).join(',')})`);

  writeFileSync(release, '');
  const b = child(schema, 'work', dir, release, 'none');
  await b.waitFor((l) => l.startsWith('FINAL '));
  await b.exited;
  console.log(`[${name}] 재시작 후: ${b.lines.join(' | ')}`);
  const job = (await q('SELECT state, wait_reason, auto_retries_used FROM jobs WHERE id=$1', [jobId]))[0];
  const entriesAfter = await q('SELECT idempotency_key, state FROM budget_entries ORDER BY idempotency_key');
  const keys = entriesAfter.map((e) => e.idempotency_key);
  assert.equal(new Set(keys).size, keys.length, '원장 멱등키 중복 없음');
  return { jobId, job, b, a, q, dir, entriesAtKill, entriesAfter, stagesAtKill };
}

let failed = false;
try {
  // 1) 렌더 도중 종료: 유료 단계(TTS·이미지)는 모두 끝난 뒤이므로 재시작 후 렌더·검수만 이어서 완료, 유료 호출 0
  const r = await scenario('render', 'render');
  assert.equal(r.job.state, 'SUCCEEDED');
  assert.equal(Number(r.job.auto_retries_used), 1, '중단은 처리 오류 자동 재시도 1회로 센다');
  assert.ok(!r.b.lines.some((l) => l.startsWith('TTS ')), '재시작 후 TTS 재호출 없음');
  assert.ok(r.b.lines.includes('CALLS tts=0 image=0 infer=0'), '재시작 후 유료/Pro 호출 0');
  assert.deepEqual(r.entriesAfter, r.entriesAtKill, '원장 항목·상태가 종료 전과 같음(중복 과금 0)');
  const stages = await r.q('SELECT stage, state FROM job_stages WHERE job_id=$1 ORDER BY stage', [r.jobId]);
  assert.deepEqual(stages.map((s) => s.state), ['DONE', 'DONE', 'DONE', 'DONE', 'DONE']);
  const results = await r.q("SELECT content FROM record_versions WHERE kind='RESULT'");
  assert.equal(results.length, 1, 'RESULT 1건');
  const info = mediaInfo(join(r.dir, 'videos', results[0].content.file));
  assert.ok(info.w === 720 && info.h === 1280 && info.sec > 1 && info.sec <= 180, `MP4 9:16/≤180초: ${JSON.stringify(info)}`);
  const ps = (await r.q('SELECT production, review FROM pipeline_states'))[0];
  assert.deepEqual(ps, { production: 'DONE', review: 'PASSED' });
  console.log(`1) PASS 렌더 중 SIGKILL → 새 프로세스가 이어받아 SUCCEEDED, 원장 ${r.entriesAfter.length}건 불변, 재시작 후 유료 호출 0, MP4 ${info.w}x${info.h} ${info.sec}s`);

  // 2) 음성 합성 요청 도중(2번째 장면 응답 전) 종료: 첫 장면 음성은 보관돼 재사용, 응답 불명 요청은 재전송하지 않고 결과 확인 대기
  const t = await scenario('tts', 'tts2');
  assert.equal(t.job.state, 'WAITING');
  assert.equal(t.job.wait_reason, 'EXTERNAL_RESULT_UNKNOWN');
  assert.ok(!t.b.lines.some((l) => l.startsWith('TTS ')), '재시작 후 TTS 재호출(재전송) 없음');
  assert.deepEqual(t.entriesAfter.map((e) => e.idempotency_key), t.entriesAtKill.map((e) => e.idempotency_key), '새 원장 항목 없음');
  const tts = t.entriesAfter.filter((e) => e.idempotency_key.startsWith('narr:'));
  assert.equal(tts.length, 2, 'TTS 원장 2건(확정 1 + 응답 불명 1)');
  console.log(`2) PASS 음성 합성 중 SIGKILL → 재전송 없음, WAITING/EXTERNAL_RESULT_UNKNOWN, TTS 원장 ${tts.map((e) => e.state).join('+')} 중복 0`);
  // 3) 유료 단계 도중이지만 호출 사이(앞 장면 음성 결제·보관 완료, 다음 장면 예약 전)에 종료: 이어서 남은 장면만 합성해 완료
  const m = await scenario('between', 'between');
  assert.equal(m.job.state, 'SUCCEEDED');
  assert.ok(m.b.lines.includes('CALLS tts=2 image=2 infer=0'), `재시작 후 남은 2장면 음성 + 이미지 2건만 호출: ${m.b.lines.join('|')}`);
  assert.equal(m.entriesAtKill.filter((e) => e.idempotency_key.startsWith('narr:')).length, 1, '종료 시점 TTS 원장 1건');
  const nm = m.entriesAfter.filter((e) => e.idempotency_key.startsWith('narr:'));
  assert.equal(nm.length, 3, 'TTS 원장 3건(장면당 1건)');
  assert.ok(m.entriesAfter.every((e) => e.state === 'CONFIRMED'), '모든 원장 항목 CONFIRMED');
  assert.ok(m.entriesAtKill.every((e) => m.entriesAfter.some((x) => x.idempotency_key === e.idempotency_key)), '종료 전 항목 유지');
  const mr = await m.q("SELECT content FROM record_versions WHERE kind='RESULT'");
  assert.equal(mr.length, 1);
  const mi = mediaInfo(join(m.dir, 'videos', mr[0].content.file));
  assert.ok(mi.w === 720 && mi.h === 1280 && mi.sec > 1 && mi.sec <= 180);
  assert.deepEqual((await m.q('SELECT production, review FROM pipeline_states'))[0], { production: 'DONE', review: 'PASSED' });
  console.log(`3) PASS 음성 단계 장면 사이 SIGKILL → 첫 장면 음성 재사용, 남은 2장면만 합성, TTS 원장 ${nm.length}건 중복 0, 완료(MP4 ${mi.w}x${mi.h} ${mi.sec}s)`);
  console.log('pipeline-restart-e2e PASS');
} catch (e) {
  failed = true;
  console.error('pipeline-restart-e2e FAIL:', e);
} finally {
  for (const p of live) p.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
  for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await admin.end();
}
process.exit(failed ? 1 : 0);
