import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildVoiceApp } from './app.js';
import { INSTRUCTION } from './pipeline.js';
import { loadLiveConfig, type LiveConfig } from './live.js';
import { startMockLive, type MockLiveOptions } from './live-mock.testutil.js';
import type pg from 'pg';
import { MonthlyLedger, HARD_MONTHLY_LIMIT_KRW } from '../budget/ledger.js';
import { createTempSchema } from '../records/db.testutil.js';
import { mockTransports } from './mock.testutil.js';
import { loadVoiceKeys, VoiceConfigError } from './keys.js';

const KEY = 'live-sentinel-key-do-not-leak-7731';
const RATE = 16000;
type Ev = Record<string, unknown> & { type: string };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function rig(o: { mock?: Partial<MockLiveOptions>; env?: Record<string, string>; budgetKrw?: number; disabled?: boolean; key?: string; monthly?: MonthlyLedger } = {}) {
  const mock = await startMockLive({ expectedKey: KEY, vadSilenceMs: 250, firstAudioDelayMs: 40, audioChunks: 4, ...o.mock });
  cleanups.push(() => mock.close());
  const logs: string[] = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-live-'));
  const config: LiveConfig = loadLiveConfig(o.key ?? KEY, { DAILY_LOG_VOICE_LIVE_URL: mock.url, ...o.env });
  const app = buildVoiceApp({
    transports: mockTransports().t, sessionDir: dir, budgetKrw: o.budgetKrw ?? 1000, monthly: o.monthly, live: o.disabled ? null : config,
    logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } }) },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const addr = app.server.address() as { port: number };
  const base = `127.0.0.1:${addr.port}`;
  return { mock, app, dir, logs, base, config };
}

class Browser {
  events: Ev[] = [];
  audioBytes = 0;
  audioChunks = 0;
  closed = false;
  ws: WebSocket;
  constructor(base: string, query = '', headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`ws://${base}/voice-live/ws${query}`, { headers });
    this.ws.on('message', (d, bin) => {
      if (bin) { this.audioBytes += (d as Buffer).length; this.audioChunks++; return; }
      this.events.push(JSON.parse(d.toString()) as Ev);
    });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', () => { /* 거부 시험에서 사용 */ });
    cleanups.push(() => this.ws.terminate());
  }
  async wait<T extends Ev = Ev>(type: string, pred: (e: Ev) => boolean = () => true, ms = 8000, from = 0): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const e = this.events.slice(from).find((x) => x.type === type && pred(x));
      if (e) return e as T;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting ${type}; got ${this.events.map((x) => x.type).join(',')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  tone(ms: number, paceMs = 40) { return this.feed(ms, paceMs, true); }
  silence(ms: number, paceMs = 40) { return this.feed(ms, paceMs, false); }
  async feed(ms: number, paceMs: number, tone: boolean) {
    const frames = Math.round(ms / 40);
    for (let f = 0; f < frames; f++) {
      const b = Buffer.alloc(640 * 2);
      if (tone) for (let i = 0; i < 640; i++) b.writeInt16LE(Math.round(9000 * Math.sin((f * 640 + i) * 0.11)), i * 2);
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b);
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }
  /** 한 번 말하기(실시간 속도 또는 빠르게). */
  async say(speechMs = 600, paceMs = 40) { await this.tone(speechMs, paceMs); await this.silence(400, paceMs); }
}

const turns = (b: Browser) => b.events.filter((e) => e.type === 'turn');

