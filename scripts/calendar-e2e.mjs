// TASK-49 브라우저 E2E: 합성 기록으로 목록↔달력 전환, 월 이동, 늦게 완성된 영상의 생활일 칸, 빈 날짜(생성 없음), 타 소유자 기록 비노출, 날짜→상세 연결을 확인한다.
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

// ---- 합성 데이터 (개인 원문 아님). 소유자 sub 는 모의 발급자의 demo-owner.
const OWNER = 'demo-owner';
const seed = async (owner, date, { status = 'CONFIRMED', pipe = {}, createdAt = '2026-10-20T09:00:00Z' } = {}) => {
  const id = randomUUID();
  await admin.query('INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$4,$4)', [id, owner, date, createdAt, status]);
  await admin.query('INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,$2,$3,$4,$5)', [id, pipe.production ?? 'NONE', pipe.review ?? 'NONE', pipe.backup ?? 'NONE', createdAt]);
  return id;
};
const version = (id, kind, content) => admin.query('INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,$3,1,$4,now())', [randomUUID(), id, kind, JSON.stringify(content)]);
const count = async () => (await admin.query('SELECT count(*)::int AS n FROM interviews')).rows[0].n;
await mkdir(path.join(store, 'videos'), { recursive: true });
await mkdir(path.join(store, 'attachments'), { recursive: true });

