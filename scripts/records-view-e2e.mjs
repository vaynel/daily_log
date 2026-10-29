// TASK-16 브라우저 E2E: 합성 기록을 DB 에 직접 넣고(모의 OIDC 로그인 소유자 demo-owner) 목록 정렬·상세·상태 구분·파일 누락·접근 만료를 확인한다.
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
const seed = async (date, { status = 'CONFIRMED', pipe = {}, createdAt = '2026-10-20T09:00:00Z' } = {}) => {
  const id = randomUUID();
  await admin.query('INSERT INTO interviews (id, owner_id, life_date, started_at, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$4,$4)', [id, OWNER, date, createdAt, status]);
  await admin.query('INSERT INTO pipeline_states (interview_id, production, review, backup, updated_at) VALUES ($1,$2,$3,$4,$5)', [id, pipe.production ?? 'NONE', pipe.review ?? 'NONE', pipe.backup ?? 'NONE', createdAt]);
  return id;
};
const version = (id, kind, content) => admin.query('INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,$3,1,$4,now())', [randomUUID(), id, kind, JSON.stringify(content)]);
await mkdir(path.join(store, 'videos'), { recursive: true });
await mkdir(path.join(store, 'attachments'), { recursive: true });

// 10/01 영상은 가장 늦게(2026-10-30) 완성됐지만 생활일은 가장 오래됐다.
const d01 = await seed('2026-10-01', { pipe: { production: 'DONE', review: 'PASSED', backup: 'VERIFIED' }, createdAt: '2026-10-30T09:00:00Z' });
await version(d01, 'RESULT', { file: 'day-01.mp4' });
await writeFile(path.join(store, 'videos', 'day-01.mp4'), 'synthetic-video-bytes');
const d02 = await seed('2026-10-02', { pipe: { production: 'DONE', review: 'REJECTED' } });
await version(d02, 'RESULT', { file: 'day-02.mp4' });
await seed('2026-10-03', { pipe: { production: 'FAILED' } });
await seed('2026-10-04', { pipe: { production: 'WAITING_BUDGET' } });
const d05 = await seed('2026-10-05', { pipe: { production: 'DONE', review: 'PASSED', backup: 'FAILED' } });
await version(d05, 'RESULT', { file: 'day-05-missing.mp4' }); // 파일 없음
const d06 = await seed('2026-10-06', { pipe: { production: 'DONE', review: 'PENDING' } });
const q = randomUUID(), a = randomUUID();
await admin.query("INSERT INTO conversation_items (id, interview_id, seq, idempotency_key, kind, body, saved_at) VALUES ($1,$3,1,'k1','QUESTION','오늘 어떤 일이 있었나요?',now()),($2,$3,2,'k2','ANSWER','합성 답변: 캐시 설정을 정리했다',now())", [q, a, d06]);
const sum = 'b'.repeat(64);
await admin.query("INSERT INTO attachment_refs (id, interview_id, item_id, idempotency_key, storage_key, checksum, saved_at, kind, original_name, mime_type, size_bytes) VALUES ($1,$2,$3,'a1',$4,$5,now(),'MARKDOWN','notes.md','text/markdown',20)", [randomUUID(), d06, a, `${sum}.md`, sum]);
await writeFile(path.join(store, 'attachments', `${sum}.md`), '# 합성 학습 메모\n');
await version(d06, 'SUMMARY', { diary: '합성 일기: 캐시 설정을 정리했다.', learning: ['캐시 무효화 전략'] });

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
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('link', { name: 'Google로 로그인' }).click();
    const list = page.getByTestId('records-list');
    await list.waitFor();

    // AC-1: 생활일 최신순. 10/01(가장 늦게 완성)은 맨 아래, 오늘(작성 중)이 맨 위.
    const dates = await list.locator('li').evaluateAll((els) => els.map((e) => e.getAttribute('data-life-date')));
    // (화면의 첨부 패널이 오늘 기록을 만들 수 있으므로 시험용 날짜만 비교)
    assert.deepEqual(dates.filter((d) => d <= '2026-10-06'), ['2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);
    assert.deepEqual([...dates].sort().reverse(), dates, '최신순');
    assert.equal(dates.at(-1), '2026-10-01', '가장 늦게 완성된 영상이 생활일 기준 맨 아래');
    // AC-3: 상태 라벨 구분
    const label = (d) => list.locator(`li[data-life-date="${d}"] [data-testid=status-badge]`).innerText();
    assert.deepEqual(
      await Promise.all(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06'].map(label)),
      ['완료', '검수 미통과', '처리 실패', '예산 대기', '검수 중'],
    );
    await shot(page, `${name}-list`);

    // AC-2: 상세 — 대화 원본·일기·학습·첨부 연결, 첨부 내려받기
    await list.locator('li[data-life-date="2026-10-06"] button').click();
    await page.getByTestId('screen-record-detail').getByTestId('conversation').waitFor();
    assert.match(await page.getByTestId('conversation').innerText(), /오늘 어떤 일이 있었나요\?[\s\S]*캐시 설정을 정리했다[\s\S]*notes\.md/);
    assert.match(await page.getByTestId('diary').innerText(), /캐시 설정을 정리했다/);
    assert.match(await page.getByTestId('learning').innerText(), /캐시 무효화 전략/);
    const [att] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /notes\.md/ }).click()]);
    assert.equal(att.suggestedFilename(), 'notes.md');
    assert.equal(await page.getByTestId('download-result').count(), 0, '결과 없음 → 영상 다운로드 없음');
    await shot(page, `${name}-detail`);
    await page.getByRole('button', { name: '← 목록' }).click();

    // AC-3: 상태별 상세 — 문구와 다음 행동이 상태마다 다르다
    const expectDetail = async (date, badge, action, hint) => {
      await list.locator(`li[data-life-date="${date}"] button`).click();
      await page.getByTestId('status-hint').waitFor();
      assert.equal(await page.getByTestId('screen-record-detail').getByTestId('status-badge').innerText(), badge);
      assert.match(await page.getByTestId('next-actions').innerText(), action);
      if (hint) assert.match(await page.getByTestId('status-hint').innerText(), hint);
      await page.getByRole('button', { name: '← 목록' }).click();
    };
    await expectDetail('2026-10-02', '검수 미통과', /내용 수정 후 다시 만들기/);
    await expectDetail('2026-10-03', '처리 실패', /다시 시도/);
    await expectDetail('2026-10-04', '예산 대기', /기다리면 됩니다/, /자동으로 유료 전환하지 않습니다/);

    // AC-4: 파일 누락 → 다운로드 없음·경고 / 파일 있음 → 실제 내려받기
    await list.locator('li[data-life-date="2026-10-05"] button').click();
    await page.getByTestId('result-problem').waitFor();
    assert.equal(await page.getByTestId('download-result').count(), 0);
    assert.doesNotMatch(await page.getByTestId('next-actions').innerText(), /내려받기/);
    assert.match(await page.getByTestId('pipeline').innerText(), /백업 실패/);
    await shot(page, `${name}-file-missing`);
    await page.getByRole('button', { name: '← 목록' }).click();
    await list.locator('li[data-life-date="2026-10-01"] button').click();
    const [vid] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-result').click()]);
    assert.equal(vid.suggestedFilename(), 'day-01.mp4');
    await page.getByRole('button', { name: '← 목록' }).click();

    // 빈 목록·접근 만료·불러오기 오류 (응답 가로채기 — 서버 응답 모의)
    await page.route(/\/api\/records(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' }));
    await page.reload();
    await page.getByTestId('records-empty').waitFor();
    await shot(page, `${name}-empty`);
    await page.unroute(/\/api\/records(\?|$)/);
    await page.route(/\/api\/records(\?|$)/, (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"session_expired"}' }));
    await page.reload();
    await page.getByTestId('screen-access-expired').waitFor();
    await page.unroute(/\/api\/records(\?|$)/);
    await page.route(/\/api\/records(\?|$)/, (r) => r.abort('connectionfailed'));
    await page.reload();
    await page.getByTestId('screen-load-error').waitFor();
    await page.unroute(/\/api\/records(\?|$)/);
    await page.getByRole('button', { name: '다시 불러오기' }).click();
    await page.getByTestId('records-list').waitFor();
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