describe('AC-1/2 브라우저↔서버↔Live 중계와 지연 계측', () => {
  it('실시간 속도로 연속 3턴이 이어지고 말 끝→첫 음성 지연·서버 추가 지연(≤200ms)이 남는다', async () => {
    const r = await rig();
    const b = new Browser(r.base);
    const ready = await b.wait('ready');
    expect(ready).toMatchObject({ inputRate: RATE, outputRate: 24000 });
    expect(JSON.stringify(ready)).not.toContain(KEY);
    for (let i = 1; i <= 3; i++) {
      await b.say();
      await b.wait('turn', (e) => e.n === i);
    }
    const ts = turns(b);
    expect(ts).toHaveLength(3);
    expect(b.audioChunks).toBeGreaterThanOrEqual(12);
    for (const t of ts) {
      expect(t.serverOverheadMs).toBeLessThanOrEqual(200); // AC-1
      // 모의 Live 의 무음 감지 250ms + 모델 지연 40ms + 서버 추가 지연 안에 있다.
      expect(t.latencyMs as number).toBeGreaterThanOrEqual(250);
      expect(t.latencyMs as number).toBeLessThan(900);
      expect(t.upstreamLatencyMs as number).toBeLessThanOrEqual(t.latencyMs as number);
      expect(t.userText).toMatch(/사용자 발화/);
      expect(t.replyText).toMatch(/네,/);
    }
    // 첫 오디오 이벤트가 turn 보다 먼저 나갔다.
    expect(b.events.filter((e) => e.type === 'first_audio')).toHaveLength(3);
    console.info('[AC-1] latencyMs', ts.map((t) => t.latencyMs), 'serverOverheadMs', ts.map((t) => t.serverOverheadMs));
    // Live 초기 설정: 재사용한 지시문, 오디오 응답, 전사, 압축.
    const setup = r.mock.state.setups[0]!;
    expect(r.mock.state.setups).toHaveLength(1);
    expect((setup.systemInstruction as { parts: { text: string }[] }).parts[0]!.text).toBe(INSTRUCTION);
    expect(setup).toMatchObject({ inputAudioTranscription: {}, outputAudioTranscription: {}, generationConfig: { responseModalities: ['AUDIO'] } });
    expect(setup.contextWindowCompression).toMatchObject({ slidingWindow: { targetTokens: 4000 } });
    // 버튼 없이 한 연결에서 이어졌다.
    expect(r.mock.state.connections).toBe(1);
    // 세션 기록(0600)에 턴별 지연이 있고 계측 로그에는 숫자만 있다.
    b.ws.send(JSON.stringify({ type: 'end' }));
    const stopped = await b.wait('stopped');
    const f = path.join(r.dir, `live-${ready.sessionId}.json`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    expect(rec.turns).toHaveLength(3);
    expect(rec.turns[0]).toMatchObject({ latencyMs: expect.any(Number), serverOverheadMs: expect.any(Number), inputTokens: expect.any(Number), outputTokens: 200 });
    expect(rec.turns[0].userText).toMatch(/사용자 발화/); // 전사는 세션 파일에만
    expect(rec.estimatedCostKrw).toBeGreaterThan(0);
    expect(rec.endedAt).not.toBeNull();
    expect(JSON.stringify(stopped.summary)).not.toMatch(/사용자 발화/); // 화면 요약·API 에는 전사 없음
    const api = await r.app.inject({ url: `/voice-live/api/sessions/${ready.sessionId}` });
    expect(api.json().turns[0]).toMatchObject({ latencyMs: expect.any(Number) });
    expect(api.body).not.toMatch(/사용자 발화/);
    const logText = r.logs.join('');
    expect(logText).toContain('"msg":"live turn"');
    expect(logText).not.toMatch(/사용자 발화|네, \d번째/);
  }, 30000);

  it('AI가 말하는 중 사용자가 말하면 끼어들기 이벤트가 오고 기록된다', async () => {
    const r = await rig({ mock: { audioChunks: 40, chunkIntervalMs: 20, firstAudioDelayMs: 20 } });
    const b = new Browser(r.base);
    const { sessionId } = await b.wait('ready');
    await b.tone(600); await b.silence(120);
    await b.wait('first_audio');
    await b.tone(600, 20); // 응답 도중 다시 말한다
    await b.wait('interrupted');
    await b.silence(400);
    await b.wait('turn', (e) => e.n === 2, 8000);
    b.ws.send(JSON.stringify({ type: 'end' }));
    await b.wait('stopped');
    const rec = JSON.parse(readFileSync(path.join(r.dir, `live-${sessionId}.json`), 'utf8'));
    expect(rec.interrupts).toBe(1);
    expect(rec.turns[0].interrupted).toBe(true);
    expect(r.mock.state.interrupts).toBe(1);
  }, 30000);
});

describe('AC-3 키·예산·fail closed', () => {
  it('키는 업스트림 헤더로만 가고 브라우저 메시지·페이지·로그·세션 파일 어디에도 없다', async () => {
    const r = await rig();
    const b = new Browser(r.base);
    const { sessionId } = await b.wait('ready');
    await b.say(600, 10);
    await b.wait('turn');
    b.ws.send(JSON.stringify({ type: 'end' }));
    await b.wait('stopped');
    expect(r.mock.state.keysSeen).toEqual([KEY]);
    expect(JSON.stringify(r.mock.state.setups)).not.toContain(KEY);
    expect(JSON.stringify(b.events)).not.toContain(KEY);
    const page = await r.app.inject({ url: '/voice-live' });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(KEY);
    expect(page.body).not.toMatch(/x-goog-api-key|generativelanguage|apiKey/i);
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await r.app.inject({ url: '/healthz' })).body).not.toContain(KEY);
    expect(r.logs.join('')).not.toContain(KEY);
    for (const f of readdirSync(r.dir)) expect(readFileSync(path.join(r.dir, f), 'utf8')).not.toContain(KEY);
    void sessionId;
  }, 20000);

  it('업스트림이 키를 거부하면 LIVE_AUTH 로 끝나고 키를 노출하지 않으며 재시도도 하지 않는다', async () => {
    const r = await rig({ key: 'wrong-key-value-0001' });
    const b = new Browser(r.base);
    const s = await b.wait('stopped');
    expect(s).toMatchObject({ reason: 'LIVE_AUTH' });
    expect(JSON.stringify(b.events)).not.toContain('wrong-key-value-0001');
    await new Promise((x) => setTimeout(x, 200));
    expect(r.mock.state.keysSeen).toHaveLength(1);
    expect(r.mock.state.audioMsgs).toBe(0);
    expect(r.logs.join('')).not.toContain('wrong-key-value-0001');
  });

  it('설정(키)이 없으면 LIVE_DISABLED 로 거부하고 업스트림에 연결하지 않는다', async () => {
    const r = await rig({ disabled: true });
    const b = new Browser(r.base);
    expect(await b.wait('stopped')).toMatchObject({ reason: 'LIVE_DISABLED' });
    expect(r.mock.state.connections).toBe(0);
  });

  it('Gemini 키 파일 권한·누락 문제는 시작 전에 거부된다(기존 fail closed 재사용)', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'dl-key-'));
    const f = path.join(d, 'g.key');
    writeFileSync(f, KEY); chmodSync(f, 0o644);
    const ok = path.join(d, 'o.key'); writeFileSync(ok, 'x'); chmodSync(ok, 0o600);
    let err: unknown;
    try { loadVoiceKeys({ DAILY_LOG_OPENAI_KEY_FILE: ok, DAILY_LOG_GEMINI_KEY_FILE: f }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(VoiceConfigError);
    expect((err as Error).message).toContain('MODE_NOT_0600');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('예산 소진 상태에서는 세션을 시작하지 않는다(업스트림 연결 0)', async () => {
    const r = await rig({ budgetKrw: 0.5 });
    const b = new Browser(r.base);
    expect(await b.wait('stopped')).toMatchObject({ reason: 'BUDGET' });
    expect(r.mock.state.connections).toBe(0);
  });

  it('한 턴으로 예산을 다 쓰면 그 턴 뒤 즉시 종료한다', async () => {
    // 사전 추정(출력 400토큰)보다 실제 출력이 훨씬 커서 한 턴에 상한을 넘는 경우.
    const r = await rig({ budgetKrw: 100, mock: { outputTokens: 20000 } });
    const b = new Browser(r.base);
    await b.wait('ready');
    await b.say(600, 10);
    expect(await b.wait('stopped')).toMatchObject({ reason: 'BUDGET' });
    expect(turns(b)).toHaveLength(1);
  }, 20000);

  it('다음 턴의 예상 비용이 남은 예산을 넘으면 새 턴 음성을 업스트림에 보내기 전에 중단한다', async () => {
    // 기본 단가: 1턴 약 8.4원, 다음 턴 예상 약 12원, 예산 20원.
    const r = await rig({ budgetKrw: 20 });
    const b = new Browser(r.base);
    await b.wait('ready');
    await b.say(600, 10);
    await b.wait('turn');
    await b.silence(1700, 5); // 무음 꼬리를 지나 유휴 상태로
    const before = r.mock.state.audioMsgs;
    await b.tone(600, 5);
    const s = await b.wait('stopped');
    expect(s).toMatchObject({ reason: 'BUDGET' });
    expect(r.mock.state.audioMsgs).toBe(before);
    expect(turns(b)).toHaveLength(1);
  }, 20000);

  it('다른 출처 페이지의 WebSocket 연결은 403, 동시에 두 번째 세션은 BUSY', async () => {
    const r = await rig();
    const evil = new WebSocket(`ws://${r.base}/voice-live/ws`, { headers: { Origin: 'http://evil.example' } });
    const status = await new Promise<number>((res) => { evil.on('unexpected-response', (_q, p) => res(p.statusCode ?? 0)); evil.on('error', () => {}); });
    expect(status).toBe(403);
    expect(r.mock.state.connections).toBe(0);
    const a = new Browser(r.base, '', { Origin: `http://${r.base}` });
    await a.wait('ready');
    const c = new Browser(r.base);
    expect(await c.wait('stopped')).toMatchObject({ reason: 'BUSY' });
    expect(r.mock.state.connections).toBe(1);
  });

  it('업스트림 연결이 중간에 끊기면 LIVE_CLOSED 로 끝나고 자동 재연결하지 않는다', async () => {
    const r = await rig({ mock: { dropAfterTurns: 1 } });
    const b = new Browser(r.base);
    await b.wait('ready');
    await b.say(600, 10);
    expect(await b.wait('stopped')).toMatchObject({ reason: 'LIVE_CLOSED' });
    await new Promise((x) => setTimeout(x, 200));
    expect(r.mock.state.connections).toBe(1);
  }, 20000);
});

