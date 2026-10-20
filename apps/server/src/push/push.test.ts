import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPushConfig } from './config.js';
import { createHarness, syntheticSubscription } from './harness.js';

type H = Awaited<ReturnType<typeof createHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const put = (x: H, endpoint?: string) =>
  x.app.inject({ method: 'PUT', url: '/api/push/subscription', headers: x.auth, payload: syntheticSubscription(endpoint ?? `${x.fake.url}/s/1`) });
const test = (x: H, requestId: string) => x.app.inject({ method: 'POST', url: '/api/push/test', headers: x.auth, payload: { requestId } });

describe('접근 제어', () => {
  it('토큰 없음/변조/형식 오류는 401이고 상태·기록이 바뀌지 않는다', async () => {
    h = await createHarness();
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${h.token}x`, `Basic ${h.token}`, 'Bearer']) {
      const r = await h.app.inject({ method: 'POST', url: '/api/push/test', headers: authorization ? { authorization } : {}, payload: { requestId: 'abcdefgh1' } });
      expect(r.statusCode).toBe(401);
    }
    expect(h.fake.received).toHaveLength(0);
    expect(JSON.parse(await readFile(join(h.dir, 'state.json'), 'utf8').catch(() => '{"records":[]}')).records).toHaveLength(0);
  });

  it('인증 실패 10회 후에는 올바른 토큰도 429로 잠시 거부한다', async () => {
    h = await createHarness();
    for (let i = 0; i < 10; i++) await h.app.inject({ method: 'GET', url: '/api/push/status' });
    const r = await h.app.inject({ method: 'GET', url: '/api/push/status', headers: h.auth });
    expect(r.statusCode).toBe(429);
  });

  it('설정이 없으면 /api/push 는 503(fail closed)', async () => {
    const { buildApp } = await import('../app.js');
    const app = buildApp();
    const r = await app.inject({ method: 'GET', url: '/api/push/status', headers: { authorization: 'Bearer x' } });
    expect(r.statusCode).toBe(503);
    await app.close();
  });
});

describe('요청 검증', () => {
  it('허용되지 않은 endpoint·잘못된 키·과대 본문을 거부한다', async () => {
    h = await createHarness();
    for (const endpoint of ['https://evil.example/x', 'http://169.254.169.254/x', 'https://fcm.googleapis.com.evil.example/x', 'not a url', 'https://u:p@fcm.googleapis.com/x']) {
      const r = await put(h, endpoint);
      expect(r.statusCode, endpoint).toBe(400);
    }
    const bad = { ...syntheticSubscription(`${h.fake.url}/s`), keys: { p256dh: 'AAAA', auth: 'AAAA' } };
    expect((await h.app.inject({ method: 'PUT', url: '/api/push/subscription', headers: h.auth, payload: bad })).statusCode).toBe(400);
    const big = await h.app.inject({ method: 'PUT', url: '/api/push/observations', headers: h.auth, payload: { step: 'install', result: 'OK', note: 'x'.repeat(20000) } });
    expect(big.statusCode).toBe(413);
    expect((await h.app.inject({ method: 'PUT', url: '/api/push/observations', headers: h.auth, payload: { step: 'nope', result: 'OK' } })).statusCode).toBe(400);
    expect((await test(h, 'bad id!')).statusCode).toBe(400);
  });
});

describe('발송과 상태', () => {
  it('201은 PUSH_SERVICE_ACCEPTED일 뿐 전달 확인이 아니고, 표시 확인 후에만 DEVICE_DISPLAYED', async () => {
    h = await createHarness();
    await put(h);
    const r = (await test(h, 'req-00000001')).json();
    expect(r).toMatchObject({ status: 'PUSH_SERVICE_ACCEPTED', confirmedDelivered: false, duplicate: false });
    const req = h.fake.received[0]!;
    expect(req.headers.authorization).toMatch(/^vapid /);
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(req.headers.ttl).toBe('60');
    const ok = await h.app.inject({ method: 'POST', url: '/api/push/displayed', headers: h.auth, payload: { key: r.key } });
    expect(ok.json()).toEqual({ status: 'DEVICE_DISPLAYED' });
    const s = (await h.app.inject({ method: 'GET', url: '/api/push/status', headers: h.auth })).json();
    expect(s.records[0].confirmedDelivered).toBe(true);
  });

  it('같은 requestId 재요청은 재발송하지 않고, 쿨다운 안의 새 요청은 429', async () => {
    h = await createHarness();
    await put(h);
    await test(h, 'req-00000001');
    expect((await test(h, 'req-00000001')).json().duplicate).toBe(true);
    expect((await test(h, 'req-00000002')).statusCode).toBe(429);
    expect(h.fake.received).toHaveLength(1);
    h.advance(31_000);
    expect((await test(h, 'req-00000002')).statusCode).toBe(200);
    expect(h.fake.received).toHaveLength(2);
  });

  it('구독 없음은 네트워크 호출 없이 SKIPPED, 410은 구독 삭제, 500은 재시도 없이 SEND_FAILED', async () => {
    h = await createHarness();
    expect((await test(h, 'req-00000001')).json().status).toBe('SKIPPED_NO_SUBSCRIPTION');
    expect(h.fake.received).toHaveLength(0);
    await put(h);
    h.advance(31_000);
    h.fake.status = 410;
    expect((await test(h, 'req-00000002')).json().status).toBe('SUBSCRIPTION_EXPIRED');
    expect((await h.app.inject({ method: 'GET', url: '/api/push/status', headers: h.auth })).json().hasSubscription).toBe(false);
    await put(h);
    h.advance(31_000);
    h.fake.status = 500;
    expect((await test(h, 'req-00000003')).json().status).toBe('SEND_FAILED');
    expect(h.fake.received).toHaveLength(2);
  });

  it('push 서비스 연결 실패는 결과 미확인으로 기록하고 재시도하지 않는다', async () => {
    h = await createHarness();
    // fake 호스트로 구독을 등록한 뒤 서비스를 닫아 연결 실패를 만든다
    await put(h);
    await h.fake.close();
    const r = (await test(h, 'req-00000001')).json();
    expect(r.status).toBe('SEND_FAILED');
    const rec = (await h.app.inject({ method: 'GET', url: '/api/push/status', headers: h.auth })).json().records[0];
    expect(rec.detail).toMatch(/^OUTCOME_UNKNOWN/);
    h.fake.close = async () => {};
  });

  it('표시 확인은 접수되지 않은 기록·모르는 키에는 불가', async () => {
    h = await createHarness();
    expect((await h.app.inject({ method: 'POST', url: '/api/push/displayed', headers: h.auth, payload: { key: 'test:abcdefgh1' } })).statusCode).toBe(404);
    await test(h, 'req-00000001'); // 구독 없음 → SKIPPED
    expect((await h.app.inject({ method: 'POST', url: '/api/push/displayed', headers: h.auth, payload: { key: 'test:req-00000001' } })).statusCode).toBe(409);
  });
});

describe('구독 정보·비밀값 보호', () => {
  it('응답과 상태 파일 권한: endpoint 경로·키·토큰이 응답에 없고 상태 파일은 0600', async () => {
    h = await createHarness();
    const sub = syntheticSubscription(`${h.fake.url}/secret-path-123`);
    await h.app.inject({ method: 'PUT', url: '/api/push/subscription', headers: h.auth, payload: sub });
    await test(h, 'req-00000001');
    const bodies = [
      (await h.app.inject({ method: 'GET', url: '/api/push/status', headers: h.auth })).body,
      (await h.app.inject({ method: 'GET', url: '/api/push/vapid-public-key', headers: h.auth })).body,
    ].join('');
    for (const secret of [sub.keys.p256dh, sub.keys.auth, 'secret-path-123', h.token]) expect(bodies).not.toContain(secret);
    const { statSync } = await import('node:fs');
    expect(statSync(join(h.dir, 'state.json')).mode & 0o777).toBe(0o600);
  });

  it('잘못된 요청 오류 응답에 요청 본문이 되돌려지지 않는다', async () => {
    h = await createHarness();
    const r = await h.app.inject({ method: 'PUT', url: '/api/push/subscription', headers: { ...h.auth, 'content-type': 'application/json' }, payload: '{"endpoint":"SECRETVALUE' });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('SECRETVALUE');
  });
});

describe('loadPushConfig (fail closed)', () => {
  it('비활성이면 null, 활성인데 설정이 없으면 키 이름만 담긴 문제 목록', () => {
    expect(loadPushConfig({}, '/tmp', '127.0.0.1')).toEqual({ config: null, problems: [] });
    const { config, problems } = loadPushConfig({ PUSH_ENABLED: '1' }, '/tmp', '0.0.0.0');
    expect(config).toBeNull();
    const text = problems.join('\n');
    for (const k of ['PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY_FILE', 'PUSH_VAPID_SUBJECT', 'PUSH_ACCESS_TOKEN_FILE', 'loopback']) expect(text).toContain(k);
  });

  it('권한이 넓은 비밀 파일과 짧은 토큰을 거부한다', async () => {
    h = await createHarness();
    const tok = join(h.dir, 'tok');
    await chmod(tok, 0o644);
    const env = { PUSH_ENABLED: '1', PUSH_ACCESS_TOKEN_FILE: tok };
    expect(loadPushConfig(env, h.dir, '127.0.0.1').problems.join()).toContain('0600');
    await chmod(tok, 0o600);
    await writeFile(tok, 'short', { mode: 0o600 });
    expect(loadPushConfig(env, h.dir, '127.0.0.1').problems.join()).toContain('너무 짧음');
  });
});
