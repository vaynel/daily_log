import { describe, expect, it } from 'vitest';
import { runProRequest, type ProbeContext } from './pro-request.js';

// These tests exercise the spike boundary, never a live account or a paid API.
const ready: ProbeContext = { support: 'verified', auth: 'valid', quota: 'available' };
const input = { kind: 'text', text: '합성 기록: 오늘 책을 10분 읽었다.' };

describe('subscription-only spike boundary', () => {
  it.each([
    [{}, 'WAIT_SUPPORT'],
    [{ ...ready, support: 'unknown' }, 'WAIT_SUPPORT'],
    [{ ...ready, support: 'unsupported' }, 'WAIT_SUPPORT'],
    [{ ...ready, auth: 'expired' }, 'WAIT_AUTH'],
    [{ ...ready, auth: 'unknown' }, 'WAIT_AUTH'],
    [{ ...ready, quota: 'exhausted' }, 'WAIT_LIMIT'],
    [{ ...ready, quota: 'unknown' }, 'WAIT_LIMIT'],
  ] as const)('blocks unverified prerequisites before any call: %j', async (context, state) => {
    let calls = 0;
    const result = await runProRequest(input, context, async () => { calls++; return { ok: true }; });
    expect(result.state).toBe(state);
    expect(calls).toBe(0);
  });

  it.each(['audio', 'video', 'unknown', '', 'image', 'file'])('rejects unvalidated input %s before sending', async kind => {
    let calls = 0;
    const result = await runProRequest({ kind, text: 'synthetic' }, ready, async () => { calls++; return { ok: true }; });
    expect(result.state).toBe('UNSUPPORTED_INPUT');
    expect(calls).toBe(0);
  });

  it('does not send empty text', async () => {
    let calls = 0;
    expect((await runProRequest({ kind: 'text', text: '  ' }, ready, async () => { calls++; return { ok: true }; })).state).toBe('UNSUPPORTED_INPUT');
    expect(calls).toBe(0);
  });

  it.each([
    [429, 'subscription_sharing_usage_limit_exceeded', 'WAIT_LIMIT'],
    [401, 'subscription_sharing_invalid_user', 'WAIT_AUTH'],
    [401, undefined, 'WAIT_AUTH'],
    [403, 'subscription_sharing_user_not_eligible', 'WAIT_SUPPORT'],
    [403, 'subscription_sharing_route_not_supported', 'WAIT_SUPPORT'],
    [400, 'subscription_sharing_unsupported_capability', 'UNSUPPORTED_INPUT'],
    [503, 'subscription_sharing_usage_unavailable', 'WAIT_RETRY'],
    [503, undefined, 'WAIT_RETRY'],
    [418, 'unexpected_secret_value', 'WAIT_REVIEW'],
  ] as const)('stops on %s/%s without retry or billing fallback', async (status, code, state) => {
    const calls: unknown[] = [];
    const result = await runProRequest(input, ready, async request => {
      calls.push(request);
      return { ok: false, status, code };
    });
    expect(result.state).toBe(state);
    expect(calls).toEqual([input]);
    expect(result).not.toHaveProperty('text');
    expect(JSON.stringify(result)).not.toContain('unexpected_secret_value');
  });

  it('returns success only for a completed transport response', async () => {
    const calls: unknown[] = [];
    expect(await runProRequest(input, ready, async request => {
      calls.push(request);
      return { ok: true };
    })).toEqual({ state: 'SUCCEEDED', attempts: 1 });
    expect(calls).toEqual([input]);
  });

  it('holds uncertain transport results for reconciliation, never retries or leaks errors', async () => {
    let calls = 0;
    const result = await runProRequest(input, ready, async () => {
      calls++;
      throw new Error('synthetic-private-content');
    });
    expect(result).toEqual({ state: 'WAIT_RECONCILIATION', attempts: 1 });
    expect(calls).toBe(1);
  });
});
