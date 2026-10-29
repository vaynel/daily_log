// TASK-69 브라우저 E2E: 130건 합성 기록으로 '이전 기록 더 보기' 페이지 이어붙임(중복·누락 없음, 내림차순), 달력의 자동 이어 불러오기, 결과 파일 없는 완료 표시를 확인한다.
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

// ---- 합성 데이터 (개인 원문 아님).
const OWNER = 'demo-owner';
const seed = async (owner, date, { pipe = {}, createdAt = '2026-10-20T09:00:00Z' } = {}) => {
  const id = randomUUID();
  await admin.query("INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'CONFIRMED',$4,$4)", [id, owner, date, createdAt]);
  await admin.query('INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,$2,$3,$4,$5)', [id, pipe.production ?? 'NONE', pipe.review ?? 'NONE', pipe.backup ?? 'NONE', createdAt]);
  return id;
};
const version = (id, kind, content) => admin.query('INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,$3,1,$4,now())', [randomUUID(), id, kind, JSON.stringify(content)]);
await mkdir(path.join(store, 'videos'), { recursive: true });
await mkdir(path.join(store, 'attachments'), { recursive: true });

const DONE = { production: 'DONE', review: 'PASSED', backup: 'VERIFIED' };
// 2025-01-01 부터 120일(2025-04-30까지) 기록 + 2026-10 의 완료 2건(파일 있음/없음) + 타 소유자 1건.
await admin.query(
  `INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at)
   SELECT gen_random_uuid(), $1, DATE '2025-01-01' + g, now(), 'CONFIRMED', now(), now() FROM generate_series(0, 119) g`, [OWNER]);
const withFile = await seed(OWNER, '2026-10-03', { pipe: DONE });
await version(withFile, 'RESULT', { file: 'ok.mp4' });
await writeFile(path.join(store, 'videos', 'ok.mp4'), 'synthetic-video-bytes');
const noFile = await seed(OWNER, '2026-10-02', { pipe: DONE });
await version(noFile, 'RESULT', { file: 'gone.mp4' });
await seed('other-owner', '2026-10-01');
const total = (await admin.query('SELECT count(*)::int AS n FROM interviews WHERE owner_id=$1', [OWNER])).rows[0].n;

let browser;
try {
  const server = start('npx', ['tsx', 'apps/server/src/auth/demo.ts'], { FILE_STORAGE_DIR: store, DATABASE_URL: dbUrl.toString() });
  await waitFor(server, /auth demo ready/);
  const web = start('npx', ['vite', 'apps/web', '--strictPort'], {});
  await waitFor(web, /Local:/);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
  const profiles = [
    ['pc', { viewport: { width: 1280, height: 800 } }],
    ['android-emulated', { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' }],
  ];
  const shot = async (page, name) => { if (shotDir) { await mkdir(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); } };
  const out = [];
  for (const [name, opts] of profiles) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const listReqs = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/records') listReqs.push(u.search); });
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    await page.getByTestId('records-list').waitFor();
    const rows = page.getByTestId('records-list').locator('li');
    const dates = () => rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-life-date')));

    // AC-2: 첫 페이지는 50건이고 '더 보기'로 이어 붙는다. 오늘(작성 중) 기록은 첨부 패널의 기존 동작으로 생길 수 있어 전체 수를 서버 기준으로 비교한다.
    const first = await rows.count();
    assert.equal(first, 50, '첫 페이지는 기본 개수');
    assert.ok(listReqs[0].includes('limit=50') && !listReqs[0].includes('cursor'));
    await shot(page, `${name}-list-first-page`);
    let guard = 0;
    while (await page.getByTestId('load-more').count()) {
      const n = await rows.count();
      await page.getByTestId('load-more').click();
      await page.waitForFunction(([sel, k]) => document.querySelectorAll(sel).length > k, ['[data-testid=records-list] li', n]);
      assert.ok(++guard < 10);
    }
    const all = await dates();
    const serverCount = (await admin.query('SELECT count(*)::int AS n FROM interviews WHERE owner_id=$1', [OWNER])).rows[0].n;
    assert.ok(serverCount >= total);
    assert.equal(all.length, serverCount, '누락 없음');
    assert.equal(new Set(all).size, all.length, '중복 없음');
    assert.deepEqual([...all].sort().reverse(), all, '생활일 내림차순 유지');
    assert.ok(!all.includes('2026-10-01'), '타 소유자 기록 비노출');
    assert.equal(await page.getByTestId('load-more').count(), 0, '마지막 페이지 뒤에는 더 보기가 없다');
    assert.ok(listReqs.some((q) => q.includes('cursor=')));
    await shot(page, `${name}-list-all-loaded`);

    // AC-3: 결과 파일 없는 완료는 '결과 파일 없음'(경고), 파일 있는 완료는 '완료'
    const badge = (d) => page.locator(`li[data-life-date="${d}"] [data-testid=status-badge]`);
    assert.equal(await badge('2026-10-02').innerText(), '결과 파일 없음');
    assert.equal(await badge('2026-10-02').getAttribute('data-status'), 'RESULT_FILE_MISSING');
    assert.equal(await badge('2026-10-03').innerText(), '완료');
    await page.locator('li[data-life-date="2026-10-02"] button').click();
    const detail = page.getByTestId('screen-record-detail');
    await detail.getByTestId('status-hint').waitFor();
    assert.equal(await detail.getByTestId('status-badge').innerText(), '결과 파일 없음');
    assert.ok(!(await detail.getByTestId('status-hint').innerText()).includes('제작과 검수가 끝났습니다'));
    assert.equal(await page.getByTestId('result-problem').count(), 1);
    assert.equal(await page.getByTestId('download-result').count(), 0);
    await shot(page, `${name}-detail-result-missing`);
    await page.getByRole('button', { name: '← 목록' }).click();
    await page.locator('li[data-life-date="2026-10-03"] button').click();
    await detail.getByTestId('status-hint').waitFor();
    assert.equal(await detail.getByTestId('status-badge').innerText(), '완료');
    assert.equal(await page.getByTestId('download-result').count(), 1);
    await page.getByRole('button', { name: '← 목록' }).click();

    // 달력: 첫 페이지에 없는 2025년 2월로 이동하면 필요한 만큼 자동으로 이어 불러와 기록이 보인다(없는 날로 잘못 표시되지 않음).
    await page.getByTestId('mode-calendar').click();
    await page.getByTestId('records-calendar').waitFor();
    await page.getByTestId('cal-month').waitFor();
    const month = () => page.getByTestId('cal-month').innerText();
    const target = '2025년 2월';
    for (let i = 0; i < 40 && (await month()) !== target; i++) await page.getByTestId('cal-prev').click();
    assert.equal(await month(), target);
    await page.locator('td[data-date="2025-02-14"][data-has-record=true]').waitFor();
    assert.equal(await page.locator('td[data-has-record=true]').count(), 28);
    await shot(page, `${name}-calendar-autoload`);
    // 10월 달력의 '결과 파일 없음' 칸 라벨
    for (let i = 0; i < 40 && (await month()) !== '2026년 10월'; i++) await page.getByTestId('cal-next').click();
    assert.equal(await page.locator('td[data-date="2026-10-02"] [data-testid=status-badge]').innerText(), '결과 파일 없음');
    out.push({ profile: name, result: 'PASS', rows: all.length });
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
