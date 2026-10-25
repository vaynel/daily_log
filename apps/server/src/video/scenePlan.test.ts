import { describe, expect, it } from 'vitest';
import { planOf, type BriefingItem } from '../briefing/briefing.js';
import { MemBriefingRecords, B_ID, B_OWNER } from '../briefing/memory.testutil.js';
import { assignTime, buildScenePlan, condense, estimateSec, MAX_TOTAL_SEC, parseDrafts, DEFAULT_NARRATION, type PhotoRef, type Scene } from './scenePlan.js';
import { latestScenePlan, runScenePlanStage, type SceneRecords } from './sceneStage.js';

const item = (n: number, text: string, emphasis = false): BriefingItem => ({ id: `s${n}`, kind: 'FACT', source: 'USER', text, emphasis, inVideo: true, excludedReason: null });
const plan = planOf([item(1, '아침에 에코 버그를 고쳤다'), item(2, '오늘 제일 뿌듯한 건 배포였다', true), item(3, '점심 뒤에 SQL 인젝션 예방을 공부했다')], 2);
const scene = (d: object) => ({ type: 'DAILY', narration: '버그를 고쳤다.', visual: '책상 앞의 캐릭터', evidenceIds: ['s1'], photoId: null, ...d });
const ok = (arr: object[]) => async () => ({ state: 'SUCCEEDED', text: JSON.stringify(arr) });
const LIFE = '2026-10-25';

describe('근거 연결 (AC-1)', () => {
  it('모든 장면이 확정 기록 id 를 가지며 없는 id·빈 근거는 거절한다', () => {
    expect(parseDrafts(JSON.stringify([scene({ evidenceIds: [] })]), plan, [])).toMatchObject({ ok: false, code: 'NO_EVIDENCE' });
    expect(parseDrafts(JSON.stringify([scene({ evidenceIds: ['s9'] })]), plan, [])).toMatchObject({ ok: false, code: 'UNKNOWN_EVIDENCE' });
    expect(parseDrafts(JSON.stringify([scene({ photoId: 'zzz' })]), plan, [])).toMatchObject({ ok: false, code: 'UNKNOWN_PHOTO' });
  });
  it('장면별 근거 id 가 그대로 저장되고 순서는 말한 순서를 따른다', async () => {
    const r = await buildScenePlan({ plan, photos: [], lifeDate: LIFE, infer: ok([
      scene({ narration: '배포가 제일 뿌듯했다.', evidenceIds: ['s2'] }), scene({ narration: '아침에 버그를 고쳤다.' }),
    ]) });
    expect(r.ok && r.plan.scenes.map((s) => [s.order, s.evidenceIds])).toEqual([[1, ['s1']], [2, ['s2']]]);
  });
});

describe('강조 우선 (AC-2)', () => {
  it('180초 초과 시 강조 장면이 남고 강조가 아닌 장면이 먼저 빠진다', () => {
    const mk = (n: number, emphasis: boolean): Scene => ({ key: `sc${n}`, order: n, type: 'DAILY', narration: 'x', visual: 'v', evidenceIds: ['s1'], photoId: null, timeStatus: 'NONE', estimated: false, emphasis, estimatedSec: 100 });
    const { scenes, condensed } = condense([mk(1, false), mk(2, false), mk(3, true)], DEFAULT_NARRATION);
    expect(scenes.map((s) => s.key)).toEqual(['sc3']);
    expect(scenes[0]!.order).toBe(1);
    expect(condensed!.droppedKeys).toEqual(['sc2', 'sc1']);
  });
  it('강조 항목 장면은 emphasis 로 표시된다', async () => {
    const r = await buildScenePlan({ plan, photos: [], lifeDate: LIFE, infer: ok([scene({ narration: '배포가 제일 뿌듯했다.', evidenceIds: ['s2'] })]) });
    expect(r.ok && r.plan.scenes[0]!.emphasis).toBe(true);
  });
});

