import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildVoiceApp } from './app.js';
import { loadVoiceKeys, VoiceConfigError } from './keys.js';
import { mockTransports } from './mock.testutil.js';
import { loadPricing } from './pricing.js';
import { geminiTts, openaiStt, pcmToWav } from './transports.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'dl-voice-'));
const AUDIO = Buffer.alloc(4000, 7);
const SECRET = 'sentinel-secret-value-do-not-leak-0001';

async function setup(opts: Parameters<typeof mockTransports>[0] = {}, budgetKrw?: number, logs?: string[]) {
  const m = mockTransports(opts);
  let clock = 0;
  const dir = tmp();
  const logger = logs
    ? { level: 'info', stream: new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } }) }
    : false;
  const app = buildVoiceApp({ transports: m.t, sessionDir: dir, budgetKrw, logger, now: () => (clock += 10) });
  const id = ((await app.inject({ method: 'POST', url: '/voice/api/sessions' })).json() as { id: string }).id;
  const turn = (body: Buffer = AUDIO, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/voice/api/sessions/${id}/turns`, payload: body, headers: { 'content-type': 'audio/webm;codecs=opus', 'x-audio-duration-ms': '2000', ...headers } });
  return { app, m, id, dir, turn };
}

describe('AC-1 순차 처리와 계측', () => {
  it('발화→문자→응답→음성을 끝까지 처리하고 지연·호출 수·비용을 세션 기록에 남긴다', async () => {
    const { app, m, id, dir, turn } = await setup();
    const r = await turn();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.turn.userText).toBe('오늘은 산책을 했어요');
    expect(body.turn.replyText).toContain('산책');
    expect(body.audio.mime).toBe('audio/wav');
    expect(Buffer.from(body.audio.base64, 'base64').subarray(0, 4).toString()).toBe('RIFF');
    await turn();
    const s = (await app.inject({ url: `/voice/api/sessions/${id}` })).json();
    expect(s.calls).toEqual({ stt: 2, pro: 2, tts: 2 });
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0].latencyMs).toMatchObject({ stt: expect.any(Number), pro: expect.any(Number), tts: expect.any(Number), total: expect.any(Number) });
    expect(s.turns[0].latencyMs.total).toBeGreaterThan(0);
    expect(s.estimatedCostKrw).toBeGreaterThan(0);
    expect(s.turns[0].ttsOutputSeconds).toBe(0.6);
    // 두 번째 Pro 프롬프트에는 이전 턴 문맥이 들어간다(같은 세션 안에서만).
    expect(m.calls.prompts[1]).toContain('사용자: 오늘은 산책을 했어요');
    // 디스크 기록: 발화·답변 원문 없음, 0600.
    const file = path.join(dir, `${id}.json`);
    const raw = readFileSync(file, 'utf8');
    expect(JSON.parse(raw).calls.stt).toBe(2);
    expect(raw).not.toContain('산책');
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
    await app.close();
  });

  it('피드백(1~5)과 미지원 동작을 기록하고 범위를 검증한다', async () => {
    const { app, id } = await setup();
    const post = (b: unknown) => app.inject({ method: 'POST', url: `/voice/api/sessions/${id}/feedback`, payload: b as object });
    expect((await post({ naturalness: 6 })).statusCode).toBe(400);
    expect((await post({ naturalness: 4, unsupported: ['INTERRUPT', 'x'], note: 'ok' })).statusCode).toBe(200);
    const s = (await app.inject({ url: `/voice/api/sessions/${id}` })).json();
    expect(s.feedback).toMatchObject({ naturalness: 4, unsupported: ['INTERRUPT'] });
    await app.close();
  });

  it('Pro가 성공이 아니면 TTS를 호출하지 않고 대기 코드를 돌려준다(유료 대체 없음)', async () => {
    const { app, m, turn } = await setup({ pro: { state: 'WAIT_LIMIT' } });
    const r = await turn();
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('PRO_WAIT_LIMIT');
    expect(m.calls).toMatchObject({ stt: 1, pro: 1, tts: 0 });
    await app.close();
  });

  it('처리 중 두 번째 발화는 거절한다(동시 발화 미지원)', async () => {
    const { app, turn } = await setup({ delayMs: 30 });
    const [a, b] = await Promise.all([turn(), turn()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    await app.close();
  });
});

describe('AC-3 경계: 빈 음성·STT 빈 결과', () => {
  it('빈/너무 짧은 오디오는 외부 호출 없이 거절하고 저장하지 않는다', async () => {
    const { app, m, id, turn } = await setup();
    const r = await turn(Buffer.alloc(10));
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('EMPTY_AUDIO');
    expect(r.json().message).toContain('다시');
    expect(m.calls).toMatchObject({ stt: 0, pro: 0, tts: 0 });
    const s = (await app.inject({ url: `/voice/api/sessions/${id}` })).json();
    expect(s.turns).toHaveLength(0);
    expect(s.estimatedCostKrw).toBe(0);
    await app.close();
  });

  it('STT 빈 결과는 답변을 만들지 않고 턴을 저장하지 않는다(STT 비용만 계측)', async () => {
    const { app, m, id, turn } = await setup({ sttText: '   ' });
    const r = await turn();
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('STT_EMPTY');
    expect(m.calls).toMatchObject({ stt: 1, pro: 0, tts: 0 });
    const s = (await app.inject({ url: `/voice/api/sessions/${id}` })).json();
    expect(s.turns).toHaveLength(0);
    expect(s.rejected.map((x: { code: string }) => x.code)).toEqual(['STT_EMPTY']);
    await app.close();
  });

  it('지원하지 않는 형식·과대 업로드를 거절하고, STT/TTS 실패는 답변 없이 안내한다', async () => {
    const a = await setup();
    expect((await a.turn(AUDIO, { 'content-type': 'audio/x-weird' })).statusCode).toBe(415);
    expect((await a.turn(Buffer.alloc(2 * 1024 * 1024 + 2000, 1))).statusCode).toBe(413);
    expect(a.m.calls.stt).toBe(0);
    await a.app.close();
    const b = await setup({ sttThrows: true });
    expect((await b.turn()).json().code).toBe('STT_FAILED');
    expect(b.m.calls.pro).toBe(0);
    await b.app.close();
    const c = await setup({ ttsThrows: true });
    const r = await c.turn();
    expect(r.json().code).toBe('TTS_FAILED');
    const s = (await c.app.inject({ url: `/voice/api/sessions/${c.id}` })).json();
    expect(s.turns).toHaveLength(0);
    await c.app.close();
  });
});

describe('AC-4 키 파일·비밀값·예산', () => {
  const keyFiles = (mode: number, content = SECRET) => {
    const d = tmp();
    const f = path.join(d, 'k');
    writeFileSync(f, content);
    chmodSync(f, mode);
    return f;
  };
  it('키 환경변수/파일이 없으면 시작하지 않는다', () => {
    expect(() => loadVoiceKeys({})).toThrow(VoiceConfigError);
    try { loadVoiceKeys({ DAILY_LOG_OPENAI_KEY_FILE: '/nonexistent/a', DAILY_LOG_GEMINI_KEY_FILE: keyFiles(0o600) }); } catch (e) {
      expect((e as VoiceConfigError).problems).toEqual([{ env: 'DAILY_LOG_OPENAI_KEY_FILE', code: 'FILE_MISSING' }]);
    }
  });
  it('권한이 0600이 아니면(0644·0640·0400·0660) 시작하지 않고 오류에 키 값이 없다', () => {
    for (const mode of [0o644, 0o640, 0o400, 0o660, 0o666]) {
      const env = { DAILY_LOG_OPENAI_KEY_FILE: keyFiles(mode), DAILY_LOG_GEMINI_KEY_FILE: keyFiles(0o600) };
      let err: unknown;
      try { loadVoiceKeys(env); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(VoiceConfigError);
      expect((err as VoiceConfigError).problems[0]).toEqual({ env: 'DAILY_LOG_OPENAI_KEY_FILE', code: 'MODE_NOT_0600' });
      expect(String((err as Error).message)).not.toContain(SECRET);
    }
  });
  it('빈 파일과 디렉터리는 거절하고, 정상 0600 키는 읽는다', () => {
    expect(() => loadVoiceKeys({ DAILY_LOG_OPENAI_KEY_FILE: keyFiles(0o600, '\n'), DAILY_LOG_GEMINI_KEY_FILE: keyFiles(0o600) })).toThrow(VoiceConfigError);
    expect(() => loadVoiceKeys({ DAILY_LOG_OPENAI_KEY_FILE: tmp(), DAILY_LOG_GEMINI_KEY_FILE: keyFiles(0o600) })).toThrow(VoiceConfigError);
    expect(loadVoiceKeys({ DAILY_LOG_OPENAI_KEY_FILE: keyFiles(0o600), DAILY_LOG_GEMINI_KEY_FILE: keyFiles(0o600, 'g\n') })).toEqual({ openai: SECRET, gemini: 'g' });
  });

  it('예산이 모자라면 유료 호출(STT) 전에 중단하고 이후 발화도 막는다', async () => {
    const { app, m, id, turn } = await setup({}, 0.01);
    const r = await turn();
    expect(r.statusCode).toBe(402);
    expect(r.json().code).toBe('BUDGET_EXCEEDED');
    expect(m.calls).toMatchObject({ stt: 0, pro: 0, tts: 0 });
    const s = (await app.inject({ url: `/voice/api/sessions/${id}` })).json();
    expect(s.stoppedReason).toBe('BUDGET');
    expect((await turn()).statusCode).toBe(402);
    expect(m.calls.stt).toBe(0);
    await app.close();
  });

  it('누적 지출이 상한에 닿으면 유료 호출 전에 멈추고 상한을 넘겨 지출하지 않는다', async () => {
    const limit = 3;
    const { app, m, id, turn } = await setup({}, limit);
    let stopped = 0;
    for (let i = 0; i < 12 && !stopped; i++) {
      const r = await turn();
      if (r.statusCode === 402) stopped = i + 1;
      else expect(r.statusCode).toBe(200);
    }
    expect(stopped).toBeGreaterThan(1); // 첫 턴은 성공, 이후 어느 시점에 중단
    const s = (await app.inject({ url: `/voice/api/sessions/${id}` })).json();
    expect(s.stoppedReason).toBe('BUDGET');
    expect(s.estimatedCostKrw).toBeLessThanOrEqual(limit);
    const sttBefore = m.calls.stt;
    expect((await turn()).statusCode).toBe(402);
    expect(m.calls.stt).toBe(sttBefore); // 중단 후에는 유료 호출 없음
    await app.close();
  });

  it('길이 헤더가 없으면 최악 길이로 추정해 예산을 우회할 수 없다', async () => {
    const { app, m, turn } = await setup({}, 0.5);
    const r = await turn(AUDIO, { 'x-audio-duration-ms': 'abc' });
    expect(r.statusCode).toBe(402);
    expect(m.calls.stt).toBe(0);
    await app.close();
  });

  it('실제 transport 오류·로그·응답·세션 파일 어디에도 키 값이 남지 않는다', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const failing = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ error: `bad key ${SECRET}` }), { status: 401 });
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const m = mockTransports();
    const t = { ...m.t, stt: openaiStt(SECRET, failing), tts: geminiTts(SECRET, failing) };
    const dir = tmp();
    const app = buildVoiceApp({ transports: t, sessionDir: dir, logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } }) } });
    const id = ((await app.inject({ method: 'POST', url: '/voice/api/sessions' })).json() as { id: string }).id;
    const r1 = await app.inject({ method: 'POST', url: `/voice/api/sessions/${id}/turns`, payload: AUDIO, headers: { 'content-type': 'audio/webm', 'x-audio-duration-ms': '1500' } });
    expect(r1.json().code).toBe('STT_FAILED');
    // TTS 실패 경로도 확인: STT만 정상 모의로 교체.
    const app2 = buildVoiceApp({ transports: { ...m.t, tts: geminiTts(SECRET, failing) }, sessionDir: dir, logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } }) } });
    const id2 = ((await app2.inject({ method: 'POST', url: '/voice/api/sessions' })).json() as { id: string }).id;
    const r2 = await app2.inject({ method: 'POST', url: `/voice/api/sessions/${id2}/turns`, payload: AUDIO, headers: { 'content-type': 'audio/webm', 'x-audio-duration-ms': '1500' } });
    expect(r2.json().code).toBe('TTS_FAILED');
    const everything = [r1.body, r2.body, ...logs, ...readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8'))].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(logs.length).toBeGreaterThan(0);
    // 키는 인증 헤더로만 전송, URL에는 없다.
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s.url).not.toContain(SECRET);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[1]!.headers['x-goog-api-key']).toBe(SECRET);
    await app.close();
    await app2.close();
  });
});

describe('transport·단가 보조', () => {
  it('Gemini 응답 PCM을 WAV로 감싸 출력 초를 계산한다', async () => {
    const pcm = Buffer.alloc(24000 * 2);
    const f = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } }] }))) as unknown as typeof fetch;
    const r = await geminiTts('k', f)('안녕하세요');
    expect(r.outputSeconds).toBe(1);
    expect(r.audio.length).toBe(pcmToWav(pcm).length);
  });
  it('단가 덮어쓰기는 검증한다', () => {
    expect(loadPricing({ DAILY_LOG_VOICE_PRICING_JSON: '{"usdKrw":1400}' }).usdKrw).toBe(1400);
    expect(() => loadPricing({ DAILY_LOG_VOICE_PRICING_JSON: '{"usdKrw":-1}' })).toThrow();
    expect(() => loadPricing({ DAILY_LOG_VOICE_PRICING_JSON: 'x' })).toThrow();
  });
  it('페이지가 서빙되고 오류 응답에 내부 정보가 없다', async () => {
    const { app } = await setup();
    const p = await app.inject({ url: '/voice-test' });
    expect(p.statusCode).toBe(200);
    expect(p.body).toContain('대화 시작');
    expect((await app.inject({ url: '/voice/api/sessions/not-a-uuid' })).statusCode).toBe(404);
    await app.close();
  });
});
