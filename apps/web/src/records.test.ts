import { describe, expect, it } from 'vitest';
import { cleanupReasonLabel, commandError, daysLeft, postCommand, remainingLabel, SCOPE_NOTICE, byLifeDate, coversMonth, fetchJson, initialMonth, monthGrid, PAGE_SIZE, recordsUrl, shiftMonth, STATUS_INFO, type RecordRow } from './records.js';

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

describe('휴지통 표시 규칙', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  it('남은 일수는 올림이고 보관 기간이 끝나면 0이며 복구 문구가 사라진다', () => {
    expect(daysLeft('2026-03-03T00:00:00Z', now)).toBe(30);
    expect(daysLeft('2026-02-01T00:00:01Z', now)).toBe(1);
    expect(daysLeft('2026-02-01T00:00:00Z', now)).toBe(0);
    expect(remainingLabel('2026-02-04T00:00:00Z', now)).toBe('3일 안에 복구할 수 있습니다');
    expect(remainingLabel('2026-01-31T00:00:00Z', now)).toContain('복구할 수 없습니다');
  });
  it('삭제 범위 안내는 서버 사본과 Drive 백업·완성 영상을 구분한다', () => {
    expect(SCOPE_NOTICE).toContain('서버에 있는 사본만');
    expect(SCOPE_NOTICE).toContain('Google Drive 백업과 완성 영상은 지워지지 않습니다');
  });
  it('명령 실패는 서버 오류 코드로 구분한다(만료·네트워크)', async () => {
    const f = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await postCommand('/x', {}, f(200, {}))).toEqual({ ok: true });
    expect(await postCommand('/x', {}, f(410, { error: 'TRASH_EXPIRED' }))).toEqual({ ok: false, code: 'TRASH_EXPIRED' });
    expect(await postCommand('/x', {}, f(401, {}))).toEqual({ ok: false, code: 'EXPIRED' });
    expect(await postCommand('/x', {}, (async () => { throw new TypeError('x'); }) as never)).toEqual({ ok: false, code: 'NETWORK' });
    expect(commandError('TRASH_EXPIRED')).toContain('30일');
    expect(cleanupReasonLabel('BACKUP_NOT_CURRENT')).toContain('백업');
  });
});