describe('메타데이터 경계 (AC-3)', () => {
  const at = (iso: string): Date => new Date(iso);
  const photos: PhotoRef[] = [
    { id: 'p-none', capturedAt: null }, { id: 'p-ok', capturedAt: at('2026-10-25T10:00:00+09:00') },
    { id: 'p-other-day', capturedAt: at('2026-10-20T10:00:00+09:00') }, { id: 'p-late', capturedAt: at('2026-10-25T20:00:00+09:00') },
  ];
  const draft = (photoId: string, evidenceIds: string[]) => ({ type: 'DAILY' as const, narration: 'n', visual: 'v', evidenceIds, photoId });
  it('촬영 시각 없음→UNKNOWN, 다른 날→CONFLICT, 그날→CONFIRMED, 사진 없음→NONE', () => {
    const rows = assignTime([draft('p-none', ['s1']), draft('p-other-day', ['s2']), draft('p-ok', ['s3']), { ...draft('p-ok', ['s3']), photoId: null }], plan, photos, LIFE);
    expect(rows.map((r) => r.timeStatus)).toEqual(['UNKNOWN', 'CONFLICT', 'CONFIRMED', 'NONE']);
  });
  it('말한 순서와 촬영 순서가 반대면 둘 다 CONFLICT 로 두고 말한 순서를 유지한다', () => {
    const rows = assignTime([draft('p-late', ['s1']), draft('p-ok', ['s2'])], plan, photos, LIFE);
    expect(rows.map((r) => [r.draft.evidenceIds[0], r.timeStatus])).toEqual([['s1', 'CONFLICT'], ['s2', 'CONFLICT']]);
  });
  it('시각 불명·충돌 장면은 estimated 로 표시된다', async () => {
    const r = await buildScenePlan({ plan, photos, lifeDate: LIFE, infer: ok([scene({ photoId: 'p-none' }), scene({ photoId: 'p-other-day', evidenceIds: ['s2'], narration: '배포했다.' })]) });
    expect(r.ok && r.plan.scenes.map((s) => [s.timeStatus, s.estimated])).toEqual([['UNKNOWN', true], ['CONFLICT', true]]);
  });
  it('근거 문장에 없는 시각 표현을 대사에 쓰면 거절하고, 근거에 있는 시각은 허용한다', () => {
    expect(parseDrafts(JSON.stringify([scene({ narration: '저녁에 버그를 고쳤다.' })]), plan, [])).toMatchObject({ ok: false, code: 'UNVERIFIED_TIME' });
    expect(parseDrafts(JSON.stringify([scene({ narration: '아침에 버그를 고쳤다.' })]), plan, [])).toMatchObject({ ok: true });
  });
  it('시각 표현 위반은 한 번만 다시 호출하고 계속되면 BAD_OUTPUT', async () => {
    let n = 0;
    const r = await buildScenePlan({ plan, photos: [], lifeDate: LIFE, infer: async () => { n++; return { state: 'SUCCEEDED', text: JSON.stringify([scene({ narration: '밤 11시에 고쳤다.' })]) }; } });
    expect(r).toMatchObject({ ok: false, code: 'BAD_OUTPUT', detail: 'UNVERIFIED_TIME', proCalls: 2 });
    expect(n).toBe(2);
  });
});

describe('짧은 기록 (AC-4)', () => {
  const short = planOf([item(1, '오늘은 산책을 했다')], 1);
  it('분량을 채우려 늘린 대사를 거절한다', () => {
    const padded = '산책을 하면서 바람이 시원했고 하늘이 맑았으며 새소리가 들렸고 마음이 한결 가벼워졌다. 오래 걸으니 다리가 뻐근했지만 상쾌했다.';
    expect(parseDrafts(JSON.stringify([scene({ narration: padded })]), short, [])).toMatchObject({ ok: false, code: 'PADDED' });
  });
  it('기록 1건은 3분을 채우지 않고 shortRecord 로 둔다', async () => {
    const r = await buildScenePlan({ plan: short, photos: [], lifeDate: LIFE, infer: ok([scene({ narration: '오늘은 산책을 했다.' })]) });
    expect(r.ok && r.plan.scenes).toHaveLength(1);
    expect(r.ok && r.plan.totalSec).toBeLessThan(15);
    expect(r.ok && r.plan.shortRecord).toBe(true);
  });
  it('제작 입력이 비면 Pro 를 부르지 않는다', async () => {
    let n = 0;
    const r = await buildScenePlan({ plan: planOf([], 1), photos: [], lifeDate: LIFE, infer: async () => { n++; return { state: 'SUCCEEDED', text: '[]' }; } });
    expect(r).toMatchObject({ ok: false, code: 'NO_CONTENT', proCalls: 0 });
    expect(n).toBe(0);
  });
});

