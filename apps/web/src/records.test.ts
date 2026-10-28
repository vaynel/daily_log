import { describe, expect, it } from 'vitest';
import { byLifeDate, coversMonth, fetchJson, initialMonth, monthGrid, PAGE_SIZE, recordsUrl, shiftMonth, STATUS_INFO, type RecordRow } from './records.js';

const res = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fetchJson', () => {
  it('401 은 접근 만료, 404 는 찾을 수 없음, 5xx·네트워크 오류는 일반 오류로 구분', async () => {
    expect(await fetchJson('/x', res(401))).toEqual({ state: 'expired' });
    expect(await fetchJson('/x', res(404))).toEqual({ state: 'not-found' });
    expect(await fetchJson('/x', res(500))).toEqual({ state: 'error' });
    expect(await fetchJson('/x', (async () => { throw new TypeError('x'); }) as never)).toEqual({ state: 'error' });
    expect(await fetchJson('/x', res(200, { a: 1 }))).toEqual({ state: 'ok', data: { a: 1 } });
  });
});

describe('STATUS_INFO', () => {
  it('정상 완료만 ok 톤이고 라벨이 모두 다르다', () => {
    const entries = Object.entries(STATUS_INFO);
    expect(entries.filter(([, v]) => v.tone === 'ok').map(([k]) => k)).toEqual(['COMPLETED']);
    expect(new Set(entries.map(([, v]) => v.label)).size).toBe(entries.length);
  });
});

const row = (id: string, lifeDate: string): RecordRow => ({ id, lifeDate, status: 'COMPLETED', pipeline: { production: 'DONE', review: 'PASSED', backup: 'NONE' }, hasResult: true, attachmentCount: 0 });

describe('달력 계산', () => {
  it('월 이동은 연도 경계를 넘는다', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', 0)).toBe('2026-10');
  });
  it('월 격자: 일요일 시작, 7칸 단위, 윤년 2월과 월 경계 날짜가 정확하다', () => {
    const g = monthGrid('2024-02'); // 2024-02-01 은 목요일, 29일까지
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0]!.findIndex((c) => c.date === '2024-02-01')).toBe(4);
    const dates = g.flat().filter((c) => c.date).map((c) => c.date);
    expect(dates).toHaveLength(29);
    expect(dates.at(-1)).toBe('2024-02-29');
    expect(monthGrid('2026-02').flat().filter((c) => c.date)).toHaveLength(28);
  });
  it('생활일 키로만 배치한다: 늦게 완성돼도 원래 생활일 칸에 놓이고 다른 날짜 칸은 비어 있다', () => {
    const m = byLifeDate([row('late', '2026-09-30'), row('a', '2026-10-01')]);
    expect(m.get('2026-09-30')?.id).toBe('late');
    expect(m.get('2026-10-01')?.id).toBe('a');
    expect(m.has('2026-10-02')).toBe(false);
  });
  it('처음 달은 가장 최근 생활일의 달, 기록이 없으면 오늘의 달', () => {
    expect(initialMonth([row('a', '2026-08-31'), row('b', '2026-09-01')])).toBe('2026-09');
    expect(initialMonth([], new Date(2026, 0, 5))).toBe('2026-01');
  });
});

describe('목록 페이지 나누기 보조', () => {
  it('recordsUrl: 첫 페이지는 cursor 없이, 이후는 인코딩된 cursor', () => {
    expect(recordsUrl(null)).toBe(`/api/records?limit=${PAGE_SIZE}`);
    expect(recordsUrl('2026-10-01')).toBe(`/api/records?limit=${PAGE_SIZE}&cursor=2026-10-01`);
  });
  it('coversMonth: 다음 페이지가 없거나 가장 오래된 행이 달 첫날 이전이면 충분', () => {
    const rows = [row('a', '2026-10-20'), row('b', '2026-09-15')];
    expect(coversMonth(rows, null, '2026-01')).toBe(true);
    expect(coversMonth(rows, 'c', '2026-10')).toBe(true);
    expect(coversMonth(rows, 'c', '2026-09')).toBe(false); // 9/15 까지만 불러와 9/1~9/14 가 아직 없다
    expect(coversMonth([...rows, row('z', '2026-08-31')], 'c', '2026-09')).toBe(true);
    expect(coversMonth(rows, 'c', '2026-08')).toBe(false);
    expect(coversMonth([], 'c', '2026-08')).toBe(false);
  });
  it('결과 파일 없음은 ok 가 아닌 경고 톤', () => {
    expect(STATUS_INFO.RESULT_FILE_MISSING).toMatchObject({ label: '결과 파일 없음', tone: 'warn' });
    expect(STATUS_INFO.RESULT_FILE_MISSING.hint).not.toContain('제작과 검수가 끝났습니다');
  });
});

import { resultProblem, sendRevision, versionLabel } from './records.js';

describe('결과 확인 화면 규칙 (TASK-28)', () => {
  it('이전 버전은 수정 전 상태와 관계없이 "완료"로 표시하지 않는다', () => {
    const base = { role: 'PREVIOUS' as const, status: 'SUPERSEDED' as const, fileAvailable: true, downloadable: true };
    expect(versionLabel({ version: 1, ...base, priorStatus: 'COMPLETED' })).toContain('이전 버전');
    expect(versionLabel({ version: 1, ...base, priorStatus: 'COMPLETED' })).not.toBe(STATUS_INFO.COMPLETED.label);
    expect(versionLabel({ version: 1, ...base, priorStatus: 'REVIEW_REJECTED' })).toContain('통과 못 함');
    expect(versionLabel({ version: 2, role: 'CURRENT', status: 'REVIEW_REJECTED', fileAvailable: true, downloadable: false })).toBe('검수 미통과');
  });
  it('파일 없음·미통과·실패는 각각 이유와 조치를 주고, 정상 완료는 문제 없음', () => {
    expect(resultProblem('RESULT_FILE_MISSING', false)?.reason).toContain('찾을 수 없어');
    expect(resultProblem('RESULT_FILE_MISSING', false)?.action).toContain('다시 만들');
    expect(resultProblem('REVIEW_REJECTED', true)?.reason).toContain('막았습니다');
    expect(resultProblem('FAILED', false)?.action).toContain('다시 시도');
    expect(resultProblem('COMPLETED', true)).toBeNull();
    const reasons = ['RESULT_FILE_MISSING', 'REVIEW_REJECTED', 'FAILED', 'REVIEW_PENDING'].map((s) => resultProblem(s as never, false)!.reason);
    expect(new Set(reasons).size).toBe(4);
  });
  it('수정 명령: 서버 거절·실행 안 함·연결 오류를 구분해 알려 준다', async () => {
    const body = { commandId: 'c1', kind: 'EXCLUDE' as const, itemId: 's1' };
    expect(await sendRevision('i', body, res(200, { executed: true, duplicate: false }))).toEqual({ state: 'done', duplicate: false });
    expect(await sendRevision('i', body, res(200, { executed: false, message: '지우지 않았습니다' }))).toEqual({ state: 'not-executed', message: '지우지 않았습니다' });
    expect(await sendRevision('i', body, res(409, { error: 'INVALID_STATE' }))).toMatchObject({ state: 'error', message: expect.stringContaining('진행 중') });
    expect(await sendRevision('i', body, res(401))).toMatchObject({ state: 'error', message: expect.stringContaining('다시 로그인') });
    expect(await sendRevision('i', body, (async () => { throw new TypeError('x'); }) as never)).toMatchObject({ state: 'error', message: expect.stringContaining('두 번 처리되지') });
  });
});
