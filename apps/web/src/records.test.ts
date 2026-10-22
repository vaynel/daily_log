import { describe, expect, it } from 'vitest';
import { fetchJson, STATUS_INFO } from './records.js';

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
