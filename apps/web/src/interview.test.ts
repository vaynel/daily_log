import { describe, expect, it } from 'vitest';
import { classifyMicError, describeLatency, describeStop, formatClock, micIsOn, nextPhase, PHASE_LABEL, remainingMs, summarizeLatency, type Phase } from './interview';

describe('마이크 오류 분류(AC-4)', () => {
  it('권한 거부·장치 없음·미지원·기타를 구분하고 거부는 서버 연결 없는 해결 안내로 이어진다', () => {
    expect(classifyMicError({ name: 'NotAllowedError' })).toBe('DENIED');
    expect(classifyMicError({ name: 'SecurityError' })).toBe('DENIED');
    expect(classifyMicError({ name: 'NotFoundError' })).toBe('NO_DEVICE');
    expect(classifyMicError({ name: 'TypeError' })).toBe('UNSUPPORTED');
    expect(classifyMicError(new Error('boom'))).toBe('FAILED');
    expect(classifyMicError(null)).toBe('FAILED');
  });
});

describe('종료 사유별 안내와 이어하기 가능 여부', () => {
  it('일시정지·연결 끊김·BUSY 는 이어할 수 있고, 끝내기·상한·하루 1회는 이어할 수 없다', () => {
    for (const r of ['USER_PAUSE', 'LIVE_CLOSED', 'LIVE_CONNECT', 'CONNECTION_LOST', 'BUSY', 'CONTEXT']) expect(describeStop(r).resumable, r).toBe(true);
    for (const r of ['USER_END', 'TIME_LIMIT', 'COST_LIMIT', 'DAILY_LIMIT', 'CONFIRMED', 'BUDGET', 'LIVE_AUTH']) expect(describeStop(r).resumable, r).toBe(false);
  });
  it('연결이 끊기면 저장된 내용이 남아 있음과 해결 행동을 알린다', () => {
    const s = describeStop('LIVE_CLOSED');
    expect(s.title).toContain('끊어졌습니다');
    expect(s.action).toContain('저장되어 있습니다');
    expect(s.action).toContain('다시 연결');
  });
  it('알 수 없는 사유도 해결 행동이 있다', () => {
    expect(describeStop('???').action).toContain('다시 연결');
  });
});

describe('단계 전이와 마이크 표시', () => {
  it('ready→듣는 중, first_audio→말하는 중, 끼어들기→듣는 중, stopped→사유별 단계', () => {
    expect(nextPhase('connecting', { type: 'ready' }, false)).toBe('listening');
    expect(nextPhase('listening', { type: 'first_audio' }, false)).toBe('speaking');
    expect(nextPhase('speaking', { type: 'interrupted' }, true)).toBe('listening');
    expect(nextPhase('speaking', { type: 'turn' }, true)).toBe('speaking');
    expect(nextPhase('speaking', { type: 'turn' }, false)).toBe('listening');
    expect(nextPhase('listening', { type: 'stopped', reason: 'USER_PAUSE' }, false)).toBe('paused');
    expect(nextPhase('listening', { type: 'stopped', reason: 'TIME_LIMIT' }, false)).toBe('ended');
    expect(nextPhase('idle', { type: 'stopped', reason: 'DAILY_LIMIT' }, false)).toBe('blocked');
    expect(nextPhase('listening', { type: 'unknown' }, false)).toBe('listening');
  });
  it('녹음 중 표시는 마이크가 켜진 단계에서만 켜진다(AC-2)', () => {
    const on: Phase[] = ['connecting', 'listening', 'thinking', 'speaking'];
    const off: Phase[] = ['idle', 'asking-mic', 'paused', 'ended', 'blocked'];
    on.forEach((p) => expect(micIsOn(p), p).toBe(true));
    off.forEach((p) => expect(micIsOn(p), p).toBe(false));
    expect(PHASE_LABEL.idle).toContain('마이크 꺼짐');
    expect(PHASE_LABEL.paused).toContain('마이크 꺼짐');
  });
});

describe('시간·지연 표시(AC-7)', () => {
  it('시계와 남은 시간', () => {
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(-5)).toBe('0:00');
    const limits = { maxMs: 600_000, wrapMs: 480_000, maxCostKrw: 700, wrapCostKrw: 560 };
    expect(remainingMs({ usedMs: 125_000, limits })).toBe(475_000);
    expect(remainingMs({ usedMs: 700_000, limits })).toBe(0);
  });
  it('턴별 단계 지연을 구분해 보여 주고 평균·최대를 낸다', () => {
    expect(describeLatency({ n: 2, latencyMs: 1380, upstreamLatencyMs: 1300, serverOverheadMs: 12 })).toBe('턴 2: 말 끝→첫 음성 1380ms · 음성 서비스 1300ms · 서버 12ms');
    expect(describeLatency({ n: 3, latencyMs: null, upstreamLatencyMs: null, serverOverheadMs: null })).toContain('측정 없음');
    expect(summarizeLatency([{ n: 1, latencyMs: 1000, upstreamLatencyMs: null, serverOverheadMs: null }, { n: 2, latencyMs: 2000, upstreamLatencyMs: null, serverOverheadMs: null }, { n: 3, latencyMs: null, upstreamLatencyMs: null, serverOverheadMs: null }]))
      .toEqual({ count: 2, avgMs: 1500, maxMs: 2000 });
    expect(summarizeLatency([])).toEqual({ count: 0, avgMs: null, maxMs: null });
  });
});
