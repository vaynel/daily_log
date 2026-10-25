import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, instructionWithHistory, limitPhase } from './limits.js';

describe('AC-8 세션 상한 경계', () => {
  const L = DEFAULT_LIMITS;
  it('기본값은 10분·700원, 근접은 8분·560원', () => {
    expect(L).toMatchObject({ maxMs: 600_000, wrapMs: 480_000, maxCostKrw: 700, wrapCostKrw: 560 });
  });
  it('시간 경계: 8분 직전 NORMAL, 8분 WRAP_UP, 10분 직전 WRAP_UP, 10분 TIME_LIMIT', () => {
    expect(limitPhase(L, 479_999, 0)).toBe('NORMAL');
    expect(limitPhase(L, 480_000, 0)).toBe('WRAP_UP');
    expect(limitPhase(L, 599_999, 0)).toBe('WRAP_UP');
    expect(limitPhase(L, 600_000, 0)).toBe('TIME_LIMIT');
  });
  it('비용 경계: 559.99 NORMAL, 560 WRAP_UP, 699.99 WRAP_UP, 700 COST_LIMIT', () => {
    expect(limitPhase(L, 0, 559.99)).toBe('NORMAL');
    expect(limitPhase(L, 0, 560)).toBe('WRAP_UP');
    expect(limitPhase(L, 0, 699.99)).toBe('WRAP_UP');
    expect(limitPhase(L, 0, 700)).toBe('COST_LIMIT');
  });
  it('둘이 겹치면 도달이 근접보다 우선하고 비용 도달이 먼저 판정된다', () => {
    expect(limitPhase(L, 600_000, 700)).toBe('COST_LIMIT');
    expect(limitPhase(L, 600_000, 100)).toBe('TIME_LIMIT');
    expect(limitPhase(L, 100, 600)).toBe('WRAP_UP');
  });
});

describe('이어하기 지시문', () => {
  it('기록이 없으면 원문 그대로', () => {
    expect(instructionWithHistory('BASE', [])).toBe('BASE');
  });
  it('사용자/인터뷰어 줄을 붙이고 오래된 줄부터 버려 길이를 제한한다', () => {
    const h = Array.from({ length: 200 }, (_, i) => ({ role: (i % 2 ? 'model' : 'user') as 'user' | 'model', text: `줄${i} ${'가'.repeat(40)}` }));
    const out = instructionWithHistory('BASE', h);
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('줄199');
    expect(out).not.toContain('줄0 ');
    expect(out.length).toBeLessThan(4000);
    expect(out).toContain('사용자: ');
    expect(out).toContain('인터뷰어: ');
  });
});
