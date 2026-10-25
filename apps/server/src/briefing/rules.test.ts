import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionClaims } from '../auth/session.js';
import { MemoryLiveUsageStore } from '../interview/usage.js';
import { buildItems, type ProInfer } from './briefing.js';
import { classifyExclusion } from './exclusion.js';
import { B_ID, B_OWNER, MemBriefingRecords } from './memory.testutil.js';
import { classifyCommand, keywordsFromCommand, MemoryRuleStore, normalizeRuleInput } from './rules.js';
import { registerBriefing } from './routes.js';

const U = (text: string) => ({ kind: 'FACT', source: 'USER', text });
const outOf = (...t: string[]) => JSON.stringify(t.map(U));
const inferOf = (out: string): ProInfer => async () => ({ state: 'SUCCEEDED', text: out });

describe('명령 분류(D27-01, AC-2)', () => {
  it.each([
    ['이거 이번 영상에서는 빼 줘', 'THIS_VIDEO'],
    ['이 부분 제외해 줘', 'THIS_VIDEO'],
    ['이 기록 삭제해 줘', 'DELETE_ORIGINAL'],
    ['원본 지워 줘', 'DELETE_ORIGINAL'],
    ['앞으로 이런 얘기는 영상에서 빼 줘', 'ALWAYS_EXCLUDE'],
    ['다음부터 계속 제외해', 'ALWAYS_EXCLUDE'],
    ['지우지 말고 영상에서만 빼 줘', 'THIS_VIDEO'],
    ['삭제는 하지 말고 앞으로 빼 줘', 'ALWAYS_EXCLUDE'],
    ['앞으로 영상에서 빼고 원본도 삭제해', 'DELETE_ORIGINAL'],
    ['음 잘 모르겠어', 'UNCLEAR'],
  ])('%s → %s', (text, scope) => expect(classifyCommand(text)).toBe(scope));
  it('따옴표로 지정한 단어만 키워드 후보로 뽑는다', () => {
    expect(keywordsFromCommand('앞으로 "프로젝트 오로라" 얘기는 빼 줘')).toEqual(['프로젝트 오로라']);
    expect(keywordsFromCommand('앞으로 우리 회사 얘기는 전부 빼 줘')).toEqual([]);
  });
  it('문장 길이·개수 초과 키워드는 거부한다(원문 복제 방지)', () => {
    expect(normalizeRuleInput({ category: 'OTHER', keywords: ['팀장이 어제 회의에서 나한테 한 말 전부'] })).toBeNull();
    expect(normalizeRuleInput({ category: 'OTHER', keywords: ['가나', '다라', '마바', '사아', '자차', '카타'] })).toBeNull();
    expect(normalizeRuleInput({ category: 'BAD', keywords: ['오로라'] })).toBeNull();
    expect(normalizeRuleInput({ category: 'WORK_CONFIDENTIAL', keywords: [' 오로라 ', '오로라'] })).toEqual({ category: 'WORK_CONFIDENTIAL', keywords: ['오로라'] });
  });
});

describe('형사 사건 제외 경계(AC-5)와 알려진 한계', () => {
  it('보안·예방 학습은 제외하지 않고, 형사 사건 문장만 제외한다', () => {
    for (const t of ['SQL 인젝션 예방 방법을 공부했다', '랜섬웨어 침해 대응 절차를 정리했다', '피싱 메일 구분법을 익혔다', '모의 해킹 도구 사용법을 읽었다']) expect(classifyExclusion(t)).toBeNull();
    expect(classifyExclusion('보안 사고로 회사가 고소를 당했다')).toBe('CRIMINAL');
    expect(classifyExclusion('해킹 사건 재판 결과를 봤다')).toBe('CRIMINAL');
  });
  it('키워드 기반 한계(TASK-20 QA 관찰) 현재 동작을 기록한다: 오탐 1건·미탐 1건', () => {
    // 오탐: 사람을 겨냥하지 않은 표현. 개선 전까지 사용자는 브리핑에서 되살릴 수 없고 기록에는 남는다.
    expect(classifyExclusion('쓰레기 코드를 리팩터링했다')).toBe('DEFAMATION');
    // 미탐: 키워드 없이 돌려 말한 비방.
    expect(classifyExclusion('걔랑 일하면 속이 터진다')).toBeNull();
  });
});

