// 로컬 하네스: 합성 키·합성 push 서비스로 구독→시험 전송→실패 기록을 재현한다.
// 결과는 모두 SYNTHETIC 이며 Android 실기기 성공과 무관하다. 실행: npm run push:harness
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { buildApp } from '../app.js';
import { loadPushConfig } from './config.js';
import { startFakePushService } from './fake-service.js';
import { PushService } from './service.js';
import { PushStore } from './store.js';

export function syntheticSubscription(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

export async function createHarness(opts: { fakeStatus?: number; extraEnv?: NodeJS.ProcessEnv } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'push-harness-'));
  const keys = webpush.generateVAPIDKeys(); // 시험 전용 합성 키. 저장소에 존재하지 않는다.
  const token = randomBytes(32).toString('base64url');
  await writeFile(join(dir, 'priv'), keys.privateKey, { mode: 0o600 });
  await writeFile(join(dir, 'tok'), token, { mode: 0o600 });
  const fake = await startFakePushService(0, opts.fakeStatus ?? 201);
  const { config, problems } = loadPushConfig(
    {
      PUSH_ENABLED: '1',
      PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      PUSH_VAPID_PRIVATE_KEY_FILE: join(dir, 'priv'),
      PUSH_VAPID_SUBJECT: 'mailto:synthetic@example.invalid',
      PUSH_ACCESS_TOKEN_FILE: join(dir, 'tok'),
      PUSH_STATE_FILE: join(dir, 'state.json'),
      PUSH_DEV_INSECURE_HOSTS: fake.host,
      ...opts.extraEnv,
    },
    dir,
    '127.0.0.1',
  );
  if (!config) throw new Error(`harness config: ${problems.join('; ')}`);
  const store = new PushStore(config.stateFile);
  await store.load();
  let clock = Date.now();
  const service = new PushService(config, store, undefined, () => clock);
  const app = buildApp({ push: { service, accessToken: config.accessToken, staticDir: config.staticDir } });
  await app.ready();
  const auth = { authorization: `Bearer ${token}` };
  return {
    app,
    fake,
    token,
    auth,
    dir,
    advance: (ms: number) => (clock += ms),
    close: async () => {
      await app.close();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => {
    results.push([name, ok]);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  };
  console.log('SYNTHETIC 하네스: 합성 키·합성 push 서비스 사용. 실기기 성공이 아님.');
  for (const [label, status, expected] of [
    ['정상 201', 201, 'PUSH_SERVICE_ACCEPTED'],
    ['만료 410', 410, 'SUBSCRIPTION_EXPIRED'],
    ['서버 오류 500', 500, 'SEND_FAILED'],
  ] as const) {
    const h = await createHarness({ fakeStatus: status });
    const put = await h.app.inject({ method: 'PUT', url: '/api/push/subscription', headers: h.auth, payload: syntheticSubscription(`${h.fake.url}/send/abc`) });
    const t = await h.app.inject({ method: 'POST', url: '/api/push/test', headers: h.auth, payload: { requestId: randomBytes(8).toString('hex') } });
    const body = t.json() as { status: string; confirmedDelivered: boolean };
    check(`${label}: 구독 ${put.statusCode}, 기록 ${body.status}, 전달확인=${body.confirmedDelivered}`, put.statusCode === 200 && body.status === expected && !body.confirmedDelivered && h.fake.received.length === 1);
    await h.close();
  }
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(bad ? `${bad}건 실패` : '모든 합성 시나리오 통과 (실기기 시험은 별도: docs/validation/task-51-android-device-test.md)');
  process.exit(bad ? 1 : 0);
}
