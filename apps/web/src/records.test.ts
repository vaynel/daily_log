import { describe, expect, it } from 'vitest';
import { byLifeDate, fetchJson, initialMonth, monthGrid, shiftMonth, STATUS_INFO, type RecordRow } from './records.js';

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