describe('AC-5 마이크·무음·짧은 소리', () => {
  it('짧은 소리(<0.3초)는 업스트림에 보내지 않고 응답·저장 없이 안내한다', async () => {
    const r = await rig();
    const b = new Browser(r.base);
    const { sessionId } = await b.wait('ready');
    await b.tone(120, 5);
    await b.silence(800, 5);
    expect(await b.wait('notice')).toMatchObject({ code: 'TOO_SHORT' });
    await new Promise((x) => setTimeout(x, 400));
    expect(r.mock.state.audioMsgs).toBe(0);
    expect(turns(b)).toHaveLength(0);
    expect(b.audioBytes).toBe(0);
    b.ws.send(JSON.stringify({ type: 'end' }));
    await b.wait('stopped');
    const rec = JSON.parse(readFileSync(path.join(r.dir, `live-${sessionId}.json`), 'utf8'));
    expect(rec.turns).toEqual([]);
    expect(rec.notices.map((n: { code: string }) => n.code)).toContain('TOO_SHORT');
  });

  it('무음이 계속되면 안내만 하고 업스트림 호출·비용이 없다', async () => {
    const r = await rig();
    const b = new Browser(r.base, '?noSpeechMs=1000');
    await b.wait('ready');
    await b.silence(1200, 5);
    expect(await b.wait('notice')).toMatchObject({ code: 'NO_SPEECH' });
    expect(r.mock.state.audioMsgs).toBe(0);
    expect(turns(b)).toHaveLength(0);
    expect(r.mock.state.promptTokens).toEqual([]);
  });

  it('충분히 긴 음성은 짧은 소리 앞의 선행 무음과 함께 정상 처리된다', async () => {
    const r = await rig();
    const b = new Browser(r.base);
    await b.wait('ready');
    await b.silence(400, 5);
    await b.say(600, 5);
    const t = await b.wait('turn');
    expect(t.userText).toMatch(/사용자 발화/);
    expect(r.mock.state.audioMsgs).toBeGreaterThan(10);
  });
});

