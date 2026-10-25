import { describe, expect, it } from 'vitest';
import { createProInfer, waitReason, type SiwcRuntime } from './pro.js';

const ENV = { DAILY_LOG_SIWC_DIR: '/tmp/siwc', DAILY_LOG_VOICE_PRO_MODEL: 'pro-model', DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED: 'true' };

function mockRuntime(out: { state: string; text?: string }) {
  const calls: { store: unknown; input: { model: string; text: string }; opts: { supportVerified: boolean } }[] = [];
  const store = { id: 'store' };
  const load = async (dir: string): Promise<SiwcRuntime> => { loaded.push(dir); return { store, infer: async (s, input, opts) => { calls.push({ store: s, input, opts }); return out; } }; };
  const loaded: string[] = [];
  return { load, calls, loaded, store };
}

describe('브리핑 Pro 어댑터', () => {
  it('설정이 갖춰지면 구독 경로 infer 에 서버 모델·저장소·지원 확인을 넘긴다', async () => {
    const m = mockRuntime({ state: 'SUCCEEDED', text: 'ok' });
    const infer = await createProInfer(ENV, m.load);
    expect(infer).not.toBeNull();
    expect(await infer!({ text: '안녕' })).toEqual({ state: 'SUCCEEDED', text: 'ok' });
    expect(m.calls).toEqual([{ store: m.store, input: { model: 'pro-model', text: '안녕' }, opts: { supportVerified: true } }]);
    expect(m.loaded[0]).toMatch(/siwc$/);
  });

  it.each([
    ['DAILY_LOG_SIWC_DIR 없음', { ...ENV, DAILY_LOG_SIWC_DIR: '' }],
    ['모델 없음', { ...ENV, DAILY_LOG_VOICE_PRO_MODEL: ' ' }],
    ['지원 확인 없음', { ...ENV, DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED: undefined }],
    ['지원 확인 값이 true 가 아님', { ...ENV, DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED: '1' }],
  ])('%s 이면 null(PRO_UNAVAILABLE)로 fail closed 하고 로더를 부르지 않는다', async (_n, env) => {
    const m = mockRuntime({ state: 'SUCCEEDED', text: 'x' });
    expect(await createProInfer(env as NodeJS.ProcessEnv, m.load)).toBeNull();
    expect(m.loaded).toHaveLength(0);
  });

  it('SIWC 로드 실패도 null 로 막는다', async () => {
    expect(await createProInfer(ENV, async () => { throw new Error('boom'); })).toBeNull();
  });

  it('대기·한도 상태는 그대로 전달되고 사유 문구는 유료 전환이 없음을 알린다', async () => {
    const m = mockRuntime({ state: 'WAIT_LIMIT' });
    const infer = await createProInfer(ENV, m.load);
    expect(await infer!({ text: 'x' })).toEqual({ state: 'WAIT_LIMIT' });
    expect(waitReason('WAIT_LIMIT')).toContain('유료 모델로는 바꾸지 않습니다');
    expect(waitReason('WAIT_AUTH')).toContain('계정');
    expect(waitReason('이상한코드')).toContain('대기');
  });
});
