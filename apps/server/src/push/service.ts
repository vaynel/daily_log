import { createHash, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import type { PushConfig } from './config.js';
import type { DeliveryRecord, DeviceInfo, Observation, PushStore, StoredSubscription } from './store.js';

export class PushError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export const TEST_COOLDOWN_MS = 30_000;
export const OBSERVATION_STEPS = [
  'install',
  'permission',
  'subscribe',
  'lockscreen',
  'replace',
  'doze',
  'revoke',
  'evidence',
] as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function validateSubscription(body: unknown, cfg: Pick<PushConfig, 'allowedHosts' | 'insecureHosts'>): StoredSubscription {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!b || typeof b !== 'object') throw new PushError(400, 'invalid_subscription');
  const { endpoint } = b;
  const p256dh = b.keys?.p256dh;
  const auth = b.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new PushError(400, 'invalid_endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushError(400, 'invalid_endpoint');
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    (url.protocol === 'https:' && !url.username && !url.password && cfg.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) ||
    (url.protocol === 'http:' && cfg.insecureHosts.includes(url.host));
  if (!allowed) throw new PushError(400, 'endpoint_not_allowed');
  if (typeof p256dh !== 'string' || !BASE64URL.test(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65) throw new PushError(400, 'invalid_keys');
  if (typeof auth !== 'string' || !BASE64URL.test(auth) || Buffer.from(auth, 'base64url').length !== 16) throw new PushError(400, 'invalid_keys');
  return { endpoint: url.toString(), keys: { p256dh, auth }, savedAt: new Date().toISOString() };
}

/** 응답/로그용: endpoint 와 키는 절대 포함하지 않는다. */
export function publicRecord(r: DeliveryRecord): Omit<DeliveryRecord, never> & { confirmedDelivered: boolean } {
  return { ...r, confirmedDelivered: r.status === 'DEVICE_DISPLAYED' };
}

export class PushService {
  constructor(
    private readonly cfg: PushConfig,
    readonly store: PushStore,
    private readonly doFetch: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  get publicKey(): string {
    return this.cfg.publicKey;
  }

  config(): Pick<PushConfig, 'allowedHosts' | 'insecureHosts'> {
    return this.cfg;
  }

  status() {
    const s = this.store.snapshot;
    return {
      enabled: true,
      hasSubscription: s.subscription !== null,
      endpointHost: s.subscription ? new URL(s.subscription.endpoint).host : null,
      device: s.device,
      records: s.records.map(publicRecord),
      observations: s.observations,
      notice: 'PUSH_SERVICE_ACCEPTED 는 push 서비스 접수일 뿐이며 기기 표시 확인(DEVICE_DISPLAYED) 전에는 전달 미확인입니다.',
    };
  }

  saveSubscription(sub: StoredSubscription) {
    return this.store.mutate((s) => void (s.subscription = sub));
  }

  removeSubscription() {
    return this.store.mutate((s) => void (s.subscription = null));
  }

  saveDevice(d: DeviceInfo) {
    return this.store.mutate((s) => void (s.device = d));
  }

  saveObservation(o: Omit<Observation, 'at'>) {
    return this.store.mutate((s) => {
      const rec = { ...o, at: new Date(this.now()).toISOString() };
      s.observations = s.observations.filter((x) => x.step !== o.step).concat(rec);
      return rec;
    });
  }

  /** 명시 요청 1건 = 발송 1회. 같은 requestId 는 재발송하지 않고 기존 기록을 돌려준다. 자동 재시도 없음. */
  async sendTest(requestId: string): Promise<{ record: DeliveryRecord; duplicate: boolean }> {
    const snap = this.store.snapshot;
    const existing = snap.records.find((r) => r.requestId === requestId);
    if (existing) return { record: existing, duplicate: true };
    const last = snap.records.at(-1);
    if (last && this.now() - Date.parse(last.at) < TEST_COOLDOWN_MS) throw new PushError(429, 'test_cooldown');

    const key = `test:${requestId}`;
    const rec: DeliveryRecord = { key, requestId, kind: 'test', status: 'SENDING', at: new Date(this.now()).toISOString() };
    const sub = snap.subscription;
    if (!sub) {
      rec.status = 'SKIPPED_NO_SUBSCRIPTION';
      await this.store.mutate((s) => void s.records.push(rec));
      return { record: rec, duplicate: false };
    }
    await this.store.mutate((s) => void s.records.push(rec)); // 응답이 유실돼도 시도 사실이 남도록 먼저 기록

    let outcome: Pick<DeliveryRecord, 'status' | 'httpStatus' | 'detail'>;
    try {
      const d = webpush.generateRequestDetails(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify({ key, title: 'Daily Log 알림 시험', body: '시험 알림입니다. 화면에 보이면 앱에서 확인을 눌러 주세요.' }),
        {
          vapidDetails: { subject: this.cfg.subject, publicKey: this.cfg.publicKey, privateKey: this.cfg.privateKey },
          TTL: 60,
          urgency: 'high',
          topic: createHash('sha256').update(key).digest('base64url').slice(0, 32),
        },
      ) as { endpoint: string; headers: Record<string, string>; body: Buffer };
      const res = await this.doFetch(d.endpoint, {
        method: 'POST',
        headers: d.headers,
        body: new Uint8Array(d.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      const code = res.status;
      if (code === 201) outcome = { status: 'PUSH_SERVICE_ACCEPTED', httpStatus: code };
      else if (code === 404 || code === 410) outcome = { status: 'SUBSCRIPTION_EXPIRED', httpStatus: code };
      else outcome = { status: 'SEND_FAILED', httpStatus: code, detail: code === 429 ? 'RATE_LIMITED_BY_PUSH_SERVICE' : 'UNEXPECTED_STATUS' };
    } catch (e) {
      // 네트워크 오류·시간초과: push 서비스가 받았는지 알 수 없다. 재시도하지 않는다.
      outcome = { status: 'SEND_FAILED', detail: `OUTCOME_UNKNOWN:${e instanceof Error ? e.name : 'error'}` };
    }
    await this.store.mutate((s) => {
      Object.assign(rec, outcome);
      if (outcome.status === 'SUBSCRIPTION_EXPIRED' && s.subscription?.endpoint === sub.endpoint) s.subscription = null;
    });
    return { record: rec, duplicate: false };
  }

  /** 기기 표시 확인. push 서비스 접수 기록만 승격할 수 있다. */
  async confirmDisplayed(key: string): Promise<DeliveryRecord> {
    const rec = this.store.snapshot.records.find((r) => r.key === key);
    if (!rec) throw new PushError(404, 'unknown_key');
    if (rec.status === 'DEVICE_DISPLAYED') return rec;
    if (rec.status !== 'PUSH_SERVICE_ACCEPTED') throw new PushError(409, 'not_accepted_by_push_service');
    await this.store.mutate(() => {
      rec.status = 'DEVICE_DISPLAYED';
      rec.displayedAt = new Date(this.now()).toISOString();
    });
    return rec;
  }
}

export function newRequestId(): string {
  return randomBytes(12).toString('hex');
}
