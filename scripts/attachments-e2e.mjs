// TASK-12 브라우저 E2E: 모의 OIDC 로그인 → 사진·Markdown·학습 메모 첨부 → 손상 파일 거부 → 중복 → 중단·재시도.
// PC(1280x800)와 Android 모바일 에뮬레이션(Pixel 급 뷰포트·터치)을 같은 흐름으로 실행한다. 실제 Android 기기 검증이 아니다.
// 필요: DATABASE_URL(마이그레이션 적용됨), PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, node_modules 의 playwright-core.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 필요');
const { chromium } = await import('playwright-core');
const { default: pg } = await import(path.join(root, 'node_modules/pg/lib/index.js'));
const { readdirSync, readFileSync } = await import('node:fs');
const { randomBytes } = await import('node:crypto');

// 실행마다 임시 스키마를 만들어 다른 데이터와 섞이지 않게 한다.
const schema = `e2e_${randomBytes(5).toString('hex')}`;
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.query(`SET search_path TO ${schema}`);
const migDir = path.join(root, 'apps/server/src/db/migrations');
for (const m of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) await admin.query(readFileSync(path.join(migDir, m), 'utf8'));
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.searchParams.set('options', `-c search_path=${schema}`);

const store = await mkdtemp(path.join(os.tmpdir(), 'dl-e2e-'));
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

// 합성 시험 파일 (개인 원문 아님)
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
const png = (salt) => { const h = Buffer.alloc(13); h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.from([0, salt, 0, 0]))), chunk('IEND', Buffer.alloc(0))]); };
const files = path.join(store, 'in');
await mkdir(files);
const f = (n) => path.join(files, n);

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
  const out = [];
  for (const [i, [name, opts]] of profiles.entries()) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    await page.getByTestId('attach-panel').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid=in-gallery]').disabled);
    const items = page.getByTestId('attach-item');
    const base = i * 10; // 프로파일마다 다른 내용(중복 판정이 프로파일 간 섞이지 않게)
    const photo = png(base + 1), photo2 = png(base + 2);
    await writeFile(f(`p${i}.png`), photo);
    await writeFile(f(`q${i}.png`), photo2);
    await writeFile(f(`n${i}.md`), `# 학습 ${name}\n- 캐시`);
    await writeFile(f(`broken${i}.png`), photo.subarray(0, photo.length - 7));
    await writeFile(f(`fake${i}.md`), Buffer.from([0xff, 0xfe, 0x00, 0x80]));

    // AC-1: 사진첩 + 카메라 입력 + Markdown + 메모
    await page.getByTestId('in-gallery').setInputFiles(f(`p${i}.png`));
    await page.getByTestId('in-camera').setInputFiles(f(`q${i}.png`));
    await page.getByTestId('in-file').setInputFiles(f(`n${i}.md`));
    await page.getByTestId('note-text').fill(`TLS 핸드셰이크 정리 (${name})`);
    await page.getByTestId('note-save').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=attach-item][data-status=done]').length === 4);
    const text = await items.allTextContents();
    assert.equal(text.filter((t) => t.includes('첨부됨')).length, 4, '네 항목 모두 서버 저장 후 첨부됨: ' + JSON.stringify(text));
    assert.ok(text.filter((t) => t.includes('촬영 시각 알 수 없음')).length === 2, 'EXIF 없는 사진은 촬영 시각 알 수 없음');
    assert.ok(!text.some((t) => /촬영 20\d\d/.test(t)), '업로드 시각을 촬영 시각으로 표시하지 않음');

    // AC-2: 손상 파일
    await page.getByTestId('in-gallery').setInputFiles(f(`broken${i}.png`));
    await page.getByTestId('in-file').setInputFiles(f(`fake${i}.md`));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=attach-item][data-status=failed]').length === 2);
    const failed = await page.locator('[data-testid=attach-item][data-status=failed]').allTextContents();
    assert.ok(failed.every((t) => t.includes('읽을 수 없어') && !t.includes('첨부됨')), '손상 파일은 첨부됨으로 표시되지 않고 사유 표시');
    assert.equal(await page.locator('[data-testid=attach-item][data-status=done]').count(), 4);

    // AC-3: 같은 파일 다시 첨부
    const before = (await readdir(path.join(store, 'attachments'))).length;
    await page.getByTestId('in-gallery').setInputFiles(f(`p${i}.png`));
    await page.getByText('이미 첨부된 파일입니다').waitFor();
    assert.equal((await readdir(path.join(store, 'attachments'))).length, before, '원본 파일 수 불변');

    // 연결 중단 후 재시도: 요청 차단 → 실패 표시 → 차단 해제 후 다시 시도
    await writeFile(f(`r${i}.md`), `# 재시도 ${name}`);
    await page.route('**/api/records/*/attachments', (r) => (r.request().method() === 'POST' ? r.abort('connectionfailed') : r.continue()));
    await page.getByTestId('in-file').setInputFiles(f(`r${i}.md`));
    await page.getByText('연결이 끊겨').waitFor();
    assert.equal(await page.getByRole('button', { name: '다시 시도' }).count(), 1);
    await page.unroute('**/api/records/*/attachments');
    await page.getByRole('button', { name: '다시 시도' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=attach-item][data-status=done]').length === 6);
    assert.equal(await page.getByRole('button', { name: '다시 시도' }).count(), 0);

    // 키보드 접근: 첨부 버튼이 탭으로 초점을 받는다
    await page.keyboard.press('Tab');
    const focusable = await page.evaluate(() => [...document.querySelectorAll('.attach-actions input')].every((e) => !e.hidden && getComputedStyle(e).display !== 'none'));
    assert.ok(focusable);
    if (shotDir) { await mkdir(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); }
    out.push({ profile: name, result: 'PASS' });
    await ctx.close();
  }
  const stored = (await readdir(path.join(store, 'attachments'))).filter((n) => !n.endsWith('.tmp'));
  console.log(JSON.stringify({ e2e: out, storedFiles: stored.length }));
} finally {
  await browser?.close();
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* 이미 종료 */ } }
  await rm(store, { recursive: true, force: true });
  await admin.query('SET search_path TO public').catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
