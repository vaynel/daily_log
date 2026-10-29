// TASK-28 브라우저 E2E: 결과 재생·다운로드·수정 요청·이전 버전 표시를 PC(1280x800)와 Android 에뮬레이션(412x915 터치)에서 확인한다.
// 실제 Android 기기 검증이 아니다. 서버+vite+Chromium 을 동시에 띄우므로 pids 제한이 있는 워커 컨테이너에서는 실행하지 말고
// 호스트(워커 이미지)에서 단독으로 실행한다: DATABASE_URL, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 필요. E2E_SHOT_DIR 이 있으면 화면을 저장한다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 필요');
const { chromium } = await import('playwright-core');
const { default: pg } = await import(path.join(root, 'node_modules/pg/lib/index.js'));

const schema = `e2e_${randomBytes(5).toString('hex')}`;
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.query(`SET search_path TO ${schema}`);
const migDir = path.join(root, 'apps/server/src/db/migrations');
for (const m of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) await admin.query(readFileSync(path.join(migDir, m), 'utf8'));
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.searchParams.set('options', `-c search_path=${schema}`);

const store = await mkdtemp(path.join(os.tmpdir(), 'dl-result-e2e-'));
const procs = [];
const start = (args, env = {}) => {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, UV_THREADPOOL_SIZE: '2', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  p.log = '';
  p.stdout.on('data', (d) => (p.log += d));
  p.stderr.on('data', (d) => (p.log += d));
  procs.push(p);
  return p;
};
const waitFor = async (p, re, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (re.test(p.log)) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`시작 대기 시간 초과: ${p.log.slice(-500)}`);
};

// ---- 합성 데이터. 소유자 sub 는 모의 발급자의 demo-owner. 영상 파일은 실제 재생 가능한 mp4 가 아니면 canplay 를 확인하지 않는다.
const OWNER = 'demo-owner';
const items = [
  { id: 'it-1', kind: 'FACT', source: 'USER', text: '에코 버그를 고쳤다', emphasis: true, inVideo: true, excludedReason: null },
  { id: 'it-2', kind: 'FACT', source: 'USER', text: '점심에 김치찌개를 먹었다', emphasis: false, inVideo: true, excludedReason: null },
];
const seed = async (date, pipe, file) => {
  const id = randomUUID();
  await admin.query("INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,$3,now(),'CONFIRMED',now(),now())", [id, OWNER, date]);
  await admin.query('INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,$2,$3,$4,now())', [id, pipe.production, pipe.review, 'NONE']);
  await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'SUMMARY',1,$3,now())", [randomUUID(), id, JSON.stringify({ kind: 'BRIEFING', items, diary: '합성 일기' })]);
  if (file) {
    await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'RESULT',1,$3,now())", [randomUUID(), id, JSON.stringify({ file })]);
    await writeFile(path.join(store, 'videos', file), 'synthetic-video-bytes');
  }
  return id;
};
await mkdir(path.join(store, 'videos'), { recursive: true });
const ok = await seed('2026-10-01', { production: 'DONE', review: 'PASSED' }, 'ok.mp4');
const rejected = await seed('2026-10-02', { production: 'DONE', review: 'REJECTED' }, 'rejected.mp4');
const missing = await seed('2026-10-03', { production: 'DONE', review: 'PASSED' }, 'missing.mp4');
await rm(path.join(store, 'videos', 'missing.mp4'));

let browser;
try {
  const server = start(['--import', 'tsx', 'apps/server/src/auth/demo.ts'], { FILE_STORAGE_DIR: store, DATABASE_URL: dbUrl.toString() });
  await waitFor(server, /auth demo ready/);
  const web = start(['node_modules/vite/bin/vite.js', 'apps/web', '--strictPort']);
  await waitFor(web, /Local:/);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1'] });
  const profiles = [
    ['pc', { viewport: { width: 1280, height: 800 } }],
    ['android-emulated', { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' }],
  ];
  const shot = async (page, name) => { if (shotDir) { await mkdir(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); } };
  const out = [];
  for (const [name, opts] of profiles) {
    const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    const list = page.getByTestId('records-list');
    await list.waitFor();
    const open = async (date) => { await list.locator(`li[data-life-date="${date}"] button`).click(); await page.getByTestId('result-panel').waitFor(); };

    // AC-1: 재생 요소 + 실제 내려받기
    await open('2026-10-01');
    await page.getByTestId('result-video').waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-result').click()]);
    assert.equal(dl.suggestedFilename(), 'ok.mp4');
    await shot(page, `${name}-result-ok`);
    // AC-5: 수정(영상에서 빼기) → 이전 영상이 완성본으로 남지 않는다
    await page.getByRole('button', { name: /영상에서 빼기: 점심에 김치찌개/ }).click();
    await page.getByTestId('revise-notice').waitFor();
    await page.getByTestId('result-problem').waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0);
    assert.equal(await page.getByTestId('download-result').count(), 0);
    assert.match(await page.getByTestId('result-versions').innerText(), /이전 버전\(현재 완성본 아님\)/);
    await shot(page, `${name}-result-revised`);
    await page.getByRole('button', { name: '← 목록' }).click();

    // AC-3: 검수 미통과 / 파일 없음 — 이유와 가능한 조치
    await open('2026-10-02');
    assert.equal(await page.getByTestId('result-video').count(), 0);
    assert.match(await page.getByTestId('result-problem').innerText(), /검수를 통과하지 못/);
    await shot(page, `${name}-result-rejected`);
    await page.getByRole('button', { name: '← 목록' }).click();
    await open('2026-10-03');
    assert.match(await page.getByTestId('result-problem').innerText(), /결과 파일을 찾을 수 없어/);
    assert.ok((await page.getByTestId('result-actions').locator('li').count()) >= 1);
    await shot(page, `${name}-result-missing`);

    // 직접 URL: 미통과 결과는 409
    const r = await page.request.get(`/api/records/${rejected}/results/1/file`);
    assert.equal(r.status(), 409);
    out.push({ profile: name, result: 'PASS' });
    await ctx.close();
  }
  console.log(JSON.stringify({ e2e: out, ids: { ok, rejected, missing } }));
} finally {
  await browser?.close();
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* 이미 종료 */ } }
  await rm(store, { recursive: true, force: true });
  await admin.query('SET search_path TO public').catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
