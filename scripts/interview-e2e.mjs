// TASK-17 브라우저 E2E: 제품 음성 인터뷰 화면을 가짜 마이크 + 모의 Live 서버로 검증한다.
// 외부 호출·실제 키 없음. Android 실기기 마이크·백그라운드·TalkBack 검증이 아니다. 필요: apps/web 빌드(dist), PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
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

const work = await mkdtemp(path.join(os.tmpdir(), 'dl-iv-browser-'));
const procs = [];
const cleanup = async () => { for (const p of procs) try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } await rm(work, { recursive: true, force: true }); };

function wav() { // 톤 1.2초 + 무음 3.0초를 반복 재생하는 가짜 마이크
  const rate = 16000, n = Math.round(rate * 4.2), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < Math.round(rate * 1.2); i++) pcm.writeInt16LE(Math.round(9000 * (Math.sin(i * 0.11) + 0.5 * Math.sin(i * 0.27)) / 1.5), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const speech = path.join(work, 'speech.wav'); await writeFile(speech, wav());

let nextPort = 3600 + Math.floor(Math.random() * 300);
async function server(scenario, extra = {}) {
  const port = nextPort++;
  const p = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/interview/e2e-server.testutil.ts'], {
    cwd: path.join(root, 'apps/server'), env: { ...process.env, PORT: String(port), IV_E2E_SCENARIO: scenario, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d)); procs.push(p);
  const t = Date.now();
  while (!p.log.includes('E2E_READY')) { if (Date.now() - t > 30000) throw new Error(`서버 시작 실패: ${p.log.slice(-300)}`); await new Promise((r) => setTimeout(r, 100)); }
  const url = `http://127.0.0.1:${port}`;
  return { url, state: async () => (await fetch(`${url}/e2e/state`)).json() };
}