describe('AC-4 누적 맥락 비용 관리', () => {
  async function run40(env: Record<string, string>, maxTurns = 40) {
    const r = await rig({ env, budgetKrw: 100000, mock: { audioChunks: 2, chunkIntervalMs: 5, firstAudioDelayMs: 5, vadSilenceMs: 120 } });
    const b = new Browser(r.base);
    const { sessionId } = await b.wait('ready');
    for (let i = 1; i <= maxTurns; i++) {
      if (b.events.some((e) => e.type === 'stopped')) break;
      await b.tone(400, 2);
      await b.silence(200, 2);
      try { await b.wait('turn', (e) => e.n === i, 3000); } catch { break; }
      await b.silence(1600, 1); // 다음 턴 전 유휴
    }
    const prompt = [...r.mock.state.promptTokens];
    const stopped = b.events.find((e) => e.type === 'stopped');
    if (!stopped) { b.ws.send(JSON.stringify({ type: 'end' })); await b.wait('stopped'); }
    const rec = JSON.parse(readFileSync(path.join(r.dir, `live-${sessionId}.json`), 'utf8'));
    return { rec, prompt, stopped };
  }

  it('슬라이딩 윈도우 압축을 켜면 40턴 모의 세션에서 턴당 입력 토큰이 상한 안에 유지된다', async () => {
    const { rec, prompt } = await run40({ DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS: '3000', DAILY_LOG_VOICE_LIVE_COMPRESSION_TARGET_TOKENS: '1500' });
    expect(rec.turns).toHaveLength(40);
    expect(rec.stoppedReason).toBeNull();
    expect(Math.max(...prompt)).toBeLessThanOrEqual(3000);
    expect(rec.totals.maxInputTokens).toBeLessThanOrEqual(3000);
    expect(rec.compression).toEqual({ triggerTokens: 3000, targetTokens: 1500 });
    const avgIn = rec.totals.inputTokens / 40;
    console.info(`[AC-4] 압축 ON: 40턴 입력 합계 ${rec.totals.inputTokens} (평균 ${Math.round(avgIn)}/턴, 최대 ${rec.totals.maxInputTokens}), 출력 ${rec.totals.outputTokens}, 추정 ${rec.estimatedCostKrw.toFixed(1)}원`);
  }, 120000);

  it('압축이 꺼져 있으면 맥락이 계속 늘어 상한(12,000토큰)에서 새 턴 전에 안전 종료한다', async () => {
    const { rec, stopped } = await run40({ DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS: '0' });
    expect(stopped).toMatchObject({ reason: 'CONTEXT' });
    expect(rec.turns.length).toBeLessThan(40);
    expect(rec.totals.maxInputTokens).toBeGreaterThan(12000);
    console.info(`[AC-4] 압축 OFF: ${rec.turns.length}턴에서 CONTEXT 종료, 입력 합계 ${rec.totals.inputTokens}, 추정 ${rec.estimatedCostKrw.toFixed(1)}원`);
  }, 120000);
});

