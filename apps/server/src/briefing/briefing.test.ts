import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionClaims } from '../auth/session.js';
import { MemoryLiveUsageStore } from '../interview/usage.js';
import { applyCorrection, buildItems, decideEntry, generateBriefing, MAX_VIDEO_ITEMS, planOf, viewOf, type ProInfer } from './briefing.js';
import { classifyExclusion } from './exclusion.js';
import { B_ID, B_OWNER, MemBriefingRecords } from './memory.testutil.js';
import { registerBriefing } from './routes.js';
import { DEFAULT_LIMITS } from '../interview/limits.js';

const U = (text: string, extra: object = {}) => ({ kind: 'FACT', source: 'USER', text, ...extra });
const MODEL_OUT = JSON.stringify([
  U('에코 버그를 고쳤다', { emphasis: true }),
  { kind: 'OPINION', source: 'USER', text: '뿌듯했다' },
  { kind: 'UNCERTAIN', source: 'USER', text: '원인은 캐시 같기도 하다' },
  { kind: 'MATERIAL', source: 'ATTACHMENT', text: '자료는 캐시 무효화를 설명한다' },
  U('SQL 인젝션 예방 방법을 공부했다'),
  U('여당 대표 발언 때문에 하루종일 짜증났다'),
  U('팀장은 무능해서 회의가 길었다'),
  U('옆 팀 누가 잘렸다는 소문을 들었다'),
  U('전 직장 동료가 형사 고소를 당했다고 한다'),
]);
const okInfer = (out = MODEL_OUT): ProInfer & { calls: number } => { const f = (async () => { f.calls++; return { state: 'SUCCEEDED', text: out }; }) as unknown as ProInfer & { calls: number }; f.calls = 0; return f; };

describe('제외 분류(AC-5)', () => {
  it('정치·비방·뒷담화·형사 사건은 제외한다', () => {
    expect(classifyExclusion('여당 대표 발언 때문에 짜증났다')).toBe('POLITICS');
    expect(classifyExclusion('팀장은 무능해서 회의가 길었다')).toBe('DEFAMATION');
    expect(classifyExclusion('옆 팀 누가 잘렸다는 소문을 들었다')).toBe('GOSSIP');
    expect(classifyExclusion('동료가 형사 고소를 당했다')).toBe('CRIMINAL');
  });
  it('보안 예방 학습과 일상 문장은 제외하지 않는다', () => {
    for (const t of ['SQL 인젝션 예방 방법을 공부했다', '피싱 메일 대응 절차를 정리했다', '취약점 스캐너를 돌려 XSS를 찾았다', '고소한 냄새가 나는 빵을 먹었다', '에코 버그를 고쳤다']) expect(classifyExclusion(t)).toBeNull();
  });
});

describe('영상 선정·필터(D17-02, AC-4·5)', () => {
  const items = buildItems(JSON.parse(MODEL_OUT));
  it('불확실·첨부 자료·정책 제외는 공개 제작 입력에 없고, 보안 학습은 들어간다', () => {
    const video = items.filter((i) => i.inVideo).map((i) => i.text);
    expect(video).toEqual(['에코 버그를 고쳤다', '뿌듯했다', 'SQL 인젝션 예방 방법을 공부했다']);
    expect(items.find((i) => i.text.includes('캐시 같기도'))!.excludedReason).toBe('UNCERTAIN');
    expect(items.find((i) => i.text.includes('자료는'))!.excludedReason).toBe('MATERIAL');
    expect(items.filter((i) => i.excludedReason && ['POLITICS', 'DEFAMATION', 'GOSSIP', 'CRIMINAL'].includes(i.excludedReason))).toHaveLength(4);
    expect(items.find((i) => i.text.includes('SQL'))!.topic).toBe('SECURITY');
  });
  it('강조한 내용이 개수 제한 안에서 먼저 선정된다', () => {
    const many = [...Array.from({ length: 8 }, (_, i) => U(`일 ${i}`)), U('오늘 제일 중요한 건 배포였다')] as never;
    const sel = buildItems(many).filter((i) => i.inVideo).map((i) => i.text);
    expect(sel).toHaveLength(MAX_VIDEO_ITEMS);
    expect(sel).toContain('오늘 제일 중요한 건 배포였다');
  });
  it('plan 에는 제외 항목이 들어가지 않는다', () => {
    expect(planOf(items, 3)).toEqual({ source: 'BRIEFING', briefingVersion: 3, lines: ['에코 버그를 고쳤다', '뿌듯했다', 'SQL 인젝션 예방 방법을 공부했다'] });
  });
});

