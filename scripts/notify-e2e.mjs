// TASK-18 브라우저 E2E: 알림 설정 화면(시각 변경 저장·재접속 유지), 권한 거부 안내, 전달 실패 안내(기록 상태 불변), 알림 클릭 주소로 기록 상세 열기.
// 모의 OIDC 로그인(demo-owner)과 합성 데이터. PC(1280x800)와 Android 에뮬레이션(412x915). 실제 Android 알림 표시 검증이 아니다.
// 필요: DATABASE_URL, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. 선택: E2E_SHOT_DIR.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
const webRoot = process.env.E2E_WEB_ROOT ?? 'apps/web';
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

const store = await mkdtemp(path.join(os.tmpdir(), 'dl-notify-e2e-'));
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

const OWNER = 'demo-owner';
const interview = randomUUID();
await admin.query("INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,'2026-10-19','2026-10-19T11:00:00Z','CONFIRMED',now(),now())", [interview, OWNER]);
await admin.query("INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,'DONE','PASSED','NONE',now())", [interview]);
await admin.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'RESULT',1,'{\"file\":\"late.mp4\"}',now())", [randomUUID(), interview]);

let browser;
try {
  const server = start('npx', ['tsx', 'apps/server/src/auth/demo.ts'], { FILE_STORAGE_DIR: store, DATABASE_URL: dbUrl.toString() });
  await waitFor(server, /auth demo ready/);
  const web = start('npx', ['vite', webRoot, '--strictPort'], {});
  await waitFor(web, /Local:/);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
  const profiles = [
    ['pc', { viewport: { width: 1280, height: 800 } }],
    ['android-emulated', { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' }],
  ];
  const shot = async (page, name) => { if (shotDir) { await mkdir(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); } };
  const out = [];
  for (const [name, opts] of profiles) {
    await admin.query('TRUNCATE notifications, notification_settings, push_subscriptions');
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    const panel = page.getByTestId('notify-settings');
    await panel.waitFor();
    // 기본값 22:00, 권한은 아직 허용 전
    await page.waitForFunction(() => document.querySelector('[data-testid=notify-time]')?.value === '22:00');
    assert.match(await page.getByTestId('notify-subscribed').innerText(), /연결 안 됨/);
    await shot(page, `${name}-notify-default`);

    // AC-3: 시각을 바꾸고 저장 → 안내 문구, DB 저장, 새로고침 후에도 유지
    await page.getByTestId('notify-time').fill('21:15');
    await page.getByTestId('notify-save').click();
    await page.getByTestId('notify-msg').waitFor();
    assert.match(await page.getByTestId('notify-msg').innerText(), /21:15/);
    assert.equal((await admin.query('SELECT interview_time FROM notification_settings WHERE owner_id=$1', [OWNER])).rows[0].interview_time, '21:15');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid=notify-time]')?.value === '21:15');

    // 권한 거부(Notification.permission=denied 모의): 해결 방법 안내. 기기 설정 진입 경로를 문구로 제시한다.
    await page.addInitScript(() => { Object.defineProperty(Notification, 'permission', { get: () => 'denied' }); });
    await page.reload();
    await page.getByTestId('notify-permission').waitFor();
    assert.match(await page.getByTestId('notify-permission').innerText(), /설정 > 앱 > 알림/);
    assert.equal(await page.getByTestId('notify-enable').innerText(), '권한 다시 확인');

    // AC-5: 전달 실패 알림(서버가 기록)은 안내로 보이고, 기록 상태는 그대로 완료
    await admin.query("INSERT INTO notifications (owner_id, kind, dedupe_key, life_date, interview_id, url, title, body, status, error_code, attempts) VALUES ($1,'RESULT_COMPLETED','e2e:1','2026-10-19',$2,$3,'t','b','UNDELIVERABLE','PERMISSION_DENIED',1)", [OWNER, interview, `/?record=${interview}`]);
    await page.reload();
    await page.getByTestId('notify-recent').waitFor();
    const recent = await page.getByTestId('notify-recent').innerText();
    assert.match(recent, /영상 완성 \(2026-10-19\): 전달 불가/);
    assert.match(recent, /기록과 영상은 그대로입니다/);
    await shot(page, `${name}-notify-denied-failure`);
    const rec = (await admin.query('SELECT p.production, p.review, i.status FROM pipeline_states p JOIN interviews i ON i.id=p.interview_id WHERE i.id=$1', [interview])).rows[0];
    assert.deepEqual(rec, { production: 'DONE', review: 'PASSED', status: 'CONFIRMED' });

    // AC-4: 알림 클릭 주소(/?record=<id>)로 해당 기록 상세가 열린다
    await page.goto(`http://127.0.0.1:5173/?record=${interview}`);
    await page.getByTestId('status-hint').waitFor();
    assert.match(await page.getByTestId('screen-record-detail').innerText(), /2026-10-19/);
    await shot(page, `${name}-notify-click-opens-record`);
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