describe('설정 검증', () => {
  it('압축 목표가 시작값 이상이거나 숫자가 아니면 시작을 거부한다', () => {
    expect(() => loadLiveConfig('k', { DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS: '1000', DAILY_LOG_VOICE_LIVE_COMPRESSION_TARGET_TOKENS: '1000' })).toThrow();
    expect(() => loadLiveConfig('k', { DAILY_LOG_VOICE_LIVE_INPUT_RATE: 'abc' })).toThrow();
    expect(() => loadLiveConfig('k', { DAILY_LOG_VOICE_LIVE_PRICING_JSON: '{bad' })).toThrow();
    const c = loadLiveConfig('k', {});
    expect(c).toMatchObject({ model: 'gemini-3.1-flash-live-preview', inputRate: 16000, pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 12 } });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('Live 호출의 월 원장 연동 (TASK-13)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  beforeAll(async () => { t = await createTempSchema(process.env.DATABASE_URL!); pool = t.pool(); });
  afterAll(async () => { await pool.end(); await t.drop(); });

  it('AC-3 한 턴이 예약→확정으로 월 원장에 기록되고 세션 추정액과 같다', async () => {
    const monthly = new MonthlyLedger(pool, { clock: () => new Date('2031-03-10T12:00:00+09:00') });
    const r = await rig({ monthly });
    const b = new Browser(r.base);
    await b.wait('ready');
    await b.say(600, 10);
    await b.wait('turn');
    await new Promise((res) => setTimeout(res, 300));
    const snap = await monthly.snapshot();
    const rec = JSON.parse(readFileSync(path.join(r.dir, readdirSync(r.dir).find((f) => f.startsWith('live-'))!), 'utf8'));
    expect(snap.confirmedKrw).toBeCloseTo(rec.estimatedCostKrw, 2);
    expect(snap.reservedKrw).toBe(0);
  }, 20000);

  it('AC-1 월 잔여가 없으면 업스트림 연결 없이 시작하지 않는다', async () => {
    const monthly = new MonthlyLedger(pool, { clock: () => new Date('2031-04-10T12:00:00+09:00') });
    await monthly.recordCarryover('2031-04', HARD_MONTHLY_LIMIT_KRW, 'full', '소진');
    const r = await rig({ monthly });
    const b = new Browser(r.base);
    expect(await b.wait('stopped')).toMatchObject({ reason: 'BUDGET' });
    expect(r.mock.state.connections).toBe(0);
  });

  it('AC-5 usage 를 받지 못하고 끊긴 턴의 예약은 환급하지 않고 불명으로 남긴다', async () => {
    const monthly = new MonthlyLedger(pool, { clock: () => new Date('2031-05-10T12:00:00+09:00') });
    const r = await rig({ monthly });
    const b = new Browser(r.base);
    await b.wait('ready');
    await b.tone(600, 10); // 말 구간만 보내고 곧바로 종료
    await new Promise((res) => setTimeout(res, 100));
    b.ws.close();
    await new Promise((res) => setTimeout(res, 300));
    const snap = await monthly.snapshot();
    expect(snap.unknownKrw + snap.confirmedKrw).toBeGreaterThan(0);
    expect(snap.reservedKrw).toBe(0);
  }, 20000);
});
