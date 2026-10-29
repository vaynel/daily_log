// TASK-28 브라우저 E2E: 결과 재생·내려받기·파일 없음·검수 전/미통과 차단·버튼 수정·이전 버전 구분을 확인한다(합성 데이터, 모의 OIDC 소유자 demo-owner).
// PC(1280x800)와 Android 에뮬레이션(412x915 터치). 실제 Android 기기 검증이 아니다. 필요: DATABASE_URL, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
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

const store = await mkdtemp(path.join(os.tmpdir(), 'dl-view-e2e-'));
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

// ---- 합성 데이터 (개인 원문 아님)
const OWNER = 'demo-owner';
const PLAN = { source: 'BRIEFING', briefingVersion: 1, lines: ['합성: 캐시 설정을 정리했다', '합성: 동료와 점심을 먹었다'], items: [{ id: 'i1', text: '합성: 캐시 설정을 정리했다', emphasis: false }, { id: 'i2', text: '합성: 동료와 점심을 먹었다', emphasis: false }] };
const seed = async (date, pipe, file) => {
  const id = randomUUID();
  await admin.query("INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,$3,'2026-10-20T09:00:00Z','CONFIRMED','2026-10-20T09:00:00Z','2026-10-20T09:00:00Z')", [id, OWNER, date]);
  await admin.query("INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,$2,$3,'NONE',now())", [id, pipe.production, pipe.review]);
  await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'PRODUCTION_PLAN',1,$3,now())", [randomUUID(), id, JSON.stringify(PLAN)]);
  if (file) await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'RESULT',1,$3,now())", [randomUUID(), id, JSON.stringify({ file })]);
  return id;
};
await mkdir(path.join(store, 'videos'), { recursive: true });
// 실제로 재생되는 아주 짧은 mp4 (FFmpeg 합성 영상, -threads 2)
for (const f of ['ok.mp4', 'edit.mp4', 'new.mp4']) {
  await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-threads', '2', '-f', 'lavfi', '-i', 'color=c=0x336699:s=180x320:d=1:r=10', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(store, 'videos', f)], { stdio: 'ignore' }).on('exit', (c) => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))));
}
const D = { ok: '2026-10-01', rej: '2026-10-02', pend: '2026-10-03', miss: '2026-10-04', edit: '2026-10-05' };
await seed(D.ok, { production: 'DONE', review: 'PASSED' }, 'ok.mp4');
await seed(D.rej, { production: 'DONE', review: 'REJECTED' }, 'ok.mp4');
await seed(D.pend, { production: 'DONE', review: 'PENDING' }, 'ok.mp4');
await seed(D.miss, { production: 'DONE', review: 'PASSED' }, 'gone.mp4');
const editId = await seed(D.edit, { production: 'DONE', review: 'PASSED' }, 'edit.mp4');

let browser;
try {
  const server = start('npx', ['tsx', 'apps/server/src/auth/demo.ts'], { FILE_STORAGE_DIR: store, DATABASE_URL: dbUrl.toString() });
  await waitFor(server, /auth demo ready/);
  const web = start('npx', ['vite', 'apps/web', '--strictPort'], {});
  await waitFor(web, /Local:/);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1'] });
  const profiles = [
    ['pc', { viewport: { width: 1280, height: 800 } }],
    ['android-emulated', { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' }],
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
    const back = () => page.getByRole('button', { name: '← 목록' }).click();

    // AC-1: 완성 영상 재생(실제 mp4 디코딩) + 내려받기
    await open(D.ok);
    const video = page.getByTestId('result-video');
    await video.waitFor();
    await page.waitForFunction(() => { const v = document.querySelector('[data-testid=result-video]'); return v && v.readyState >= 1 && v.duration > 0.5; });
    const dur = await video.evaluate((v) => v.duration);
    assert.ok(dur > 0.5 && dur < 3, `재생 길이 ${dur}`);
    await shot(page, `${name}-completed-play`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-result').click()]);
    assert.equal(dl.suggestedFilename(), 'ok.mp4');
    await back();

    // AC-5/AC-4: 검수 미통과·검수 중 → 영상·내려받기 없음, 안내만
    for (const [date, label] of [[D.rej, '검수 미통과'], [D.pend, '검수 중']]) {
      await open(date);
      assert.equal(await page.getByTestId('result-video').count(), 0);
      assert.equal(await page.getByTestId('download-result').count(), 0);
      assert.match(await page.getByTestId('result-notice').innerText(), new RegExp(label));
      if (date === D.rej) await shot(page, `${name}-review-rejected`);
      await back();
    }

    // AC-3: 파일 없음 → 이유와 가능한 조치
    await open(D.miss);
    await page.getByTestId('result-file-missing').waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0);
    assert.equal(await page.getByTestId('download-result').count(), 0);
    assert.match(await page.getByTestId('result-file-missing').innerText(), /찾을 수 없어/);
    assert.ok((await page.getByTestId('missing-actions').locator('li').count()) >= 2);
    await shot(page, `${name}-file-missing`);
    await back();
  }

  // 수정 흐름은 한 번만(PC): 항목 빼기 → 제작 중, 이전 버전은 정상 완성본이 아님 → 새 결과 검수 전/후
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    const list = page.getByTestId('records-list');
    await list.waitFor();
    await list.locator(`li[data-life-date="${D.edit}"] button`).click();
    await page.getByTestId('result-video').waitFor();
    await shot(page, 'pc-before-edit');
    await page.getByTestId('plan-items').locator('li', { hasText: '동료와 점심' }).getByTestId('exclude-item').click();
    await page.getByTestId('revision-message').getByText(/접수했습니다/).waitFor();
    await page.getByTestId('status-badge').filter({ hasText: '제작 중' }).waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0, '수정 직후 이전 영상은 완성본으로 보이지 않는다');
    assert.equal(await page.getByTestId('download-result').count(), 0);
    assert.match(await page.getByTestId('previous-versions').innerText(), /버전 1 · 이전 버전/);
    await shot(page, 'pc-after-edit-producing');
    // 제작이 새 결과를 만들었지만 검수 전
    await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'RESULT',2,'{\"file\":\"new.mp4\"}',now())", [randomUUID(), editId]);
    await admin.query("UPDATE pipeline_states SET production='DONE', review='PENDING' WHERE interview_id=$1", [editId]);
    await page.reload();
    await page.getByTestId('records-list').locator(`li[data-life-date="${D.edit}"] button`).click();
    await page.getByTestId('result-notice').waitFor();
    assert.equal(await page.getByTestId('result-video').count(), 0);
    await admin.query("UPDATE pipeline_states SET review='PASSED' WHERE interview_id=$1", [editId]);
    await page.reload();
    await page.getByTestId('records-list').locator(`li[data-life-date="${D.edit}"] button`).click();
    await page.getByTestId('result-video').waitFor();
    assert.match(await page.getByTestId('result-video').getAttribute('src'), /results\/2\/file$/);
    assert.match(await page.getByTestId('previous-versions').innerText(), /현재 완성본 아님/);
    await shot(page, 'pc-after-edit-completed');
    await page.getByTestId('confirm-result').click();
    await page.getByTestId('result-confirmed').waitFor();
    await ctx.close();
  }
  console.log(JSON.stringify({ e2e: [{ profile: 'pc', result: 'PASS' }, { profile: 'android-emulated', result: 'PASS' }, { flow: 'edit', result: 'PASS' }] }));
} finally {
  await browser?.close();
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* 이미 종료 */ } }
  await rm(store, { recursive: true, force: true });
  await admin.query('SET search_path TO public').catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
