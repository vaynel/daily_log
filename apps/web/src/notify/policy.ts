// TASK-6 prototype: reminder policy and delivery ledger. Pure functions, no I/O.

export const REMINDER_TIME_ZONE = 'Asia/Seoul';
export const REMINDER_HOUR = 22;

/** Calendar date (YYYY-MM-DD) of `at` in Asia/Seoul. */
export function livingDayOf(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Living day (the day being recorded) and send day are the same KST date for the 22:00 reminder.
 * They are kept as separate fields so a late send (queue delay past midnight KST) is still
 * attributed to the day it was meant for, never to the day it happened to be sent.
 */
export interface ReminderSlot {
  userId: string;
  livingDay: string;
}

export function interviewKey(slot: ReminderSlot): string {
  return `interview:${slot.userId}:${slot.livingDay}`;
}

export function completionKey(userId: string, jobId: string): string {
  return `complete:${userId}:${jobId}`;
}

/** Web Push `Topic` header allows at most 32 URL-safe chars; derive a stable one from the key. */
export async function pushTopic(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

export type DeliveryStatus =
  | 'SKIPPED_PERMISSION_DENIED'
  | 'SKIPPED_NO_SUBSCRIPTION'
  | 'SKIPPED_UNSUPPORTED'
  | 'SKIPPED_DUPLICATE'
  | 'SUBSCRIPTION_EXPIRED'
  | 'SEND_FAILED'
  | 'MOCK_ACCEPTED'
  | 'PUSH_SERVICE_ACCEPTED'
  | 'DEVICE_DISPLAYED';

export interface DeliveryRecord {
  key: string;
  kind: 'interview' | 'completion';
  status: DeliveryStatus;
  detail?: string;
}

/** Only a device-side display acknowledgement counts as delivered. */
export function isConfirmedDelivered(rec: DeliveryRecord): boolean {
  return rec.status === 'DEVICE_DISPLAYED';
}

export interface Transport {
  /** mock transports must report mock=true; they can never yield a delivered status. */
  mock: boolean;
  send(key: string, kind: DeliveryRecord['kind']): Promise<{ httpStatus: number }>;
}

export interface DispatchContext {
  permission: NotificationPermission | 'unsupported';
  hasSubscription: boolean;
}

export class DeliveryLedger {
  private readonly records = new Map<string, DeliveryRecord>();

  get(key: string): DeliveryRecord | undefined {
    return this.records.get(key);
  }

  all(): DeliveryRecord[] {
    return [...this.records.values()];
  }

  /** The device reports it showed the notification. */
  confirmDisplayed(key: string): void {
    const rec = this.records.get(key);
    // a mock accept stays a mock record; only a real push-service accept can be promoted
    if (rec?.status === 'PUSH_SERVICE_ACCEPTED') rec.status = 'DEVICE_DISPLAYED';
  }

  /**
   * One attempt per key. A key that already has a record is never sent again, including after a
   * failure: no retry and no re-notification for an unanswered reminder.
   */
  async dispatch(
    key: string,
    kind: DeliveryRecord['kind'],
    ctx: DispatchContext,
    transport: Transport,
  ): Promise<DeliveryRecord> {
    const existing = this.records.get(key);
    if (existing) return { key, kind, status: 'SKIPPED_DUPLICATE', detail: `existing:${existing.status}` };

    const done = (status: DeliveryStatus, detail?: string): DeliveryRecord => {
      const rec: DeliveryRecord = { key, kind, status, detail };
      this.records.set(key, rec);
      return rec;
    };

    if (ctx.permission === 'unsupported') return done('SKIPPED_UNSUPPORTED');
    if (ctx.permission !== 'granted') return done('SKIPPED_PERMISSION_DENIED', ctx.permission);
    if (!ctx.hasSubscription) return done('SKIPPED_NO_SUBSCRIPTION');

    try {
      const { httpStatus } = await transport.send(key, kind);
      if (httpStatus === 404 || httpStatus === 410) return done('SUBSCRIPTION_EXPIRED', String(httpStatus));
      if (httpStatus !== 201) return done('SEND_FAILED', String(httpStatus));
      return done(transport.mock ? 'MOCK_ACCEPTED' : 'PUSH_SERVICE_ACCEPTED', String(httpStatus));
    } catch (e) {
      return done('SEND_FAILED', e instanceof Error ? e.name : 'error');
    }
  }
}

export interface PermissionGuidance {
  tone: 'ok' | 'ask' | 'blocked' | 'unsupported';
  title: string;
  steps: string[];
}

export function permissionGuidance(perm: NotificationPermission | 'unsupported'): PermissionGuidance {
  switch (perm) {
    case 'granted':
      return { tone: 'ok', title: '알림이 켜져 있습니다', steps: ['매일 밤 10시(한국 시간)에 한 번 알려드립니다.'] };
    case 'default':
      return {
        tone: 'ask',
        title: '알림을 켜면 밤 10시에 알려드립니다',
        steps: ['아래 버튼을 눌러 알림을 허용해 주세요.', '허용하지 않아도 앱에서 직접 기록할 수 있습니다.'],
      };
    case 'denied':
      return {
        tone: 'blocked',
        title: '알림이 꺼져 있어 밤 10시 알림을 받을 수 없습니다',
        steps: [
          '휴대폰 설정 > 앱(또는 설치한 앱 아이콘 길게 누르기 > 앱 정보) > 알림 으로 이동합니다.',
          '알림을 켭니다. 브라우저에서 열었다면 주소창 왼쪽 자물쇠 > 권한 > 알림 허용.',
          '돌아와서 "다시 확인"을 누르세요. 앱이 직접 허용창을 다시 띄울 수는 없습니다.',
        ],
      };
    default:
      return {
        tone: 'unsupported',
        title: '이 환경은 알림을 지원하지 않습니다',
        steps: [
          'Android Chrome에서 열고 "홈 화면에 추가"로 설치한 앱을 사용해 주세요.',
          '알림 없이도 앱을 직접 열어 기록할 수 있습니다.',
        ],
      };
  }
}
