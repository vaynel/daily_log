// TASK-20 브라우저 E2E: 통합 브리핑 화면. 모의 Pro·메모리 저장소(외부 호출·DB 없음). 실기기·실제 Pro 검증이 아니다.
// 필요: apps/web 빌드(dist), PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. E2E_SHOT_DIR 이 있으면 화면 캡처를 저장한다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!exe) throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 필요');
const { chromium } = await import('playwright-core');

const procs = [];
const cleanup = () => { for (const p of procs) try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } };
const port = 4100 + Math.floor(Math.random() * 300);
const p = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/briefing/e2e-server.testutil.ts'], { cwd: path.join(root, 'apps/server'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d)); procs.push(p);
const url = `http://127.0.0.1:${port}`;
const state = async () => (await fetch(`${url}/e2e/state`)).json();
const shot = async (page, name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, name), fullPage: true }); };

try {
  const t0 = Date.now();
  while (!p.log.includes('E2E_READY')) { if (Date.now() - t0 > 30000) throw new Error(`서버 시작 실패: ${p.log.slice(-300)}`); await new Promise((r) => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  await ctx.addCookies([{ name: 'e2e', value: '1', url }]);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByTestId('btn-briefing-start').waitFor({ timeout: 20000 });

  // 확인 전: 브리핑 전에도 제작 작업 없음
  assert.equal((await state()).jobs.length, 0);
  await page.getByTestId('btn-briefing-start').click();
  await page.getByTestId('br-summary').waitFor();

  // AC-1: 한 화면에 하루 요약 + 영상 핵심 + 제외 목록
  const summary = await page.locator('[data-testid=br-summary] li').allTextContents();
  const video = await page.locator('[data-testid=br-video] li').allTextContents();
  assert.ok(summary.some((t) => t.includes('에코 버그')) && video.some((t) => t.includes('에코 버그')), '요약과 영상 핵심이 같은 화면');
  assert.ok(video.some((t) => t.includes('SQL 인젝션 예방')), '보안 예방 학습은 영상에 포함');
  const excluded = (await page.getByTestId('br-excluded').textContent()) ?? '';
  assert.match(excluded, /확실하지 않은 내용/); assert.match(excluded, /정치 관련/);
  assert.ok(!video.join(' ').includes('여당'), '정치 문장은 영상에서 빠짐');
  await shot(page, 'br-briefing.png');
  console.log('PASS AC-1/4/5 화면: 요약·영상 핵심·제외 사유가 한 단계에 표시, 불확실·정치 제외, 보안 학습 포함');

  // AC-2: 정정·재조회 후에도 제작 작업 없음 / AC-3: 정정은 해당 항목만
  assert.equal((await state()).jobs.length, 0);
  await page.locator('[data-testid=br-video] li', { hasText: '뿌듯했다' }).getByTestId('br-fix').click();
  await page.getByTestId('br-edit').fill('꽤 뿌듯했다');
  await page.getByTestId('br-edit-save').click();
  await page.getByTestId('br-change').waitFor();
  const change = await page.getByTestId('br-change').textContent();
  assert.match(change, /나머지는 그대로/); assert.ok(!change.includes('에코 버그'), '정정 안내가 전체 브리핑을 반복하지 않음');
  const video2 = await page.locator('[data-testid=br-video] li').allTextContents();
  assert.ok(video2.some((t) => t.includes('꽤 뿌듯했다')) && video2.some((t) => t.includes('에코 버그')));
  const st1 = await state();
  assert.equal(st1.proCalls, 1, '정정이 Pro 를 다시 부르지 않음');
  assert.equal(st1.jobs.length, 0, '확인 전 제작 작업 없음');
  assert.equal(st1.status, 'IN_PROGRESS');
  await shot(page, 'br-corrected.png');
  console.log('PASS AC-2/3 화면: 정정은 해당 항목만, Pro 재호출 0, 확인 전 작업 0건');

  // 확인 → 작업 1건
  await page.getByTestId('br-confirm').click();
  await page.getByTestId('br-confirmed').waitFor();
  const st2 = await state();
  assert.equal(st2.jobs.length, 1); assert.equal(st2.status, 'CONFIRMED'); assert.equal(st2.production, 'QUEUED');
  const plan = st2.versions.find((v) => v.kind === 'PRODUCTION_PLAN').content;
  assert.ok(plan.lines.includes('꽤 뿌듯했다') && !plan.lines.join(' ').includes('캐시 같기도') && !plan.lines.join(' ').includes('여당'));
  assert.equal(await page.getByTestId('br-confirm').count(), 0);
  await shot(page, 'br-confirmed.png');
  console.log('PASS AC-2 화면: 확인 후에만 제작 작업 1건 생성, 계획에 불확실·정치 문장 없음');
  await browser.close();
  console.log('briefing-e2e: ALL PASS');
} finally {
  cleanup();
}
