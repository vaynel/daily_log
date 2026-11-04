// 실제 브리핑 UI/API 회귀. 합성 입력·모의 Pro·메모리 저장소; 외부 API/운영 DB 미사용.
// npm run build 뒤 node scripts/task145-policy.mjs. 스크린샷은 E2E_SHOT_DIR에 저장.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const port = 4700 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${port}`;
const proc = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/briefing/e2e-server.testutil.ts'], {
  cwd: path.join(root, 'apps/server'), env: { ...process.env, PORT: String(port), BR_E2E_SCENARIO: 'defamation' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let log = '';
proc.stdout.on('data', (d) => { log += d; });
proc.stderr.on('data', (d) => { log += d; });
let browser;
try {
  const deadline = Date.now() + 30000;
  while (!log.includes('E2E_READY')) {
    if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`E2E startup failed: ${log.slice(-500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await page.context().addCookies([{ name: 'e2e', value: '1', url }]);
  await page.goto(url);
  await page.getByTestId('btn-briefing-start').click();
  await page.getByTestId('br-summary').waitFor();
  const technical = '쓰레기 코드를 리팩터링했다';
  const falsePositive = '멍청한 녀석이라고 쓴 테스트 문구를 읽었다';
  assert.match(await page.getByTestId('br-video').innerText(), /쓰레기 코드를/);
  const excluded = page.getByTestId('br-excluded');
  assert.match(await excluded.innerText(), /타인 비방/);
  assert.equal(await excluded.locator('li', { hasText: '여당' }).getByTestId('br-restore').count(), 0);
  await excluded.locator('li', { hasText: falsePositive }).getByTestId('br-restore').click();
  await page.getByTestId('br-video').getByText(falsePositive, { exact: false }).waitFor();
  await page.reload();
  await page.getByTestId('br-video').getByText(falsePositive, { exact: false }).waitFor();
  const state = await (await fetch(`${url}/e2e/state`)).json();
  assert.equal(state.jobs.length, 0);
  const latest = state.versions.filter((v) => v.kind === 'SUMMARY').at(-1);
  assert.deepEqual(latest.content.correction, { itemId: 's7', action: 'INCLUDE', previousExcludedReason: 'DEFAMATION' });
  assert.equal(state.proCalls, 1);
  if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOT_DIR, 'policy-ui-after.png'), fullPage: true });
  await page.getByTestId('br-confirm').click();
  await page.getByTestId('br-confirmed').waitFor();
  const confirmed = await (await fetch(`${url}/e2e/state`)).json();
  const plan = confirmed.versions.find((v) => v.kind === 'PRODUCTION_PLAN').content;
  assert.ok(plan.lines.includes(technical) && plan.lines.includes(falsePositive));
  assert.ok(!plan.lines.some((line) => line.includes('여당')));
  console.log(`PASS TASK-145 UI: technical eligible; DEFAMATION restored via button, reload and decision retained; politics blocked; confirmation plan verified. URL=${url} viewport=1280x960`);
} finally {
  if (browser) await browser.close();
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already exited */ }
}
