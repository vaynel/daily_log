import { describe, expect, it } from 'vitest';
import {
  DeliveryLedger,
  completionKey,
  interviewKey,
  isConfirmedDelivered,
  livingDayOf,
  permissionGuidance,
  pushTopic,
  type Transport,
} from './policy';

const ok = (status: number, mock = false): Transport => ({ mock, send: async () => ({ httpStatus: status }) });
const granted = { permission: 'granted' as const, hasSubscription: true };

describe('living day', () => {
  it('uses Asia/Seoul calendar date, not UTC', () => {
    expect(livingDayOf(new Date('2026-10-20T13:00:00Z'))).toBe('2026-10-20'); // 22:00 KST
    expect(livingDayOf(new Date('2026-10-20T15:30:00Z'))).toBe('2026-10-21'); // 00:30 KST next day
  });
});

describe('dedupe', () => {
  it('sends the interview reminder once per living day, even after failure', async () => {
    const l = new DeliveryLedger();
    const key = interviewKey({ userId: 'u1', livingDay: '2026-10-20' });
    expect((await l.dispatch(key, 'interview', granted, ok(500))).status).toBe('SEND_FAILED');
    expect((await l.dispatch(key, 'interview', granted, ok(201))).status).toBe('SKIPPED_DUPLICATE');
  });
  it('completion key is separate from the interview key', () => {
    expect(completionKey('u1', 'j9')).not.toBe(interviewKey({ userId: 'u1', livingDay: '2026-10-20' }));
  });
  it('push topic is stable and <= 32 url-safe chars', async () => {
    const t = await pushTopic('interview:u1:2026-10-20');
    expect(t).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(await pushTopic('interview:u1:2026-10-20')).toBe(t);
  });
});

describe('undeliverable is never recorded as delivered', () => {
  it.each([
    ['denied', { permission: 'denied' as const, hasSubscription: true }, 'SKIPPED_PERMISSION_DENIED'],
    ['default', { permission: 'default' as const, hasSubscription: false }, 'SKIPPED_PERMISSION_DENIED'],
    ['unsupported', { permission: 'unsupported' as const, hasSubscription: false }, 'SKIPPED_UNSUPPORTED'],
    ['no subscription', { permission: 'granted' as const, hasSubscription: false }, 'SKIPPED_NO_SUBSCRIPTION'],
  ])('%s', async (_n, ctx, status) => {
    const l = new DeliveryLedger();
    const rec = await l.dispatch('k', 'interview', ctx, ok(201));
    expect(rec.status).toBe(status);
    expect(isConfirmedDelivered(rec)).toBe(false);
  });
  it('410/404 expire subscription, 429/500 fail, thrown error fails', async () => {
    for (const [code, status] of [[410, 'SUBSCRIPTION_EXPIRED'], [404, 'SUBSCRIPTION_EXPIRED'], [429, 'SEND_FAILED'], [500, 'SEND_FAILED']] as const) {
      expect((await new DeliveryLedger().dispatch('k', 'interview', granted, ok(code))).status).toBe(status);
    }
    const boom: Transport = { mock: false, send: async () => { throw new Error('x'); } };
    expect((await new DeliveryLedger().dispatch('k', 'interview', granted, boom)).status).toBe('SEND_FAILED');
  });
  it('mock success is MOCK_ACCEPTED and can never be confirmed delivered', async () => {
    const l = new DeliveryLedger();
    const rec = await l.dispatch('k', 'interview', granted, ok(201, true));
    expect(rec.status).toBe('MOCK_ACCEPTED');
    l.confirmDisplayed('k');
    expect(isConfirmedDelivered(l.get('k')!)).toBe(false);
  });
  it('push-service accept is not delivery until the device acks display', async () => {
    const l = new DeliveryLedger();
    const rec = await l.dispatch('k', 'interview', granted, ok(201));
    expect(rec.status).toBe('PUSH_SERVICE_ACCEPTED');
    expect(isConfirmedDelivered(rec)).toBe(false);
    l.confirmDisplayed('k');
    expect(isConfirmedDelivered(l.get('k')!)).toBe(true);
  });
});

describe('permission guidance', () => {
  it('denied explains how to re-enable in settings', () => {
    const g = permissionGuidance('denied');
    expect(g.tone).toBe('blocked');
    expect(g.steps.join(' ')).toContain('설정');
  });
});
