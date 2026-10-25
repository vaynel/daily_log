import { readFileSync } from 'node:fs';
import webpush from 'web-push';

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; url: string; tag: string }
/** gone: 구독이 만료·해지됨(404/410). code 에는 상태·오류 코드만 담고 본문·키·endpoint 는 담지 않는다. */
export type SendOutcome = { ok: true } | { ok: false; gone: boolean; code: string };

export interface PushSender { send(target: PushTarget, payload: PushPayload): Promise<SendOutcome> }

export interface VapidKeys { subject: string; publicKey: string; privateKey: string }

/** VAPID 키는 서버 파일에서만 읽는다(저장소·로그에 남기지 않음). 형식: {"subject","publicKey","privateKey"} JSON. */
export function loadVapidKeys(file: string): VapidKeys {
  const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
  if (!v.subject || !v.publicKey || !v.privateKey) throw new Error('VAPID 키 파일 형식 오류(subject/publicKey/privateKey)');
  return { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey };
}

export class WebPushSender implements PushSender {
  constructor(private readonly keys: VapidKeys) {}
  async send(t: PushTarget, payload: PushPayload): Promise<SendOutcome> {
    try {
      await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: this.keys.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
        TTL: 60 * 60 * 3,
        timeout: 10000,
      });
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return { ok: false, gone: true, code: `HTTP_${status}` };
      return { ok: false, gone: false, code: status ? `HTTP_${status}` : 'NETWORK_ERROR' };
    }
  }
}

/** VAPID 키가 없을 때의 발송기: 항상 실패로 돌려 전달 성공으로 오인되지 않게 한다. */
export class UnconfiguredSender implements PushSender {
  async send(): Promise<SendOutcome> { return { ok: false, gone: false, code: 'PUSH_NOT_CONFIGURED' }; }
}