describe('제외 명령·반복 기준 API', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

  async function rig(out: string, rules = new MemoryRuleStore()) {
    const records = new MemBriefingRecords();
    records.items = [{ id: 'q1', seq: 1, kind: 'QUESTION', body: '오늘 뭐 했어요?' }, { id: 'a1', seq: 2, kind: 'ANSWER', body: '답' }];
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => { (req as unknown as { user: SessionClaims }).user = { sub: (req.headers['x-user'] as string) ?? B_OWNER, email: 'm@x', iat: 0, exp: 9e9 }; });
    registerBriefing(app, { records, usage: new MemoryLiveUsageStore(), infer: inferOf(out), rules });
    apps.push(app);
    const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) => {
      const r = await app.inject({ method, url, payload, headers });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    };
    const start = () => call('POST', `/api/briefing/${B_ID}/start`, { finish: true });
    return { records, rules, call, start };
  }
  const OUT = outOf('에코 버그를 고쳤다', '오로라 프로젝트 일정이 밀렸다', '아내와 저녁을 먹었다');

  it('AC-1·2: 이번 영상 제외는 항목만 빼고 규칙을 만들지 않으며 기록 원본을 지우지 않는다', async () => {
    const r = await rig(OUT);
    const b = (await r.start()).body;
    const before = JSON.stringify(r.records.items);
    const res = await r.call('POST', `/api/briefing/${B_ID}/exclude-command`, { version: b.version, itemId: 's2', text: '이거 이번 영상에서는 빼 줘' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'THIS_VIDEO', executed: true, originalDeleted: false, ruleSaved: false });
    expect(res.body.excluded.map((e: { id: string }) => e.id)).toContain('s2');
    expect(res.body.proposal).toBeUndefined();
    expect(await r.rules.list(B_OWNER)).toHaveLength(0);
    expect(JSON.stringify(r.records.items)).toBe(before);
    expect(r.records.status).toBe('IN_PROGRESS');
    // 원문 문장은 기록 안 요약 버전에 그대로 남아 있다(영상에서만 제외).
    expect((await r.call('GET', `/api/briefing/${B_ID}`)).body.summary.map((s: { id: string }) => s.id)).toContain('s2');
  });

  it('AC-1: 삭제 명령은 이 경로에서 아무것도 지우지 않고 별도 절차를 안내한다', async () => {
    const r = await rig(OUT);
    const b = (await r.start()).body;
    const v0 = r.records.versions.length;
    const res = await r.call('POST', `/api/briefing/${B_ID}/exclude-command`, { version: b.version, itemId: 's2', text: '이 기록 삭제해 줘' });
    expect(res.body).toMatchObject({ scope: 'DELETE_ORIGINAL', executed: false, originalDeleted: false });
    expect(r.records.versions).toHaveLength(v0);
    expect(r.records.items).toHaveLength(2);
    expect(await r.rules.list(B_OWNER)).toHaveLength(0);
  });

  it('AC-2: "앞으로" 명령도 확인 전에는 규칙을 저장하지 않고 제안만 돌려준다', async () => {
    const r = await rig(OUT);
    const b = (await r.start()).body;
    const res = await r.call('POST', `/api/briefing/${B_ID}/exclude-command`, { version: b.version, itemId: 's2', text: '앞으로 "오로라" 얘기는 빼 줘' });
    expect(res.body).toMatchObject({ scope: 'ALWAYS_EXCLUDE', executed: true, ruleSaved: false });
    expect(res.body.proposal).toMatchObject({ needsConfirmation: true, keywords: ['오로라'], needKeywords: false });
    expect(await r.rules.list(B_OWNER)).toHaveLength(0);
    const noConfirm = await r.call('POST', '/api/exclusion-rules', { category: 'WORK_CONFIDENTIAL', keywords: ['오로라'] });
    expect(noConfirm.status).toBe(422);
    expect(noConfirm.body.error).toBe('CONFIRM_REQUIRED');
    expect(await r.rules.list(B_OWNER)).toHaveLength(0);
  });

  it('상시 기준 항목에 "앞으로"를 해도 중복 규칙 제안을 하지 않는다', async () => {
    const r = await rig(outOf('여당 대표 발언에 화가 났다', '코드를 짰다'));
    const b = (await r.start()).body;
    const res = await r.call('POST', `/api/briefing/${B_ID}/exclude-command`, { version: b.version, itemId: 's1', text: '앞으로 계속 빼 줘' });
    expect(res.body.proposal).toBeNull();
  });

  it('AC-3·4: 확인한 기준은 다음 기록의 제작 입력에 반영되고, 저장 데이터에 발언 원문이 없다', async () => {
    const rules = new MemoryRuleStore();
    const r1 = await rig(OUT, rules);
    const b1 = (await r1.start()).body;
    await r1.call('POST', `/api/briefing/${B_ID}/exclude-command`, { version: b1.version, itemId: 's2', text: '앞으로 "오로라" 얘기는 빼 줘' });
    const made = await r1.call('POST', '/api/exclusion-rules', { confirm: true, category: 'WORK_CONFIDENTIAL', keywords: ['오로라'] });
    expect(made.status).toBe(201);

    // 다음 기록: 새 기록에서 같은 키워드가 나오면 제작 입력(plan)에서 빠진다.
    const r2 = await rig(outOf('오로라 배포 준비를 했다', '테스트를 작성했다'), rules);
    const b2 = (await r2.start()).body;
    const ex = b2.excluded.find((e: { text: string }) => e.text.includes('오로라'));
    expect(ex).toMatchObject({ reason: 'RULE', label: '내가 정한 제외 기준' });
    expect(b2.video.map((v: { text: string }) => v.text)).toEqual(['테스트를 작성했다']);
    const conf = await r2.call('POST', `/api/briefing/${B_ID}/confirm`, { version: b2.version });
    expect(conf.body.lines).toEqual(['테스트를 작성했다']);
    expect(JSON.stringify(r2.records.versions.find((v) => v.kind === 'PRODUCTION_PLAN')!.content)).not.toContain('오로라');
    // 규칙에 걸린 항목은 되살릴 수 없다.
    const inc = await r1.call('POST', `/api/briefing/${B_ID}/correct`, { version: (await r1.call('GET', `/api/briefing/${B_ID}`)).body.version, itemId: 's2', action: 'INCLUDE' });
    expect(inc.status).toBe(422);

    // AC-4: 저장된 규칙(이력 포함)에는 범주·키워드·개수만 있고 발언 문장은 없다.
    const saved = JSON.stringify([...rules.rows.values()]);
    expect(saved).not.toContain('일정이 밀렸다');
    expect(saved).not.toContain('얘기는 빼 줘');
    expect(saved).not.toContain('배포 준비');
    expect(made.body.history).toEqual([expect.objectContaining({ action: 'CREATED', category: 'WORK_CONFIDENTIAL', keywordCount: 1 })]);
  });

  it('D27-04: 수정·해제·재활성화가 이력에 남고 해제하면 이후 제작 입력에 적용되지 않는다', async () => {
    const rules = new MemoryRuleStore();
    const r = await rig(OUT, rules);
    const made = (await r.call('POST', '/api/exclusion-rules', { confirm: true, category: 'OTHER', keywords: ['오로라'] })).body;
    const dup = await r.call('POST', '/api/exclusion-rules', { confirm: true, category: 'OTHER', keywords: ['오로라'] });
    expect(dup.body.id).toBe(made.id);
    expect(await rules.list(B_OWNER)).toHaveLength(1);
    const edited = await r.call('PATCH', `/api/exclusion-rules/${made.id}`, { keywords: ['오로라', '북극광'], category: 'WORK_CONFIDENTIAL' });
    expect(edited.body).toMatchObject({ category: 'WORK_CONFIDENTIAL', keywords: ['오로라', '북극광'] });
    const off = await r.call('PATCH', `/api/exclusion-rules/${made.id}`, { active: false });
    expect(off.body.active).toBe(false);
    expect(off.body.history.map((h: { action: string }) => h.action)).toEqual(['CREATED', 'UPDATED', 'DISABLED']);
    expect(JSON.stringify(off.body.history)).not.toContain('북극광');
    const b = (await r.start()).body;
    expect(b.video.map((v: { text: string }) => v.text)).toContain('오로라 프로젝트 일정이 밀렸다');
    expect((await r.call('PATCH', `/api/exclusion-rules/${made.id}`, { active: true })).body.history.at(-1).action).toBe('ENABLED');
    expect((await r.call('GET', '/api/exclusion-rules')).body.rules).toHaveLength(1);
  });

  it('다른 소유자의 규칙은 보이지도 바꿀 수도 없다', async () => {
    const r = await rig(OUT);
    const made = (await r.call('POST', '/api/exclusion-rules', { confirm: true, category: 'OTHER', keywords: ['오로라'] })).body;
    expect((await r.call('GET', '/api/exclusion-rules', undefined, { 'x-user': 'other' })).body.rules).toHaveLength(0);
    expect((await r.call('PATCH', `/api/exclusion-rules/${made.id}`, { active: false }, { 'x-user': 'other' })).status).toBe(404);
  });

  it('규칙 없는 buildItems 호출은 기존 동작과 같다', () => {
    expect(buildItems(JSON.parse(OUT)).every((i) => i.excludedReason === null)).toBe(true);
  });
});
