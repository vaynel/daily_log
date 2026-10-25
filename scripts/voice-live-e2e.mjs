// TASK-75 브라우저 E2E: 가짜 마이크 스트림으로 '버튼 한 번 → 연속 대화 → 턴별 지연 표시'를 확인한다.
// 모의 Live 서버만 사용(외부 호출·실제 키 없음). Android 실기기·실제 마이크 검증이 아니다. 필요: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!exe) throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 필요');
const { chromium } = await import('playwright-core');

const work = await mkdtemp(path.join(os.tmpdir(), 'dl-live-browser-'));
const procs = [];
const cleanup = async () => { for (const p of procs) try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } await rm(work, { recursive: true, force: true }); };

// 16bit mono 16kHz WAV: 말소리 대용 톤 1.2초 + 무음 3.0초 (가짜 마이크가 반복 재생한다). silent=true 면 전부 무음.
function wav({ silent }) {
  const rate = 16000, secs = 4.2, n = Math.round(rate * secs), pcm = Buffer.alloc(n * 2);
  if (!silent) for (let i = 0; i < Math.round(rate * 1.2); i++) pcm.writeInt16LE(Math.round(9000 * (Math.sin(i * 0.11) + 0.5 * Math.sin(i * 0.27)) / 1.5), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const speech = path.join(work, 'speech.wav'); await writeFile(speech, wav({ silent: false }));
const silence = path.join(work, 'silence.wav'); await writeFile(silence, wav({ silent: true }));

let nextPort = 3810 + Math.floor(Math.random() * 300);
async function server(scenario, extra = {}) {
  const port = nextPort++;
  const p = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/voice/live-e2e-server.testutil.ts'], {
    cwd: path.join(root, 'apps/server'), env: { ...process.env, PORT: String(port), LIVE_E2E_SCENARIO: scenario, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d)); procs.push(p);
  const t = Date.now();
  while (!p.log.includes('E2E_READY')) { if (Date.now() - t > 30000) throw new Error(`서버 시작 실패: ${p.log.slice(-300)}`); await new Promise((r) => setTimeout(r, 100)); }
  const get = async (u) => (await fetch(`http://127.0.0.1:${port}${u}`)).json();
  return { url: `http://127.0.0.1:${port}`, mock: () => get('/e2e/mock'), info: () => get('/e2e/session-dir') };
}

const launch = (file) => chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`, '--autoplay-policy=no-user-gesture-required'],
});
const waitText = (page, sel, re, ms = 20000) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source], { timeout: ms });

try {
  // 1) 연속 대화: 시작 버튼은 한 번만 누른다. 턴별 지연이 화면과 세션 기록에 남는다.
  {
    const s = await server('normal');
    const b = await launch(speech);
    const page = await (await b.newContext({ viewport: { width: 412, height: 915 } })).newPage();
    const wsFrames = [];
    page.on('websocket', (ws) => ws.on('framereceived', (f) => { if (typeof f.payload === 'string') wsFrames.push(f.payload); }));
    await page.goto(`${s.url}/voice-live`);
    await page.getByRole('button', { name: '대화 시작' }).click(); // 유일한 클릭
    await waitText(page, '#state', /듣는 중|AI가 말하는 중/);
    await page.waitForFunction(() => document.querySelectorAll('#turns li').length >= 3, null, { timeout: 40000 });
    const items = await page.locator('#turns li').allTextContents();
    for (const t of items.slice(0, 3)) assert.match(t, /말 끝→첫 음성 \d+ms/, t);
    assert.match(items[0], /서버 추가 \d+ms/);
    await waitText(page, '#turns li:first-child .turn-meta', /입력 \d+토큰/);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'live-conversation.png'), fullPage: true });
    const mock = await s.mock();
    assert.ok(mock.turnsAnswered >= 3, `모의 Live 응답 턴: ${mock.turnsAnswered}`);
    assert.equal(mock.connections, 1, '버튼 없이 한 연결에서 이어져야 함');
    assert.deepEqual(mock.keysSeen, [(await s.info()).key]);
    await page.getByRole('button', { name: '대화 끝내기' }).click();
    await page.locator('#summary-text').waitFor({ state: 'visible' });
    const summary = await page.locator('#summary-text').textContent();
    assert.match(summary, /턴 \d+ · 평균 지연 \d+ms · 최대 \d+ms/);
    // 세션 기록(JSON)에 턴별 지연, 페이지·이벤트에는 키 없음.
    const { sessionDir, key } = await s.info();
    const files = (await readdir(sessionDir)).filter((f) => f.startsWith('live-') && f.endsWith('.json'));
    assert.equal(files.length, 1);
    const rec = JSON.parse(await readFile(path.join(sessionDir, files[0]), 'utf8'));
    assert.ok(rec.turns.length >= 3);
    for (const t of rec.turns) assert.equal(typeof t.latencyMs, 'number');
    assert.ok(!(await page.content()).includes(key));
    assert.ok(!wsFrames.join('').includes(key));
    console.log(`PASS 연속 대화 (턴 ${rec.turns.length}회, 클릭 1회, 지연 ${rec.turns.map((t) => t.latencyMs).join('/')}ms) — ${summary.trim()}`);
    await b.close();
  }

  // 2) 무음: 업스트림 오디오 0, 안내 표시, 턴 없음.
  {
    const s = await server('normal');
    const b = await launch(silence);
    const page = await (await b.newContext()).newPage();
    await page.goto(`${s.url}/voice-live?noSpeechMs=1500`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /무음/);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await page.locator('#turns li').count(), 0);
    assert.equal((await s.mock()).audioMsgs, 0);
    console.log('PASS 무음: 안내 표시, 업스트림 오디오 0, 턴 0');
    await b.close();
  }

  // 3) 마이크 거부: 안내, 연결 미생성.
  {
    const s = await server('normal');
    const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const ctx = await b.newContext();
    await ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    const page = await ctx.newPage();
    await page.goto(`${s.url}/voice-live`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /마이크 권한/);
    assert.equal(await page.getByRole('button', { name: '대화 시작' }).isEnabled(), true);
    assert.equal((await s.mock()).connections, 0);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'live-mic-denied.png') });
    console.log('PASS 마이크 거부: 안내, 업스트림 연결 0');
    await b.close();
  }

  // 4) 키 거부(업스트림 401)와 설정 없음: fail closed 안내.
  for (const [scenario, re] of [['bad-key', /키를 거부/], ['disabled', /설정되지 않았/]]) {
    const s = await server(scenario);
    const b = await launch(speech);
    const page = await (await b.newContext()).newPage();
    await page.goto(`${s.url}/voice-live`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', re);
    await waitText(page, '#state', /중단됨/);
    assert.equal(await page.getByRole('button', { name: '대화 시작' }).isEnabled(), true);
    assert.equal(await page.locator('#turns li').count(), 0);
    console.log(`PASS ${scenario}: 안내 표시, 턴 0`);
    await b.close();
  }

  // 5) 예산 소진: 시작하지 않고 안내.
  {
    const s = await server('normal', { LIVE_E2E_BUDGET: '0.5' });
    const b = await launch(speech);
    const page = await (await b.newContext()).newPage();
    await page.goto(`${s.url}/voice-live`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /예산 상한/);
    assert.equal((await s.mock()).connections, 0);
    console.log('PASS 예산 상한: 업스트림 연결 전 중단');
    await b.close();
  }
  console.log('voice-live-e2e: ALL PASS');
} finally {
  await cleanup();
}