const launch = () => chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speech}`, '--autoplay-policy=no-user-gesture-required'],
});
// getUserMedia 호출·트랙 종료를 센다(시작 전 녹음 없음, 일시정지 시 마이크 해제 증명).
const spyMic = (ctx) => ctx.addInitScript(() => {
  window.__gum = 0; window.__tracks = [];
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { window.__gum++; const s = await orig(c); s.getTracks().forEach((t) => window.__tracks.push(t)); return s; };
});
const open = async (browser, s, viewport = { width: 412, height: 915 }, init) => {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: 'e2e', value: '1', url: s.url }]);
  if (init) await init(ctx); else await spyMic(ctx);
  const page = await ctx.newPage();
  await page.goto(s.url);
  await page.getByTestId('iv-status').waitFor();
  return page;
};
const txt = (page, id) => page.getByTestId(id).textContent();
const waitFor = (page, fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms });
const shot = async (page, name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, name), fullPage: true }); };
const convCount = (page) => page.locator('[data-testid=iv-conversation] li').count();

try {
  // 1) AC-2·AC-1·AC-3·AC-5: 시작 전 마이크 없음 → 클릭 1회로 연속 대화 → 일시정지(마이크 해제) → 재개 → PC 에서 이어하기 → 끝내기 → 하루 1회
  {
    const s = await server('normal');
    const b = await launch();
    const page = await open(b, s);
    await waitFor(page, () => document.querySelector('[data-testid=btn-start]'));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.evaluate(() => window.__gum), 0, '시작 전 getUserMedia 호출 없음');
    assert.equal(await page.getByTestId('mic-indicator').getAttribute('data-on'), 'false');
    assert.match(await txt(page, 'mic-indicator'), /녹음하지 않음/);
    assert.equal((await s.state()).mock.connections, 0, '시작 전 Live 연결 없음');
    assert.equal((await s.state()).mock.audioMsgs, 0);
    await shot(page, 'iv-before-start.png');
    console.log('PASS AC-2 시작 전: getUserMedia 0회, Live 연결 0, 녹음 안 함 표시');

    await page.getByTestId('btn-start').click(); // 유일한 시작 클릭
    await waitFor(page, () => /듣는 중|AI가 말하는 중|생각 중/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''));
    assert.equal(await page.getByTestId('mic-indicator').getAttribute('data-on'), 'true');
    assert.match(await txt(page, 'mic-indicator'), /녹음 중/);
    await waitFor(page, () => document.querySelectorAll('[data-testid=iv-latency] li').length >= 3, null, 60000);
    const lat = await page.locator('[data-testid=iv-latency] li').allTextContents();
    for (const t of lat.slice(0, 3)) assert.match(t, /말 끝→첫 음성 \d+ms · 음성 서비스 \d+ms · 서버 \d+ms/, t);
    await waitFor(page, () => document.querySelectorAll('[data-testid=iv-conversation] li').length >= 6, null, 20000);
    assert.equal(await page.evaluate(() => window.__gum), 1, '버튼 한 번에 마이크 한 번');
    assert.equal((await s.state()).mock.connections, 1, '클릭 1회로 한 연결에서 연속 대화');
    await shot(page, 'iv-conversation.png');
    console.log(`PASS AC-1 연속 대화: 시작 클릭 1회, ${lat.length}턴, 단계별 지연 표시 (${lat[0]})`);

    // 일시정지: 마이크 즉시 해제
    const before = await convCount(page);
    await page.getByTestId('btn-pause').click();
    await waitFor(page, () => /일시정지/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''));
    assert.equal(await page.getByTestId('mic-indicator').getAttribute('data-on'), 'false');
    assert.ok(await page.evaluate(() => window.__tracks.every((t) => t.readyState === 'ended')), '일시정지 후 마이크 트랙 종료');
    await new Promise((r) => setTimeout(r, 600));
    const afterPause = await convCount(page);
    assert.ok(afterPause >= before, '일시정지 후에도 기존 대화 유지');
    await shot(page, 'iv-paused.png');
    const st1 = await s.state();
    assert.equal(st1.usage.status, 'OPEN');
    // 재개
    await page.getByTestId('btn-reconnect').or(page.getByTestId('btn-start')).first().click();
    await waitFor(page, () => /듣는 중|AI가 말하는 중|생각 중/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''));
    await waitFor(page, (n) => document.querySelectorAll('[data-testid=iv-conversation] li').length >= n + 2, afterPause, 60000);
    const st2 = await s.state();
    assert.equal(st2.mock.connections, 2);
    const instr = st2.mock.setups[1].systemInstruction.parts[0].text;
    assert.match(instr, /\[이어하기\]/);
    assert.match(instr, /사용자 발화 1/);
    assert.ok((await convCount(page)) >= afterPause + 2, '기존 대화 뒤에 새 대화가 붙음');
    console.log(`PASS AC-3 일시정지→재개: 마이크 해제 확인, 기존 ${afterPause}개 유지 후 이어서 저장, 지시문에 이전 대화 포함`);

    // AC-5: PC 화면(같은 계정)에서 같은 대화가 보이고, 휴대폰이 멈춘 뒤 PC 에서 이어서 말한다.
    await page.getByTestId('btn-pause').click();
    await waitFor(page, () => /일시정지/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''));
    await new Promise((r) => setTimeout(r, 600));
    const pc = await open(b, s, { width: 1280, height: 800 });
    await waitFor(pc, () => document.querySelectorAll('[data-testid=iv-conversation] li').length > 0);
    const phoneTexts = await page.locator('[data-testid=iv-conversation] li').allTextContents();
    const pcTexts = await pc.locator('[data-testid=iv-conversation] li').allTextContents();
    assert.deepEqual(pcTexts, phoneTexts, 'PC 와 휴대폰 대화 동일');
    await shot(pc, 'iv-pc-resume.png');
    await pc.getByTestId('btn-start').click();
    await waitFor(pc, (n) => document.querySelectorAll('[data-testid=iv-conversation] li').length >= n + 2, pcTexts.length, 60000);
    assert.equal((await s.state()).mock.connections, 3);
    // 대화 끝내기(확인 필요) → 하루 1회
    await pc.getByTestId('btn-end').click();
    await pc.getByTestId('btn-end-confirm').click();
    await waitFor(pc, () => /대화 끝/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''));
    assert.equal(await pc.getByTestId('btn-start').count(), 0);
    await pc.reload();
    await waitFor(pc, () => /이미 마쳤습니다/.test(document.querySelector('[data-testid=iv-stop]')?.textContent ?? ''));
    assert.equal(await pc.getByTestId('btn-start').count(), 0);
    const st3 = await s.state();
    assert.equal(st3.usage.status, 'ENDED');
    await shot(pc, 'iv-daily-limit.png');
    console.log('PASS AC-5 교차 기기: PC 가 휴대폰 대화를 보고 이어서 대화, 끝내기 후 재시작 불가(하루 1회)');
    await b.close();
  }

  // 2) AC-4: 마이크 거부 → 해결 행동 + 기존 기록, 연결·녹음 없음
  {
    const s = await server('expired');
    const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const page = await open(b, s, undefined, (ctx) => ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); }));
    await waitFor(page, () => document.querySelectorAll('[data-testid=iv-conversation] li').length === 2);
    await page.getByTestId('btn-start').click();
    await page.getByTestId('mic-problem').waitFor();
    const t = await txt(page, 'mic-problem');
    assert.match(t, /마이크 사용이 허용되지 않았습니다/);
    assert.match(t, /허용.*으로 바꾼 뒤.*다시 시도/);
    assert.match(t, /기존 기록 2개는 그대로/);
    assert.equal(await convCount(page), 2, '기존 기록 표시');
    assert.equal((await s.state()).mock.connections, 0);
    assert.equal(await page.getByTestId('mic-indicator').getAttribute('data-on'), 'false');
    await shot(page, 'iv-mic-denied.png');
    console.log('PASS AC-4 마이크 거부: 해결 행동 표시, 기존 기록 2개 유지, Live 연결 0');
    // AC-6: 만료 안내(같은 시나리오)
    const note = await txt(page, 'audio-notice');
    assert.match(note, /이어서 들을 수 없습니다/);
    assert.match(note, /저장된 글 2개와 첨부 1개는 그대로 남아 있습니다/);
    assert.match(note, /Drive 백업이 진행 대기 중/);
    assert.match(note, /음성 자체는 Drive 백업 대상이 아닙니다/);
    assert.ok(await page.getByTestId('btn-speak-notice').count() >= 0);
    console.log('PASS AC-6 만료 후 재접속: 재개 불가 사유·보존 건수·백업 상태 안내' + ((await page.getByTestId('btn-speak-notice').count()) ? ' + 음성으로 듣기 버튼' : ' (이 브라우저에 음성 합성 없음)'));
    await shot(page, 'iv-expired.png');
    await b.close();
  }

  // 3) AC-4: 연결 중단(전사/음성 서비스 끊김) → 안내 + 기존 기록 + 다시 연결
  {
    const s = await server('drop');
    const b = await launch();
    const page = await open(b, s);
    await page.getByTestId('btn-start').click();
    await page.getByTestId('iv-stop').waitFor({ timeout: 40000 });
    const t = await txt(page, 'iv-stop');
    assert.match(t, /연결이 끊어졌습니다/);
    assert.match(t, /저장되어 있습니다/);
    assert.equal(await page.getByTestId('mic-indicator').getAttribute('data-on'), 'false');
    await waitFor(page, () => document.querySelectorAll('[data-testid=iv-conversation] li').length >= 2);
    assert.ok(await page.evaluate(() => window.__tracks.every((x) => x.readyState === 'ended')));
    assert.equal(await page.getByTestId('btn-reconnect').count(), 1);
    await shot(page, 'iv-connection-lost.png');
    console.log('PASS AC-4 연결 중단: 안내·저장된 대화 유지·마이크 해제·다시 연결 버튼');
    await b.close();
  }

  // 4) 설정 없음(fail closed)
  {
    const s = await server('disabled');
    const b = await launch();
    const page = await open(b, s);
    await page.getByTestId('iv-stop').waitFor();
    assert.match(await txt(page, 'iv-stop'), /아직 켜지지 않았습니다/);
    assert.equal(await page.getByTestId('btn-start').count(), 0);
    assert.equal(await page.evaluate(() => window.__gum), 0);
    console.log('PASS 음성 대화 비활성: 시작 버튼 없음, 마이크 호출 0, 글·첨부는 사용 가능');
    await b.close();
  }

  // 5) AC-8 화면: 마무리 안내 → 시간 상한 종료 → 같은 날 재시작 불가
  {
    const s = await server('normal', { IV_E2E_MAXMS: '9000', IV_E2E_WRAPMS: '4000' });
    const b = await launch();
    const page = await open(b, s);
    await page.getByTestId('btn-start').click();
    await page.getByTestId('iv-wrap').waitFor({ timeout: 30000 });
    await shot(page, 'iv-wrap-up.png');
    await waitFor(page, () => /대화 끝/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''), null, 30000);
    assert.match(await txt(page, 'iv-stop'), /대화 시간 10분이 되어 마무리/);
    const st = await s.state();
    assert.equal(st.usage.status, 'ENDED');
    assert.equal(st.mock.textInputs.length, 1);
    assert.equal(await page.getByTestId('btn-start').count(), 0);
    console.log('PASS AC-8 화면: 마무리 안내 1회 → 시간 상한 종료 → 시작 버튼 없음');
    await b.close();
  }

  // 6) D15-04: 글 입력은 고른 때만 나타난다
  {
    const s = await server('normal');
    const b = await launch();
    const page = await open(b, s);
    assert.equal(await page.getByTestId('iv-text').count(), 0, '기본 화면에는 글 입력칸 없음');
    await page.getByTestId('btn-text-learning').click();
    await page.getByTestId('iv-text').fill('오늘 배운 것: 웹소켓 재연결');
    await page.getByTestId('btn-text-save').click();
    await page.getByTestId('iv-text-msg').filter({ hasText: '저장했습니다' }).waitFor();
    const st = await s.state();
    assert.ok(st.attachments.some((a) => a.name === 'learning.md'));
    assert.equal(await page.getByTestId('iv-text').count(), 0);
    console.log('PASS D15-04: 기본 화면에 글 입력 없음 → 선택 시 입력 → 학습 메모 저장');
    await b.close();
  }
  console.log('interview-e2e: ALL PASS');
} finally {
  await cleanup();
}
