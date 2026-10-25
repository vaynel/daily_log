import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadLiveConfig } from '../voice/live.js';
import { startMockLive, type MockLiveOptions } from '../voice/live-mock.testutil.js';
import type { SessionClaims } from '../auth/session.js';
import type { AuthFailure } from '../auth/plugin.js';
import { MemRecords, TEST_INTERVIEW, TEST_OWNER } from './memory.testutil.js';
import { registerInterview } from './routes.js';
import type { InterviewLimits } from './limits.js';
import { MemoryLiveUsageStore } from './usage.js';

const KEY = 'interview-sentinel-key-9921';
const ME = TEST_OWNER;
const ID = TEST_INTERVIEW;
type Ev = Record<string, unknown> & { type: string };

import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30000 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function rig(o: { mock?: Partial<MockLiveOptions>; limits?: InterviewLimits; disabled?: boolean } = {}) {
  const mock = await startMockLive({ expectedKey: KEY, vadSilenceMs: 250, firstAudioDelayMs: 40, audioChunks: 3, ...o.mock });
  cleanups.push(() => mock.close());
  const records = new MemRecords();
  const usage = new MemoryLiveUsageStore();
  const app: FastifyInstance = Fastify({ logger: false });
  const authenticate = (req: { headers: { cookie?: string } }): { user: SessionClaims } | AuthFailure => {
    const c = req.headers.cookie ?? '';
    if (c.includes('as=other')) return { user: { sub: 'user-other', email: 'o@x', iat: 0, exp: 9e9 } satisfies SessionClaims };
    if (c.includes('as=me')) return { user: { sub: ME, email: 'm@x', iat: 0, exp: 9e9 } satisfies SessionClaims };
    return { status: 401, code: 'unauthenticated' };
  };
  app.addHook('onRequest', async (req, reply) => {
    const r = authenticate(req);
    if ('status' in r) return reply.code(r.status).send({ error: r.code });
    (req as unknown as { user: SessionClaims }).user = r.user;
  });
  registerInterview(app, {
    records, usage, live: o.disabled ? null : loadLiveConfig(KEY, { DAILY_LOG_VOICE_LIVE_URL: mock.url }), sessionDir: mkdtempSync(path.join(os.tmpdir(), 'dl-iv-')),
    limits: o.limits, authenticate,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { mock, records, usage, app, base };
}

class Client {
  events: Ev[] = [];
  audioChunks = 0;
  closed = false;
  status: number | null = null;
  ws: WebSocket;
  constructor(base: string, id = ID, cookie = 'as=me') {
    this.ws = new WebSocket(`ws://${base}/api/interview/ws?id=${id}`, { headers: { cookie } });
    this.ws.on('message', (d, bin) => { if (bin) this.audioChunks++; else this.events.push(JSON.parse(d.toString()) as Ev); });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('unexpected-response', (_r, res) => { this.status = res.statusCode ?? 0; res.resume(); });
    this.ws.on('error', () => { /* 거부 시험 */ });
    cleanups.push(() => this.ws.terminate());
  }
  async wait(type: string, pred: (e: Ev) => boolean = () => true, ms = 8000): Promise<Ev> {
    const t0 = Date.now();
    for (;;) {
      const e = this.events.find((x) => x.type === type && pred(x));
      if (e) return e;
      if (Date.now() - t0 > ms) throw new Error(`timeout ${type}; got ${this.events.map((x) => x.type).join(',')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async closedOrStatus(ms = 3000) {
    const t0 = Date.now();
    while (!this.closed && this.status === null && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  }
  async feed(msTotal: number, tone: boolean) {
    for (let f = 0; f < Math.round(msTotal / 40); f++) {
      const b = Buffer.alloc(640 * 2);
      if (tone) for (let i = 0; i < 640; i++) b.writeInt16LE(Math.round(9000 * Math.sin((f * 640 + i) * 0.11)), i * 2);
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  async say() { await this.feed(600, true); await this.feed(400, false); }
  /** 말하고 AI 응답이 끝날 때(turn)까지 기다린다. */
  async turn(n: number) { await this.say(); return this.wait('turn', (e) => e.n === n); }
}

const getState = async (r: Awaited<ReturnType<typeof rig>>, cookie = 'as=me', id = ID) =>
  r.app.inject({ url: `/api/interview/${id}/state`, headers: { cookie } });

describe('AC-2 시작 전에는 녹음·업스트림 연결이 없다', () => {
  it('상태 조회만으로는 Live 연결이 생기지 않고, 연결 후에도 소리가 없으면 업스트림으로 오디오가 가지 않는다', async () => {
    const r = await rig();
    const res = await getState(r);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ canTalk: true, blockReason: null, usage: { status: 'NONE', usedMs: 0 } });
    expect(r.mock.state.connections).toBe(0);
    const c = new Client(r.base);
    await c.wait('ready');
    await c.feed(1200, false); // 무음만 전송
    expect(r.mock.state.audioMsgs).toBe(0);
    c.ws.send(JSON.stringify({ type: 'pause' }));
    await c.wait('stopped');
  });
});

describe('AC-1/3/5 연속 대화·저장·일시정지 후 이어하기·다른 기기 조회', () => {
  it('두 턴이 한 연결에서 이어지고 글이 저장되며, 일시정지 후 재개하면 기존 대화를 지시문에 싣고 같은 일일 사용량에 합산한다', async () => {
    const r = await rig();
    const c = new Client(r.base);
    await c.wait('ready');
    await c.turn(1); await c.turn(2);
    expect(r.mock.state.connections).toBe(1);
    // 저장: 턴마다 ANSWER → QUESTION 순서
    await new Promise((x) => setTimeout(x, 100));
    expect(r.records.items.map((i) => i.kind)).toEqual(['ANSWER', 'QUESTION', 'ANSWER', 'QUESTION']);
    expect(r.records.items[0]!.body).toMatch(/사용자 발화 1/);

    c.ws.send(JSON.stringify({ type: 'pause' }));
    const stopped = await c.wait('stopped');
    expect(stopped.reason).toBe('USER_PAUSE');
    await new Promise((x) => setTimeout(x, 100));
    const u1 = await r.usage.get(ME, ID);
    expect(u1).toMatchObject({ status: 'OPEN', connections: 1 });
    expect(u1!.usedMs).toBeGreaterThan(1000);
    expect(u1!.costKrw).toBeGreaterThan(0);
    const countBefore = r.records.items.length;

    // AC-5: 다른 기기(같은 계정)에서 상태 조회 → 같은 대화
    const st = (await getState(r)).json();
    expect(st.conversation).toHaveLength(countBefore);
    expect(st).toMatchObject({ canTalk: true, usage: { status: 'OPEN' }, attachmentCount: 1 });

    // 재개
    const c2 = new Client(r.base);
    const ready = await c2.wait('ready');
    expect(ready.usedMs as number).toBeGreaterThanOrEqual(u1!.usedMs);
    const setup = r.mock.state.setups[1]!;
    const instr = (setup.systemInstruction as { parts: { text: string }[] }).parts[0]!.text;
    expect(instr).toContain('[이어하기]');
    expect(instr).toContain('사용자 발화 1');
    expect(instr).toContain('인터뷰어: 네, 1번째');
    await c2.turn(1);
    await new Promise((x) => setTimeout(x, 100));
    expect(r.records.items).toHaveLength(countBefore + 2); // 기존 항목 유지 + 새 턴
    expect(r.records.items.slice(0, countBefore).map((i) => i.body)).toEqual((st.conversation as { body: string }[]).map((i) => i.body));
    c2.ws.send(JSON.stringify({ type: 'pause' }));
    await c2.wait('stopped');
    await new Promise((x) => setTimeout(x, 100));
    const u2 = await r.usage.get(ME, ID);
    expect(u2).toMatchObject({ connections: 2, status: 'OPEN' });
    expect(u2!.usedMs).toBeGreaterThan(u1!.usedMs);
  });

  it('연결이 끊겨도(브라우저 종료) 이미 저장된 대화는 남고 이어하기가 가능하다', async () => {
    const r = await rig();
    const c = new Client(r.base);
    await c.wait('ready');
    await c.turn(1);
    c.ws.terminate();
    await new Promise((x) => setTimeout(x, 200));
    expect(r.records.items).toHaveLength(2);
    expect((await r.usage.get(ME, ID))!.status).toBe('OPEN');
    expect((await getState(r)).json().canTalk).toBe(true);
  });

  it('업스트림(Live)이 끊기면 LIVE_CLOSED 로 알리고, 기존 기록은 보존되며 하루 사용은 소진되지 않는다', async () => {
    const r = await rig({ mock: { dropAfterTurns: 1 } });
    const c = new Client(r.base);
    await c.wait('ready');
    await c.say();
    const s = await c.wait('stopped');
    expect(s.reason).toBe('LIVE_CLOSED');
    await new Promise((x) => setTimeout(x, 100));
    expect(r.records.items.length).toBeGreaterThanOrEqual(1);
    expect((await r.usage.get(ME, ID))!.status).toBe('OPEN');
  });
});

describe('AC-8 하루 1회·10분·700원 상한(서버 강제)', () => {
  it('근접하면 마무리 안내를 한 번 보내고, 시간 상한에 도달하면 종료하며, 같은 날 다시 시작하면 업스트림 연결 없이 거부한다', async () => {
    const limits: InterviewLimits = { maxMs: 4000, wrapMs: 1500, maxCostKrw: 700, wrapCostKrw: 560 };
    const r = await rig({ limits });
    const c = new Client(r.base);
    await c.wait('ready');
    await c.turn(1); // 약 1.2s+
    await c.turn(2); // 마무리 구간 진입
    const wrap = await c.wait('wrap_up');
    expect(wrap.limits).toMatchObject({ maxMs: 4000 });
    expect(r.mock.state.textInputs).toHaveLength(1);
    expect(r.mock.state.textInputs[0]).toContain('마무리');
    const stopped = await c.wait('stopped', (e) => e.reason === 'TIME_LIMIT', 8000);
    expect(stopped.message).toContain('종료');
    await new Promise((x) => setTimeout(x, 150));
    expect(r.mock.state.textInputs).toHaveLength(1); // 마무리 안내는 한 번만
    const u = await r.usage.get(ME, ID);
    expect(u).toMatchObject({ status: 'ENDED', endReason: 'TIME_LIMIT' });
    expect((await getState(r)).json()).toMatchObject({ canTalk: false, blockReason: 'DAILY_LIMIT' });
    const connsBefore = r.mock.state.connections;
    const c2 = new Client(r.base);
    const refused = await c2.wait('stopped');
    expect(refused.reason).toBe('DAILY_LIMIT');
    expect(r.mock.state.connections).toBe(connsBefore);
  });

  it('비용이 근접하면 마무리, 도달하면 새 턴 없이 종료한다(턴당 비용은 모의 토큰 기준)', async () => {
    const limits: InterviewLimits = { maxMs: 600_000, wrapMs: 480_000, maxCostKrw: 25, wrapCostKrw: 8 };
    const r = await rig({ limits });
    const c = new Client(r.base);
    await c.wait('ready');
    await c.turn(1);
    const wrap = await c.wait('wrap_up');
    expect(wrap.costKrw as number).toBeGreaterThanOrEqual(8);
    const answeredAtWrap = r.mock.state.turnsAnswered;
    // 안내에 대한 AI 응답이 끝난 뒤 계속 말해도 한도에 닿으면 새 턴을 받지 않는다.
    for (let i = 0; i < 6 && !c.events.some((e) => e.type === 'stopped'); i++) await c.say();
    const stopped = await c.wait('stopped');
    expect(stopped.reason).toBe('COST_LIMIT');
    expect(r.mock.state.turnsAnswered).toBeLessThanOrEqual(answeredAtWrap + 3);
    await new Promise((x) => setTimeout(x, 150));
    expect((await r.usage.get(ME, ID))).toMatchObject({ status: 'ENDED', endReason: 'COST_LIMIT' });
    expect((await getState(r)).json().blockReason).toBe('DAILY_LIMIT');
  });

  it('사용자가 대화를 끝내면 그날은 다시 시작할 수 없고, 일시정지는 소진하지 않는다', async () => {
    const r = await rig();
    const c = new Client(r.base);
    await c.wait('ready');
    await c.turn(1);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await c.wait('stopped');
    await new Promise((x) => setTimeout(x, 100));
    expect((await r.usage.get(ME, ID))!.status).toBe('ENDED');
    const c2 = new Client(r.base);
    expect((await c2.wait('stopped')).reason).toBe('DAILY_LIMIT');
  });

  it('이전 연결들에서 이미 한도를 쓴 기록은 합산되어 새 연결을 시작하지 않는다', async () => {
    const r = await rig();
    await r.usage.open(ME, ID, new Date());
    await r.usage.add(ME, ID, 600_000, 10, null, new Date());
    const c = new Client(r.base);
    expect((await c.wait('stopped')).reason).toBe('DAILY_LIMIT');
    expect(r.mock.state.connections).toBe(0);
    expect((await r.usage.get(ME, ID))!.status).toBe('ENDED');
  });
});

describe('접근 제어·실패 상태', () => {
  it('로그인하지 않은 WebSocket 은 401, 남의 기록은 NOT_FOUND, 상태 조회는 404', async () => {
    const r = await rig();
    const anon = new Client(r.base, ID, '');
    await anon.closedOrStatus();
    expect(anon.status).toBe(401);
    const other = new Client(r.base, ID, 'as=other');
    expect((await other.wait('stopped')).reason).toBe('NOT_FOUND');
    expect((await getState(r, 'as=other')).statusCode).toBe(404);
    expect((await getState(r, 'as=me', 'not-a-uuid')).statusCode).toBe(404);
    expect(r.mock.state.connections).toBe(0);
  });

  it('Live 설정이 없으면 시작을 거부하고(fail closed) 상태에 사유가 표시되며, 확정된 기록도 거부한다', async () => {
    const r = await rig({ disabled: true });
    expect((await getState(r)).json()).toMatchObject({ canTalk: false, blockReason: 'LIVE_DISABLED' });
    expect((await new Client(r.base).wait('stopped')).reason).toBe('LIVE_DISABLED');
    const r2 = await rig();
    r2.records.status = 'CONFIRMED';
    expect((await getState(r2)).json().blockReason).toBe('CONFIRMED');
    expect((await new Client(r2.base).wait('stopped')).reason).toBe('CONFIRMED');
    expect(r2.mock.state.connections).toBe(0);
  });

  it('한 번에 한 연결만 허용한다(두 번째는 BUSY, 기존 연결은 유지)', async () => {
    const r = await rig();
    const a = new Client(r.base);
    await a.wait('ready');
    const b = new Client(r.base);
    expect((await b.wait('stopped')).reason).toBe('BUSY');
    expect(a.closed).toBe(false);
  });

  it('상태 조회에 만료된 음성 안내가 실제 보존 건수와 함께 표시된다(AC-6)', async () => {
    const r = await rig();
    r.records.items.push({ id: 'i1', seq: 1, kind: 'ANSWER', body: '오늘은 테스트를 썼다', key: 'k1' });
    r.records.audio = [{ id: 'au1', firstSavedAt: new Date('2026-09-01'), expiresAt: new Date('2026-10-01'), status: 'EXPIRED', recovered: false }];
    const n = (await getState(r)).json().audioNotice;
    expect(n).toMatchObject({ code: 'AUDIO_EXPIRED', expiredCount: 1, preserved: { items: 1, attachments: 1 }, backup: 'NONE' });
    expect(n.message).toContain('이어서 들을 수 없습니다');
  });
});