describe('진입(D17-01)', () => {
  const base = { answers: 3, endReason: null, finishRequested: false, usedMs: 120_000, limits: DEFAULT_LIMITS };
  it('마무리 의사나 10분 상한이면 진입, 아니면 대기', () => {
    expect(decideEntry({ ...base, finishRequested: true })).toEqual({ enter: true, reason: 'USER_FINISH' });
    expect(decideEntry({ ...base, endReason: 'USER_END' })).toMatchObject({ enter: true });
    expect(decideEntry({ ...base, endReason: 'TIME_LIMIT', usedMs: 600_000 })).toEqual({ enter: true, reason: 'TIME_LIMIT' });
    expect(decideEntry({ ...base, usedMs: 600_000 })).toEqual({ enter: true, reason: 'TIME_LIMIT' });
    expect(decideEntry(base)).toEqual({ enter: false, reason: 'NOT_FINISHED' });
    expect(decideEntry({ ...base, endReason: 'CONNECTION_LOST' })).toEqual({ enter: false, reason: 'NOT_FINISHED' });
    expect(decideEntry({ ...base, answers: 0, finishRequested: true })).toEqual({ enter: false, reason: 'NO_CONTENT' });
  });
});

describe('생성·정정', () => {
  it('Pro 가 대기 상태면 항목 없이 PRO_WAITING 이고 재호출하지 않는다', async () => {
    let n = 0;
    const r = await generateBriefing({ conversation: [], attachments: [], infer: async () => { n++; return { state: 'WAIT_SUPPORT' }; } });
    expect(r).toMatchObject({ ok: false, code: 'PRO_WAITING', state: 'WAIT_SUPPORT', proCalls: 1 });
    expect(n).toBe(1);
  });
  it('형식 오류는 한 번만 다시 호출하고, 첨부가 사실로 둔갑한 출력은 쓰지 않는다', async () => {
    let n = 0;
    const bad = async () => { n++; return { state: 'SUCCEEDED', text: JSON.stringify([{ kind: 'FACT', source: 'ATTACHMENT', text: '캐시를 이해했다' }]) }; };
    expect(await generateBriefing({ conversation: [], attachments: [], infer: bad })).toMatchObject({ ok: false, code: 'BAD_OUTPUT', proCalls: 2 });
    expect(n).toBe(2);
  });
  it('정정은 지정한 항목만 바꾸고 나머지 항목·문장은 그대로다(AC-3)', () => {
    const items = buildItems(JSON.parse(MODEL_OUT));
    const r = applyCorrection(items, { itemId: 's1', action: 'REPLACE', text: '에코 버그 원인을 찾았다' });
    expect(r.ok && r.items.filter((i, k) => JSON.stringify(i) !== JSON.stringify(items[k])).map((i) => i.id)).toEqual(['s1']);
    expect(r.ok && r.speech).not.toContain('SQL');
    expect(r.ok && r.speech).toContain('나머지는 그대로');
  });
  it('제외하면 다음 후보가 대신 들어가고, 제외 대상·불확실은 되살릴 수 없다', () => {
    const items = buildItems(JSON.parse(MODEL_OUT));
    const r = applyCorrection(items, { itemId: 's2', action: 'EXCLUDE' });
    expect(r.ok && viewOf(r.items).video.map((v) => v.id)).toEqual(['s1', 's5']);
    expect(applyCorrection(items, { itemId: 's3', action: 'INCLUDE' })).toEqual({ ok: false, code: 'NOT_ALLOWED' });
    expect(applyCorrection(items, { itemId: 's6', action: 'INCLUDE' })).toEqual({ ok: false, code: 'NOT_ALLOWED' });
    expect(applyCorrection(items, { itemId: 'zz', action: 'EXCLUDE' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(applyCorrection(items, { itemId: 's1', action: 'REPLACE', text: '  ' })).toEqual({ ok: false, code: 'BAD_TEXT' });
  });
  it('정정 문장도 다시 필터링한다(정치 문장으로 고치면 영상에서 빠진다)', () => {
    const items = buildItems(JSON.parse(MODEL_OUT));
    const r = applyCorrection(items, { itemId: 's2', action: 'REPLACE', text: '선거 결과가 마음에 안 들었다' });
    expect(r.ok && r.changed.excludedReason).toBe('POLITICS');
  });
});

describe('브리핑 API: 한 단계 제시·확인 전 제작 금지·정정·원자적 확인', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

  async function rig(o: { infer?: ProInfer | null } = {}) {
    const records = new MemBriefingRecords();
    records.items = [
      { id: 'q1', seq: 1, kind: 'QUESTION', body: '오늘 뭐 했어요?' }, { id: 'a1', seq: 2, kind: 'ANSWER', body: '에코 버그를 고쳤어요' },
    ];
    records.attachments = [{ id: 'at1', itemId: null, storageKey: 'k', checksum: 'c', kind: 'MARKDOWN', name: 'notes.md' }];
    const usage = new MemoryLiveUsageStore();
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => { (req as unknown as { user: SessionClaims }).user = { sub: (req.headers['x-user'] as string) ?? B_OWNER, email: 'm@x', iat: 0, exp: 9e9 }; });
    const infer = o.infer === undefined ? okInfer() : o.infer;
    registerBriefing(app, { records, usage, infer });
    apps.push(app);
    const call = async (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => {
      const r = await app.inject({ method, url, payload, headers });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    };
    return { records, usage, call, infer };
  }
  const start = (r: Awaited<ReturnType<typeof rig>>, finish = true) => r.call('POST', `/api/briefing/${B_ID}/start`, { finish });

  it('AC-1: 하루 요약·영상 핵심·제외 목록·음성 안내가 한 응답(한 단계)에 함께 온다', async () => {
    const r = await rig();
    const res = await start(r);
    expect(res.status).toBe(200);
    expect(res.body.summary.length).toBeGreaterThan(0);
    expect(res.body.video.map((v: { text: string }) => v.text)).toContain('에코 버그를 고쳤다');
    expect(res.body.excluded.length).toBeGreaterThan(0);
    for (const t of [res.body.summary[0].text, res.body.video[0].text]) expect(res.body.speech).toContain(t);
    expect(res.body.speech).toContain('영상에는');
    expect(res.body.confirmed).toBe(false);
  });

  it('AC-2: 확인 전에는 제작 작업·확정·제작 상태가 없다(시작·정정·재조회 모두)', async () => {
    const r = await rig();
    const b = (await start(r)).body;
    await r.call('POST', `/api/briefing/${B_ID}/correct`, { version: b.version, itemId: 's1', action: 'EXCLUDE' });
    await r.call('GET', `/api/briefing/${B_ID}`);
    expect(r.records.jobs).toHaveLength(0);
    expect(r.records.status).toBe('IN_PROGRESS');
    expect(r.records.production).toBe('NONE');
    expect(r.records.versions.some((v) => v.kind === 'PRODUCTION_PLAN')).toBe(false);
  });

  it('AC-2: 확인하면 확정·계획·작업이 함께 생기고 같은 확인을 되풀이해도 작업은 1건이다', async () => {
    const r = await rig();
    const b = (await start(r)).body;
    const c1 = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    const c2 = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    expect(c1.status).toBe(200);
    expect(c2.body).toMatchObject({ duplicate: true, jobId: c1.body.jobId });
    expect(r.records.jobs).toHaveLength(1);
    expect(r.records.jobs[0]).toMatchObject({ kind: 'VIDEO_PRODUCTION', subjectId: B_ID });
    expect(r.records.status).toBe('CONFIRMED');
    expect(r.records.production).toBe('QUEUED');
    const plan = r.records.versions.find((v) => v.kind === 'PRODUCTION_PLAN')!.content as { lines: string[] };
    expect(plan.lines).toEqual(c1.body.lines);
  });

  it('AC-2: 작업 등록이 실패하면 확정도 계획도 남지 않는다(원자성)', async () => {
    const r = await rig();
    const b = (await start(r)).body;
    r.records.failJobInsert = true;
    const res = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    expect(res.status).toBe(500);
    expect(r.records.status).toBe('IN_PROGRESS');
    expect(r.records.production).toBe('NONE');
    expect(r.records.versions.some((v) => v.kind === 'PRODUCTION_PLAN')).toBe(false);
    expect(r.records.jobs).toHaveLength(0);
  });

  it('AC-3: 정정 응답은 전체 브리핑을 다시 읽지 않고 바뀐 항목만 알리며, Pro 를 다시 부르지 않는다', async () => {
    const infer = okInfer();
    const r = await rig({ infer });
    const b = (await start(r)).body;
    const res = await r.call('POST', `/api/briefing/${B_ID}/correct`, { version: b.version, itemId: 's2', action: 'REPLACE', text: '꽤 뿌듯했다' });
    expect(res.status).toBe(200);
    expect(res.body.repeatsFullBriefing).toBe(false);
    expect(res.body.changed.id).toBe('s2');
    expect(res.body.correctionSpeech).toContain('나머지는 그대로');
    expect(res.body.correctionSpeech).not.toContain('에코 버그');
    expect(res.body.version).toBe(b.version + 1);
    expect(infer.calls).toBe(1);
  });

  it('정정 뒤 이전 버전을 확인하려 하면 거부되고 작업은 없다(오래된 화면)', async () => {
    const r = await rig();
    const b = (await start(r)).body;
    await r.call('POST', `/api/briefing/${B_ID}/correct`, { version: b.version, itemId: 's2', action: 'EXCLUDE' });
    const stale = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('STALE_BRIEFING');
    expect((await r.call('POST', `/api/briefing/${B_ID}/correct`, { version: b.version, itemId: 's1', action: 'EXCLUDE' })).status).toBe(409);
    expect(r.records.jobs).toHaveLength(0);
  });

  it('AC-4: 불확실 항목은 추가 질문 없이(Pro 호출 1회) 제작 입력에서 빠진다', async () => {
    const infer = okInfer();
    const r = await rig({ infer });
    const b = (await start(r)).body;
    const c = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    expect(c.body.lines.join(' ')).not.toContain('캐시 같기도');
    expect(infer.calls).toBe(1);
    expect(r.records.items).toHaveLength(2); // 대화에 새 질문이 추가되지 않았다
  });

  it('AC-5: 확인된 제작 입력에 정치·비방·뒷담화·형사 문장이 없고 보안 학습은 있다', async () => {
    const r = await rig();
    const b = (await start(r)).body;
    const c = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    const text = c.body.lines.join('\n');
    for (const bad of ['여당', '무능', '소문', '형사']) expect(text).not.toContain(bad);
    expect(text).toContain('SQL 인젝션 예방');
  });

  it('Pro 대기·미설정이면 브리핑도 제작도 만들지 않고 유료로 대체하지 않는다', async () => {
    const waiting = await rig({ infer: async () => ({ state: 'WAIT_LIMIT' }) });
    const w = await start(waiting);
    expect(w.status).toBe(503);
    expect(w.body.error).toBe('PRO_WAITING');
    const none = await rig({ infer: null });
    expect((await start(none)).body.error).toBe('PRO_UNAVAILABLE');
    expect(waiting.records.versions).toHaveLength(0);
    expect(waiting.records.jobs).toHaveLength(0);
  });

  it('끝내지 않았거나 답변이 없으면 진입하지 않는다, 다시 열어도 Pro 는 한 번만', async () => {
    const infer = okInfer();
    const r = await rig({ infer });
    expect((await start(r, false)).body.error).toBe('NOT_FINISHED');
    expect(infer.calls).toBe(0);
    await start(r); await start(r);
    expect(infer.calls).toBe(1);
    const empty = await rig();
    empty.records.items = [];
    expect((await start(empty)).body.error).toBe('NO_CONTENT');
  });

  it('다른 사용자는 접근할 수 없다', async () => {
    const r = await rig();
    await start(r);
    expect((await r.call('GET', `/api/briefing/${B_ID}`, undefined, { 'x-user': 'someone-else' })).status).toBe(404);
    expect((await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: 1 }, { 'x-user': 'someone-else' })).status).toBe(404);
  });

  it('영상에 담을 내용이 없으면 확인해도 제작하지 않는다', async () => {
    const r = await rig({ infer: okInfer(JSON.stringify([{ kind: 'UNCERTAIN', source: 'USER', text: '아마 그랬던 것 같다' }])) });
    const b = (await start(r)).body;
    const c = await r.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b.version });
    expect(c.status).toBe(422);
    expect(r.records.jobs).toHaveLength(0);
  });
});
