// TASK-28 브라우저 E2E: 결과 영상 재생·내려받기·확인, 미통과/파일 없음 화면, 수정 요청과 결과 버전(이전 버전이 완성본으로 보이지 않음)을 확인한다. 합성 데이터, 모의 로그인.
// PC(1280x800)와 Android 에뮬레이션(412x915 터치). 실제 Android 기기 검증이 아니다. 필요: DATABASE_URL, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
const start = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

// ---- 합성 데이터 (개인 원문 아님). 영상은 ffmpeg 로 만든 1초 합성 mp4.
const OWNER = 'demo-owner';
const ffmpeg = (file, color) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=180x320:d=1`, '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file], { stdio: 'inherit' });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
});
await mkdir(path.join(store, 'videos'), { recursive: true });
await ffmpeg(path.join(store, 'videos', 'v1.mp4'), 'blue');
await ffmpeg(path.join(store, 'videos', 'v2.mp4'), 'green');
const item = (id, text) => ({ id, kind: 'FACT', source: 'USER', text, emphasis: false, inVideo: true, excludedReason: null });
const ITEMS = [item('s1', '합성: 아침에 산책을 했다'), item('s2', '합성: 점심에 비밀 프로젝트 이야기를 했다'), item('s3', '합성: 저녁에 책을 읽었다')];
const seed = async (date, pipe, { file = null, briefing = false } = {}) => {
  const id = randomUUID();
  await admin.query("INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,$3,now(),'CONFIRMED',now(),now())", [id, OWNER, date]);
  await admin.query('INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,$2,$3,\'NONE\',now())', [id, pipe.production, pipe.review ?? 'NONE']);
  if (briefing) await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'SUMMARY',1,$3,now())", [randomUUID(), id, JSON.stringify({ kind: 'BRIEFING', items: ITEMS, diary: '합성 일기' })]);
  if (file) await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'RESULT',1,$3,now())", [randomUUID(), id, JSON.stringify({ file })]);
  return id;
};

let browser;
try {
  const server = start('npx', ['tsx', 'apps/server/src/auth/demo.ts'], { FILE_STORAGE_DIR: store, DATABASE_URL: dbUrl.toString() });
  await waitFor(server, /auth demo ready/);
  const web = start('npx', ['vite', 'apps/web', '--strictPort'], {});
  await waitFor(web, /Local:/);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--autoplay-policy=no-user-gesture-required'] });
  const profiles = [
    ['pc', { viewport: { width: 1280, height: 800 } }, '01'],
    ['android-emulated', { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' }, '02'],
  ];
  const shot = async (page, name) => { if (shotDir) { await mkdir(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); } };
  const out = [];
  for (const [name, opts, mm] of profiles) {
    const d = (n) => `2026-0${Number(mm) + 6}-${String(n).padStart(2, '0')}`;
    await seed(d(1), { production: 'DONE', review: 'PASSED' }, { file: 'v1.mp4' });
    await seed(d(2), { production: 'DONE', review: 'REJECTED' }, { file: 'v2.mp4' });
    await seed(d(3), { production: 'DONE', review: 'PASSED' }, { file: 'gone.mp4' });
    await seed(d(4), { production: 'FAILED' });
    const rev = await seed(d(5), { production: 'DONE', review: 'PASSED' }, { file: 'v1.mp4', briefing: true });
    const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    const list = page.getByTestId('records-list');
    await list.waitFor();
    const open = async (date) => {
      if (await page.getByRole('button', { name: '← 목록' }).count()) await page.getByRole('button', { name: '← 목록' }).click();
      await page.getByTestId('records-list').waitFor();
      await page.getByTestId('records-list').locator(`li[data-life-date="${date}"] button`).click();
      await page.getByTestId('result-panel').waitFor();
    };

    // AC-1: 완성 영상 재생 + 내려받기 + 사용자 확인
    await open(d(1));
    const video = page.getByTestId('result-video');
    await video.waitFor();
    await page.waitForFunction(() => { const v = document.querySelector('[data-testid=result-video]'); return v && v.readyState >= 1 && v.duration > 0.5; }, null, { timeout: 15000 });
    assert.ok(await video.evaluate((v) => v.videoWidth === 180 && v.videoHeight === 320), '실제 영상 크기');
    assert.ok(await video.evaluate(async (v) => { v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 400)); return v.currentTime > 0; }), '재생 시작');
    const [vid] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-result').click()]);
    assert.equal(vid.suggestedFilename(), 'v1.mp4');
    assert.match(await page.getByTestId('unconfirmed-note').innerText(), /자동으로 확인되거나 공개되지 않습니다/);
    await shot(page, `${name}-completed`);
    await page.getByTestId('confirm-result').click();
    await page.getByTestId('result-confirmed').waitFor();

    // 미통과: 재생·내려받기 없음, 이유와 조치
    await open(d(2));
    await page.getByTestId('result-rejected').waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0);
    assert.equal(await page.getByTestId('download-result').count(), 0);
    assert.match(await page.getByTestId('result-rejected').innerText(), /검수를 통과하지 못해[\s\S]*다시 만들 수 있습니다/);
    await shot(page, `${name}-rejected`);

    // AC-3: 파일 없음 — 이유와 가능한 조치
    await open(d(3));
    const miss = page.getByTestId('result-file-missing');
    await miss.waitFor();
    assert.match(await miss.innerText(), /영상 파일을 찾을 수 없어[\s\S]*수정해서 다시 만들기/);
    assert.equal(await page.getByTestId('result-video').count(), 0);
    assert.equal(await page.getByTestId('download-result').count(), 0);
    await shot(page, `${name}-file-missing`);

    // 처리 실패: 다시 시도 버튼
    await open(d(4));
    await page.getByTestId('result-failed').waitFor();
    await page.getByTestId('retry-production').waitFor();

    // AC-2·5: 수정 요청 → 제작 중에는 이전 버전이 완성본으로 보이지 않는다
    await open(d(5));
    await page.getByTestId('result-video').waitFor();
    await shot(page, `${name}-before-revise`);
    await page.getByTestId('revise-panel').locator('summary').click();
    await page.getByRole('button', { name: /영상에서 빼기: 합성: 점심에 비밀 프로젝트/ }).click();
    await page.getByTestId('remaking').waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0, '수정 중에는 이전 영상이 재생되지 않는다');
    assert.equal(await page.getByTestId('download-result').count(), 0);
    assert.equal(await page.getByTestId('screen-record-detail').getByTestId('status-badge').innerText(), '제작 중');
    assert.deepEqual(await page.getByTestId('version-label').allInnerTexts(), ['이전 버전 (수정 전 검수 통과)']);
    await shot(page, `${name}-remaking`);
    const plan = (await admin.query("SELECT content FROM record_versions WHERE interview_id=$1 AND kind='PRODUCTION_PLAN' ORDER BY version DESC LIMIT 1", [rev])).rows[0].content;
    assert.ok(!JSON.stringify(plan).includes('비밀 프로젝트'), '새 제작 계획에서 제외됨');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM conversation_items WHERE interview_id=$1', [rev])).rows[0].n, 0);
    // 새 결과가 검수 미통과로 나와도 이전 버전이 완성본으로 돌아오지 않는다
    await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'RESULT',2,$3,now())", [randomUUID(), rev, JSON.stringify({ file: 'v2.mp4' })]);
    await admin.query("UPDATE pipeline_states SET production='DONE', review='REJECTED' WHERE interview_id=$1", [rev]);
    await page.reload();
    await page.getByTestId('records-list').waitFor();
    await open(d(5));
    await page.getByTestId('result-rejected').waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0);
    assert.deepEqual(await page.getByTestId('version-label').allInnerTexts(), ['검수 미통과', '이전 버전 (수정 전 검수 통과)']);
    await shot(page, `${name}-new-rejected`);
    // 통과 후에만 새 버전이 완성본
    await admin.query("UPDATE pipeline_states SET review='PASSED' WHERE interview_id=$1", [rev]);
    await page.reload();
    await page.getByTestId('records-list').waitFor();
    await open(d(5));
    await page.getByTestId('result-video').waitFor();
    assert.match(await page.getByTestId('result-video').getAttribute('src'), /results\/2\/file/);
    assert.deepEqual(await page.getByTestId('version-label').allInnerTexts(), ['완료', '이전 버전 (수정 전 검수 통과)']);
    await shot(page, `${name}-after-revise`);
    out.push({ profile: name, result: 'PASS' });
    await ctx.close();
  }
  console.log(JSON.stringify({ e2e: out }));
} finally {
  await browser?.close();
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* 이미 종료 */ } }
  await rm(store, { recursive: true, force: true });
  await admin.query('SET search_path TO public').catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
