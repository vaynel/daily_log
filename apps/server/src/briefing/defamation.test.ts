import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionClaims } from '../auth/session.js';
import { MemoryLiveUsageStore } from '../interview/usage.js';
import { applyCorrection, buildItems, planOf } from './briefing.js';
import { B_ID, B_OWNER, MemBriefingRecords } from './memory.testutil.js';
import { briefingContent, registerBriefing } from './routes.js';
import { MemoryRuleStore } from './rules.js';

const item = (text: string) => buildItems([{ kind: 'FACT', source: 'USER', text }]);

describe('TASK-145 기술 대상과 사람 대상 구분', () => {
  it.each([
    '쓰레기 코드를 리팩터링했다', '쓰레기 수집(GC)을 공부했다',
    '멍청한 설계를 개선했다', '한심한 구조를 바꿨다', '무능한 로직을 교체했다',
    '멍청한 함수를 수정했다', '쓰레기 데이터를 정리했다', '쓰레기 수집기를 구현했다',
    '쓰레기 커밋을 정리했다', '멍청한 쿼리를 최적화했다', '한심한 테스트를 보완했다',
    '코드가 정말 쓰레기라 리팩터링했다', '설계는 한심했다',
  ])('기술 문장은 영상 후보에 남는다: %s', (text) => {
    expect(item(text)[0]).toMatchObject({ inVideo: true, excludedReason: null });
  });
  it.each([
    '저 사람 진짜 멍청하다', '팀장은 무능해서 회의가 길었다', '그 동료는 쓰레기다',
    '그 사람 참 한심하다', '저 놈은 병신이다', '저 미친 놈 때문에 힘들었다',
    '쓰레기 코드를 고쳤지만 팀장은 멍청하다', '코드를 짠 사람은 쓰레기다',
    '멍청한 코드 작성자 때문에 고생했다', '쓰레기 데이터를 정리했다. 그 동료는 한심하다',
    '그 사람은 쓰레기, 코드를 고쳤다',
    '쓰레기 코드를 짠 김대리', '한심한 코드를 짠 동료', '쓰레기 코드를 만든 놈', '쓰레기 구조를 만든 팀장님',
    '쓰레기 코드를 쓴 사람', '한심한 코드 리뷰어', '쓰레기 코드를 짜놓고 모른 척하는 선배',
  ])('사람 비방은 기본 제외한다: %s', (text) => {
    expect(item(text)[0]).toMatchObject({ inVideo: false, excludedReason: 'DEFAMATION' });
  });
});

describe('TASK-145 INCLUDE 경계', () => {
  it('DEFAMATION 포함 요청을 제작 입력에 반영한다', () => {
    const res = applyCorrection(item('멍청한 녀석이라고 쓴 테스트 문구를 읽었다'), { itemId: 's1', action: 'INCLUDE' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(planOf(res.items, 2).lines).toEqual(['멍청한 녀석이라고 쓴 테스트 문구를 읽었다']);
  });
  it.each(['선거 이야기를 했다', '형사 소송을 알아봤다', '동료 뒷담화를 했다', '쓰레기 같은 동료 뒷담화를 했다'])('다른 제외 사유는 포함 불가: %s', (text) => {
    expect(applyCorrection(item(text), { itemId: 's1', action: 'INCLUDE' })).toEqual({ ok: false, code: 'NOT_ALLOWED' });
  });
  it('DEFAMATION 복원이 사용자 반복 제외 규칙을 우회하지 않는다', async () => {
    const rules = new MemoryRuleStore();
    await rules.create(B_OWNER, { category: 'OTHER', keywords: ['팀장'] }, new Date());
    expect(applyCorrection(item('팀장은 무능하다'), { itemId: 's1', action: 'INCLUDE' }, await rules.list(B_OWNER)))
      .toEqual({ ok: false, code: 'NOT_ALLOWED' });
  });
  it('포함한 문장을 다시 쓰면 비방 분류를 다시 적용한다', () => {
    const included = applyCorrection(item('저 사람은 멍청하다'), { itemId: 's1', action: 'INCLUDE' });
    expect(included.ok).toBe(true);
    if (!included.ok) return;
    const replaced = applyCorrection(included.items, { itemId: 's1', action: 'REPLACE', text: '저 사람은 한심하다' });
    expect(replaced.ok && replaced.changed).toMatchObject({ inVideo: false, excludedReason: 'DEFAMATION' });
  });
  it('저장된 DEFAMATION 오탐도 복원하고 결정과 이전 버전을 보존한다', async () => {
    const records = new MemBriefingRecords();
    const items = item('쓰레기 코드를 리팩터링했다');
    items[0] = { ...items[0]!, inVideo: false, excludedReason: 'DEFAMATION' };
    await records.appendVersion(B_OWNER, B_ID, 'SUMMARY', briefingContent(items));
    const app = Fastify();
    app.addHook('onRequest', async (req) => { (req as unknown as { user: SessionClaims }).user = { sub: B_OWNER, email: 'test@example.test', iat: 0, exp: 9e9 }; });
    registerBriefing(app, { records, usage: new MemoryLiveUsageStore(), infer: null });
    try {
      const r = await app.inject({ method: 'POST', url: `/api/briefing/${B_ID}/correct`, payload: { version: 1, itemId: 's1', action: 'INCLUDE' } });
      expect(r.statusCode).toBe(200);
      expect(r.json().video).toEqual([{ id: 's1', text: '쓰레기 코드를 리팩터링했다' }]);
      expect(records.versions[0]!.content).toMatchObject({ items: [{ excludedReason: 'DEFAMATION' }] });
      expect(records.versions[1]!.content).toMatchObject({ correction: { itemId: 's1', action: 'INCLUDE', previousExcludedReason: 'DEFAMATION' } });
      const reloaded = await app.inject({ method: 'GET', url: `/api/briefing/${B_ID}` });
      expect(reloaded.json().video).toEqual(r.json().video);
    } finally { await app.close(); }
  });
});
