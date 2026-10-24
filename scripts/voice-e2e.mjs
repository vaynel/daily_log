// TASK-73 브라우저 E2E: 가짜 마이크 스트림으로 '한 번 시작 → 무음 감지 자동 전송 → AI 음성 재생 → 재청취'를 확인한다.
// 모의 STT·Pro·TTS만 사용(외부 호출 없음). Android 실기기·실제 마이크 검증이 아니다. 필요: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!exe) throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 필요');
const { chromium } = await import('playwright-core');

const work = await mkdtemp(path.join(os.tmpdir(), 'dl-voice-browser-'));
const procs = [];
const cleanup = async () => { for (const p of procs) try { process.kill(-p.pid, "SIGKILL"); } catch { /* 이미 종료 */ } await rm(work, { recursive: true, force: true }); };

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

let nextPort = 3410 + Math.floor(Math.random() * 400);
async function server(scenario, extra = {}) {
  const port = nextPort++;
  const p = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/voice/e2e-server.testutil.ts'], {
    cwd: path.join(root, 'apps/server'), env: { ...process.env, PORT: String(port), VOICE_E2E_SCENARIO: scenario, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d)); procs.push(p);
  const t = Date.now();
  while (!p.log.includes('E2E_READY')) { if (Date.now() - t > 30000) throw new Error(`서버 시작 실패: ${p.log.slice(-300)}`); await new Promise((r) => setTimeout(r, 100)); }
  return { url: `http://127.0.0.1:${port}`, calls: async () => (await fetch(`http://127.0.0.1:${port}/e2e/calls`)).json() };
}

const launch = (file) => chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`, '--autoplay-policy=no-user-gesture-required'],
});
const waitText = (page, sel, re, ms = 20000) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source], { timeout: ms });
const Q = '?silenceMs=700&noSpeechMs=2500&minSpeechMs=300';

try {
  // 1) 순차 대화: 시작 버튼은 한 번만 누른다.
  {
    const s = await server('normal');
    const b = await launch(speech);
    const page = await (await b.newContext({ viewport: { width: 412, height: 915 } })).newPage();
    await page.goto(`${s.url}/voice-test${Q}`);
    await page.getByRole('button', { name: '대화 시작' }).click(); // 유일한 클릭
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'voice-listening.png') });
    await page.waitForFunction(() => document.querySelectorAll('#turns li').length >= 3, null, { timeout: 40000 });
    const calls = await s.calls();
    assert.ok(calls.stt >= 3 && calls.pro >= 3 && calls.tts >= 3, `STT/Pro/TTS 호출: ${JSON.stringify(calls)}`);
    assert.equal(calls.stt, calls.pro); assert.equal(calls.pro, calls.tts);
    assert.match(await page.locator('#turns li').first().textContent(), /AI: 산책은 어디에서/);
    // 재생 후 다시 듣는 상태로 돌아오는지.
    await waitText(page, '#state', /듣는 중|처리 중|AI 음성 재생 중/);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'voice-turns.png'), fullPage: true });
    await page.getByRole('button', { name: '대화 끝내기' }).click();
    await page.locator('#summary-text').waitFor({ state: 'visible' });
    const summary = await page.locator('#summary-text').textContent();
    assert.match(summary, /턴 \d+ · STT \d+ \/ Pro \d+ \/ TTS \d+ 호출 · 추정 비용 [\d.]+원/);
    await page.locator('input[name=nat][value="4"]').check();
    await page.locator('input[name=uns][value=INTERRUPT]').check();
    await page.getByRole('button', { name: '평가 저장' }).click();
    await waitText(page, '#saved', /저장했습니다/);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'voice-summary.png'), fullPage: true });
    console.log(`PASS 순차 대화 (턴 ${calls.stt}회, 클릭 1회) — ${summary.trim()}`);
    await b.close();
  }

  // 2) 무음: 외부 호출 0, 안내 표시, 턴 없음.
  {
    const s = await server('normal');
    const b = await launch(silence);
    const page = await (await b.newContext()).newPage();
    await page.goto(`${s.url}/voice-test${Q}`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /무음/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.locator('#turns li').count(), 0);
    assert.deepEqual({ ...(await s.calls()), prompts: undefined }, { stt: 0, pro: 0, tts: 0, prompts: undefined });
    console.log('PASS 무음: 안내 표시, 호출 0, 저장 0');
    await b.close();
  }

  // 3) STT 빈 결과: 안내, 답변·턴 없음, Pro/TTS 호출 0.
  {
    const s = await server('stt-empty');
    const b = await launch(speech);
    const page = await (await b.newContext()).newPage();
    await page.goto(`${s.url}/voice-test${Q}`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /알아듣지 못했습니다/);
    const c = await s.calls();
    assert.ok(c.stt >= 1); assert.equal(c.pro, 0); assert.equal(c.tts, 0);
    assert.equal(await page.locator('#turns li').count(), 0);
    console.log('PASS STT 빈 결과: 안내, Pro/TTS 0, 턴 0');
    await b.close();
  }

  // 4) 마이크 거부: 안내, 세션 미생성.
  {
    const s = await server('normal');
    const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }); // 가짜 장치·자동 허용 없음 + 거부 주입
    const ctx = await b.newContext();
    await ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    const page = await ctx.newPage();
    await page.goto(`${s.url}/voice-test`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /마이크 권한/);
    assert.equal(await page.getByRole('button', { name: '대화 시작' }).isEnabled(), true);
    assert.deepEqual({ ...(await s.calls()), prompts: undefined }, { stt: 0, pro: 0, tts: 0, prompts: undefined });
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'voice-mic-denied.png') });
    console.log('PASS 마이크 거부: 안내, 호출 0');
    await b.close();
  }

  // 5) 예산 상한: 유료 호출 전 중단 안내.
  {
    const s = await server('normal', { VOICE_E2E_BUDGET: '0.01' });
    const b = await launch(speech);
    const page = await (await b.newContext()).newPage();
    await page.goto(`${s.url}/voice-test${Q}`);
    await page.getByRole('button', { name: '대화 시작' }).click();
    await waitText(page, '#notice', /예산 상한/);
    assert.equal((await s.calls()).stt, 0);
    console.log('PASS 예산 상한: STT 호출 전 중단');
    await b.close();
  }
  console.log('voice-e2e: ALL PASS');
} finally {
  await cleanup();
}
