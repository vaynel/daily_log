import { describe, expect, it } from 'vitest';
import type { AudioView } from '../records/store.js';
import { describeAudioExpiry } from './view.js';

const seg = (status: AudioView['status']): AudioView => ({ id: 'a', firstSavedAt: new Date('2026-09-01T00:00:00Z'), expiresAt: new Date('2026-10-01T00:00:00Z'), status, recovered: status !== 'EXPIRED' });

describe('AC-6 만료 안내', () => {
  it('만료 구간이 없으면 안내하지 않는다', () => {
    expect(describeAudioExpiry([seg('UNPROCESSED'), seg('PROCESSED')], { items: 3, attachments: 1 }, 'NONE')).toBeNull();
    expect(describeAudioExpiry([], { items: 0, attachments: 0 }, undefined)).toBeNull();
  });
  it('재개 불가 사유와 실제 보존 건수를 알리고 복구된 것처럼 말하지 않는다', () => {
    const n = describeAudioExpiry([seg('EXPIRED'), seg('INTERRUPTED'), seg('EXPIRED')], { items: 4, attachments: 2 }, 'NONE')!;
    expect(n.expiredCount).toBe(2);
    expect(n.message).toContain('보관 기간(한 달)');
    expect(n.message).toContain('이어서 들을 수 없습니다');
    expect(n.message).toContain('저장된 글 4개와 첨부 2개');
    expect(n.message).toContain('Drive 백업 대상이 아닙니다');
    expect(n.speech).toContain('이어갈 수 없습니다');
    expect(n.message).not.toMatch(/복구되었|복원되었/);
  });
  it('백업 상태별로 서버 정리 안내가 실제 상태와 일치한다', () => {
    const f = (b: 'NONE' | 'PENDING' | 'VERIFIED' | 'FAILED') => describeAudioExpiry([seg('EXPIRED')], { items: 1, attachments: 0 }, b)!.message;
    expect(f('VERIFIED')).toContain('백업이 확인되었습니다');
    expect(f('VERIFIED')).toContain('정리될 수 있고');
    for (const b of ['NONE', 'PENDING', 'FAILED'] as const) expect(f(b)).toContain('정리되지 않고 유지됩니다');
    expect(f('FAILED')).toContain('실패');
    expect(f('PENDING')).toContain('대기');
  });
  it('남은 글·첨부가 없으면 없다고 말한다', () => {
    expect(describeAudioExpiry([seg('EXPIRED')], { items: 0, attachments: 0 }, 'NONE')!.message).toContain('남아 있는 글과 첨부는 없습니다');
  });
});