// 9/30 영상은 10/30 에 완성됐다(제작일 10월). 생활일은 9월 30일이어야 한다.
const late = await seed(OWNER, '2026-09-30', { pipe: { production: 'DONE', review: 'PASSED', backup: 'VERIFIED' }, createdAt: '2026-10-30T09:00:00Z' });
await version(late, 'RESULT', { file: 'late.mp4' });
await writeFile(path.join(store, 'videos', 'late.mp4'), 'synthetic-video-bytes');
await seed(OWNER, '2026-10-02', { pipe: { production: 'DONE', review: 'REJECTED' } });
await seed(OWNER, '2026-10-03', { pipe: { production: 'FAILED' } });
await seed(OWNER, '2026-10-04', { pipe: { production: 'WAITING_BUDGET' } });
await seed(OWNER, '2026-10-31', { pipe: { production: 'DONE', review: 'PENDING' } });
await seed(OWNER, '2026-12-31', { pipe: { production: 'DONE', review: 'PASSED' } }); // 연도 경계 확인용
// 다른 소유자의 기록: 같은 달·같은 날짜대에 있어도 보이면 안 된다.
await seed('other-owner', '2026-10-15');
await seed('other-owner', '2026-10-02');

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
    const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
    const page = await ctx.newPage();
    const writes = [];
    page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${r.method()} ${r.url()}`); });
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    await page.getByTestId('records-list').waitFor();

    // AC-1: 기본은 최신순 목록 → 달력 → 다시 목록
    assert.equal(await page.getByTestId('mode-list').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('mode-calendar').click();
    const cal = page.getByTestId('records-calendar');
    await cal.waitFor();
    assert.equal(await page.getByTestId('records-list').count(), 0);
    assert.equal(await page.getByTestId('mode-calendar').getAttribute('aria-pressed'), 'true');
    // 오늘(작성 중) 기록이 없으면 가장 최근 생활일 2026-12-31 의 달에서 시작한다.
    const month = () => page.getByTestId('cal-month').innerText();
    const cell = (d) => cal.locator(`td[data-date="${d}"]`);
    assert.equal(await month(), '2026년 12월');
    assert.equal(await cell('2026-12-31').getAttribute('data-has-record'), 'true');
    await shot(page, `${name}-calendar-dec`);
    await page.getByTestId('cal-prev').click(); // 11월(기록 없음)
    assert.equal(await month(), '2026년 11월');
    assert.equal(await cal.locator('td[data-has-record=true]').count(), 0);
    await page.getByTestId('cal-prev').click(); // 10월
    assert.equal(await month(), '2026년 10월');
    // AC-4: 다른 소유자의 10/15 는 보이지 않고, 10/02 는 내 기록(검수 미통과)으로만 표시된다.
    assert.equal(await cell('2026-10-15').getAttribute('data-has-record'), 'false');
    assert.equal(await cell('2026-10-02').locator('[data-testid=status-badge]').innerText(), '검수 미통과');
    assert.deepEqual(
      await Promise.all(['2026-10-03', '2026-10-04', '2026-10-31'].map((d) => cell(d).locator('[data-testid=status-badge]').innerText())),
      ['처리 실패', '예산 대기', '검수 중'],
    );
    // AC-2: 10/30 에 완성된 9/30 영상은 10월 30일 칸에 없고 9월 30일 칸(완료)에 있다.
    assert.equal(await cell('2026-10-30').getAttribute('data-has-record'), 'false');
    await shot(page, `${name}-calendar-oct`);
    await page.getByTestId('cal-prev').click();
    assert.equal(await month(), '2026년 9월');
    assert.equal(await cell('2026-09-30').locator('[data-testid=status-badge]').innerText(), '완료');
    await page.getByTestId('cal-next').click();

    // AC-3: 기록 없는 날짜(과거 10/10, 10/15)를 눌러도 아무것도 생성되지 않고 쓰기 요청도 없다.
    // (첨부 패널이 화면을 열 때 오늘 기록을 만드는 기존 동작은 클릭과 무관하므로 여기서부터 쓰기 요청을 센다.)
    await page.waitForLoadState('load');
    writes.length = 0;
    const before = await count();
    await cell('2026-10-10').getByRole('button').click();
    assert.match(await page.getByTestId('cal-empty-day').innerText(), /2026-10-10에는 기록이 없습니다/);
    await cell('2026-10-15').getByRole('button').click();
    assert.match(await page.getByTestId('cal-empty-day').innerText(), /2026-10-15에는 기록이 없습니다/);
    assert.equal(await page.getByTestId('screen-record-detail').count(), 0);
    assert.equal(await count(), before, '빈 날짜 클릭으로 기록이 생기지 않아야 한다');
    assert.deepEqual(writes, []);
    await shot(page, `${name}-calendar-empty-day`);

    // AC-4: 날짜 선택 → 해당 기록 상세(제작이 늦은 9/30 포함), 돌아오면 달력 모드와 달이 유지되는지 확인
    await cell('2026-10-02').getByRole('button').click();
    const detail = page.getByTestId('screen-record-detail');
    await detail.getByTestId('status-hint').waitFor();
    assert.match(await detail.locator('h3').innerText(), /^2026-10-02\s/);
    assert.equal(await detail.getByTestId('status-badge').innerText(), '검수 미통과');
    await shot(page, `${name}-calendar-detail`);
    await page.getByRole('button', { name: '← 목록' }).click();
    await cal.waitFor();
    await page.getByTestId('cal-prev').click();
    await cell('2026-09-30').getByRole('button').click();
    await detail.getByTestId('status-hint').waitFor();
    assert.match(await detail.locator('h3').innerText(), /^2026-09-30\s/);
    assert.equal(await detail.getByTestId('status-badge').innerText(), '완료');
    assert.equal(await page.getByTestId('download-result').count(), 1);
    await page.getByRole('button', { name: '← 목록' }).click();

    // 직접 URL 접근: 다른 소유자 기록 id 는 상세에서도 찾을 수 없다(API 404)
    const otherId = (await admin.query("SELECT id FROM interviews WHERE owner_id='other-owner' AND life_date='2026-10-15'")).rows[0].id;
    const r = await page.request.get(`http://127.0.0.1:5173/api/records/${otherId}`);
    assert.equal(r.status(), 404);

    // 다시 목록으로
    await page.getByTestId('mode-list').click();
    await page.getByTestId('records-list').waitFor();
    assert.equal(await page.getByTestId('records-calendar').count(), 0);
    const dates = await page.getByTestId('records-list').locator('li').evaluateAll((els) => els.map((e) => e.getAttribute('data-life-date')));
    assert.ok(!dates.includes('2026-10-15'), '타 소유자 기록은 목록에도 없다');
    assert.deepEqual([...dates].sort().reverse(), dates);
    assert.deepEqual(writes, []);
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