describe('180초 길이 검증 (AC-5)', () => {
  it('초과하면 합성 전에 축약하고 합계는 180초 이하', async () => {
    const long = planOf(Array.from({ length: 6 }, (_, i) => item(i + 1, `하루의 일 ${i + 1}번째로 ${'길게 설명할 만한 일을 했다 '.repeat(6)}`)), 1);
    const narr = '이 일을 하면서 천천히 하루를 보냈다. '.repeat(14);
    const r = await buildScenePlan({ plan: long, photos: [], lifeDate: LIFE, infer: ok(long.items.map((i) => scene({ narration: narr, evidenceIds: [i.id] }))) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.condensed!.beforeSec).toBeGreaterThan(MAX_TOTAL_SEC);
    expect(r.plan.totalSec).toBeLessThanOrEqual(MAX_TOTAL_SEC);
    expect(r.plan.scenes.length).toBeLessThan(6);
    expect(r.plan.scenes.map((s) => s.order)).toEqual(r.plan.scenes.map((_, i) => i + 1));
  });
  it('장면 하나가 단독으로 넘어도 문장 단위로 줄인다', () => {
    const narration = '한 문장이다. '.repeat(200);
    const s: Scene = { key: 'sc1', order: 1, type: 'DAILY', narration, visual: 'v', evidenceIds: ['s1'], photoId: null, timeStatus: 'NONE', estimated: false, emphasis: false, estimatedSec: estimateSec(narration, 5) };
    expect(s.estimatedSec).toBeGreaterThan(180);
    const r = condense([s], DEFAULT_NARRATION);
    expect(r.scenes[0]!.estimatedSec).toBeLessThanOrEqual(180);
    expect(r.condensed!.truncatedKeys).toEqual(['sc1']);
  });
  it('180초 이하이면 그대로 둔다', () => {
    const s: Scene = { key: 'sc1', order: 1, type: 'DAILY', narration: 'x', visual: 'v', evidenceIds: ['s1'], photoId: null, timeStatus: 'NONE', estimated: false, emphasis: false, estimatedSec: 10 };
    expect(condense([s], DEFAULT_NARRATION)).toEqual({ scenes: [s], condensed: null });
  });
});

describe('Pro 대기·설정값', () => {
  it('대기 상태는 유료 전환 없이 그대로 돌려주고 재호출하지 않는다', async () => {
    let n = 0;
    const r = await buildScenePlan({ plan, photos: [], lifeDate: LIFE, infer: async () => { n++; return { state: 'WAIT_LIMIT' }; } });
    expect(r).toMatchObject({ ok: false, code: 'PRO_WAITING', state: 'WAIT_LIMIT', proCalls: 1 });
    expect(n).toBe(1);
  });
  it('voiceName·스타일 지시는 설정값으로 계획에 저장된다', async () => {
    const r = await buildScenePlan({ plan, photos: [], lifeDate: LIFE, infer: ok([scene({})]), narration: { voiceName: 'Zubenelgenubi' } });
    expect(r.ok && r.plan.narration).toMatchObject({ character: 'A', voiceName: 'Zubenelgenubi' });
    expect(DEFAULT_NARRATION.voiceName).toBe('Achird');
  });
});

describe('단계 저장 (D21-04)', () => {
  class Rec extends MemBriefingRecords implements SceneRecords {
    photos: { id: string; kind: string; capturedAt: Date | null }[] = [];
    async listAttachments() { return this.photos; }
  }
  const confirmed = () => {
    const r = new Rec();
    r.status = 'CONFIRMED';
    r.versions.push({ kind: 'PRODUCTION_PLAN', version: 1, content: plan });
    return r;
  };
  it('확인된 계획으로 장면 계획을 버전으로 저장하고 같은 브리핑에서는 Pro 를 다시 부르지 않는다', async () => {
    const r = confirmed();
    r.photos = [{ id: 'p1', kind: 'PHOTO', capturedAt: null }, { id: 'm1', kind: 'MARKDOWN', capturedAt: null }];
    let n = 0;
    const infer = async () => { n++; return { state: 'SUCCEEDED', text: JSON.stringify([scene({ photoId: 'p1' })]) }; };
    const a = await runScenePlanStage({ records: r, ownerId: B_OWNER, interviewId: B_ID, infer });
    expect(a).toMatchObject({ ok: true, version: 2, duplicate: false });
    const snap = (await r.loadById(B_OWNER, B_ID))!;
    expect(latestScenePlan(snap)!.plan).toMatchObject({ briefingVersion: 2, scenes: [{ timeStatus: 'UNKNOWN', estimated: true, evidenceIds: ['s1'] }] });
    const b = await runScenePlanStage({ records: r, ownerId: B_OWNER, interviewId: B_ID, infer });
    expect(b).toMatchObject({ ok: true, version: 2, duplicate: true });
    expect(n).toBe(1);
  });
  it('확인 전·Pro 미설정·대기에서는 저장하지 않는다', async () => {
    const r = new Rec();
    expect(await runScenePlanStage({ records: r, ownerId: B_OWNER, interviewId: B_ID, infer: ok([scene({})]) })).toMatchObject({ ok: false, code: 'NOT_CONFIRMED' });
    const c = confirmed();
    expect(await runScenePlanStage({ records: c, ownerId: B_OWNER, interviewId: B_ID, infer: null })).toMatchObject({ ok: false, code: 'PRO_UNAVAILABLE' });
    expect(await runScenePlanStage({ records: c, ownerId: B_OWNER, interviewId: B_ID, infer: async () => ({ state: 'WAIT_AUTH' }) })).toMatchObject({ ok: false, code: 'PRO_WAITING', state: 'WAIT_AUTH' });
    expect(c.versions.filter((v) => v.kind === 'PRODUCTION_PLAN')).toHaveLength(1);
  });
});
