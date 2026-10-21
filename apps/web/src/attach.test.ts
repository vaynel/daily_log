import { describe, expect, it } from 'vitest';
import { describeCapture, precheck, uploadAttachment } from './attach.js';

const resp = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const blob = (n = 5, type = 'image/jpeg') => new Blob([new Uint8Array(n)], { type });
const base = { recordId: 'r1', kind: 'PHOTO' as const, key: 'k1', name: '사진.jpg' };

describe('uploadAttachment', () => {
  it('201/200 응답일 때만 done, 중복·촬영 시각을 전달', async () => {
    const r = await uploadAttachment({ ...base, body: blob() }, resp(201, { duplicate: false, capturedAt: null, capturedSource: null }) as never);
    expect(r).toMatchObject({ ok: true, status: 'done', duplicate: false, capturedAt: null });
    const d = await uploadAttachment({ ...base, body: blob() }, resp(200, { duplicate: true }) as never);
    expect(d).toMatchObject({ ok: true, duplicate: true });
  });
  it('손상 파일(422)은 성공이 아니며 다시 시도 대상도 아님', async () => {
    const r = await uploadAttachment({ ...base, body: blob() }, resp(422, { error: 'UNREADABLE_FILE' }) as never);
    expect(r).toMatchObject({ ok: false, status: 'failed', retryable: false });
    expect(r.message).toContain('읽을 수 없어');
  });
  it('네트워크 오류는 failed+재시도 가능, 중단은 canceled', async () => {
    const net = await uploadAttachment({ ...base, body: blob() }, (async () => { throw new TypeError('fetch failed'); }) as never);
    expect(net).toMatchObject({ ok: false, status: 'failed', retryable: true });
    const abort = await uploadAttachment({ ...base, body: blob() }, (async () => { throw new DOMException('x', 'AbortError'); }) as never);
    expect(abort).toMatchObject({ ok: false, status: 'canceled', retryable: true });
  });
  it('200 인데 본문이 깨졌으면 성공으로 표시하지 않는다', async () => {
    const r = await uploadAttachment({ ...base, body: blob() }, (async () => new Response('<html>', { status: 200 })) as never);
    expect(r.ok).toBe(false);
  });
  it('요청 헤더에 고정 키·종류·인코딩된 파일명', async () => {
    let seen: RequestInit | undefined;
    await uploadAttachment({ ...base, body: blob() }, (async (_u: string, init: RequestInit) => { seen = init; return new Response('{}', { status: 201 }); }) as never);
    expect(seen?.headers).toMatchObject({ 'x-idempotency-key': 'k1', 'x-attachment-kind': 'PHOTO', 'x-file-name': encodeURIComponent('사진.jpg') });
  });
  it('큰 파일·형식 오류는 서버를 부르지 않고 안내', async () => {
    let called = false;
    const f = (async () => { called = true; return new Response('{}'); }) as never;
    expect((await uploadAttachment({ ...base, body: blob(10 * 1024 * 1024 + 1) }, f)).message).toContain('너무 큽니다');
    expect((await uploadAttachment({ ...base, kind: 'MARKDOWN', name: 'a.exe', body: blob(3, '') }, f)).ok).toBe(false);
    expect(called).toBe(false);
    expect(precheck('NOTE', { name: 'n', size: 0 })).toContain('비어');
  });
});

describe('describeCapture (AC-4)', () => {
  it('촬영 시각이 없으면 알 수 없음', () => {
    expect(describeCapture(null)).toBe('촬영 시각 알 수 없음');
    expect(describeCapture(undefined)).toBe('촬영 시각 알 수 없음');
  });
  it('추정 시간대는 표시', () => {
    expect(describeCapture('2026-10-21T00:00:00.000Z', 'EXIF_ASSUMED_KST')).toContain('추정');
    expect(describeCapture('2026-10-21T00:00:00.000Z', 'EXIF')).not.toContain('추정');
  });
});
