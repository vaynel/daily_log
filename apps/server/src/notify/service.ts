import type pg from 'pg';
import { seoulDate } from '../records/time.js';
import { DEFAULT_INTERVIEW_TIME, REMINDER_GRACE_MS, isValidTime, reminderSlots } from './schedule.js';
import type { PushSender } from './sender.js';

export type Permission = 'unknown' | 'default' | 'granted' | 'denied' | 'unsupported';
export const PERMISSIONS: Permission[] = ['unknown', 'default', 'granted', 'denied', 'unsupported'];
export type NotificationKind = 'INTERVIEW_REMINDER' | 'RESULT_COMPLETED' | 'RESULT_REVISED' | 'PROCESSING_FAILED' | 'BACKUP_FAILED';
export type DeliveryStatus = 'PENDING' | 'ACCEPTED' | 'UNDELIVERABLE' | 'FAILED' | 'SKIPPED';

export interface Settings { interviewTime: string; permission: Permission; subscribed: boolean }
export interface NotificationRow {
  id: string; kind: NotificationKind; lifeDate: string | null; interviewId: string | null; url: string;
  status: DeliveryStatus; attempts: number; errorCode: string | null; createdAt: string; deliveredAt: string | null;
}

export interface NotifyOptions {
  pool: pg.Pool;
  sender: PushSender;
  now?: () => Date;
  graceMs?: number;
  maxAttempts?: number;
  /** 결과 알림을 만들 때 이 기간 안에 바뀐 기록만 본다(배포 직후 과거 기록 일괄 알림 방지). */
  lookbackMs?: number;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RESULT_TEXT: Record<Exclude<NotificationKind, 'INTERVIEW_REMINDER'>, { title: string; body: (d: string) => string }> = {
  RESULT_COMPLETED: { title: '영상이 완성되었습니다', body: (d) => `${d} 기록의 영상이 완성되었습니다. 눌러서 해당 기록을 확인하세요.` },
  RESULT_REVISED: { title: '수정한 영상이 완성되었습니다', body: (d) => `${d} 기록의 수정본이 완성되었습니다. 눌러서 해당 기록을 확인하세요.` },
  PROCESSING_FAILED: { title: '영상 처리에 실패했습니다', body: (d) => `${d} 기록의 영상 처리가 실패했습니다. 기록은 그대로 보관되어 있습니다.` },
  BACKUP_FAILED: { title: '백업에 실패했습니다', body: (d) => `${d} 기록의 백업이 실패했습니다. 기록과 영상은 삭제되지 않았습니다.` },
};

const toNotification = (r: Row): NotificationRow => ({
  id: r.id, kind: r.kind, lifeDate: r.life_date ? (r.life_date instanceof Date ? r.life_date.toISOString().slice(0, 10) : String(r.life_date)) : null,
  interviewId: r.interview_id, url: r.url, status: r.status, attempts: Number(r.attempts), errorCode: r.error_code,
  createdAt: new Date(r.created_at).toISOString(), deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
});

/**
 * 알림 생성·전달. 전달 결과는 notifications 에만 쓰고 interviews·pipeline_states 등 기록·제작 상태는 읽기만 한다.
 * 전달 실패는 어떤 경로로도 제작 실패나 기록 삭제로 이어지지 않는다.
 */
export class NotificationService {
  private readonly now: () => Date;
  private readonly graceMs: number;
  private readonly maxAttempts: number;
  private readonly lookbackMs: number;
  constructor(private readonly o: NotifyOptions) {
    this.now = o.now ?? (() => new Date());
    this.graceMs = o.graceMs ?? REMINDER_GRACE_MS;
    this.maxAttempts = o.maxAttempts ?? 3;
    this.lookbackMs = o.lookbackMs ?? 48 * 60 * 60 * 1000;
  }
  private get pool() { return this.o.pool; }

  // ---- 설정·권한·구독 ----
  async getSettings(owner: string): Promise<Settings> {
    const s = (await this.pool.query('SELECT interview_time, permission FROM notification_settings WHERE owner_id=$1', [owner])).rows[0];
    const sub = (await this.pool.query('SELECT 1 FROM push_subscriptions WHERE owner_id=$1 AND active LIMIT 1', [owner])).rowCount ?? 0;
    return { interviewTime: s?.interview_time ?? DEFAULT_INTERVIEW_TIME, permission: s?.permission ?? 'unknown', subscribed: sub > 0 };
  }

  /**
   * 인터뷰 알림 시각(KST HH:MM)을 바꾼다. 변경한 시각이 이후 예약에 쓰인다.
   * 새 시각이 오늘 이미 지났고 오늘 알림이 아직 없으면 오늘은 건너뛴다(설정을 바꾸자마자 즉시 울리지 않게).
   */
  async setInterviewTime(owner: string, time: string): Promise<Settings> {
    if (!isValidTime(time)) throw new RangeError('INVALID_TIME');
    await this.pool.query(
      `INSERT INTO notification_settings (owner_id, interview_time) VALUES ($1,$2)
       ON CONFLICT (owner_id) DO UPDATE SET interview_time=EXCLUDED.interview_time, updated_at=now()`, [owner, time]);
    const now = this.now();
    const today = reminderSlots(now, time, this.graceMs).find((s) => s.date === seoulDate(now))!;
    if (today.state !== 'NOT_YET') await this.insert(owner, 'INTERVIEW_REMINDER', today.date, null, 'SKIPPED', 'SETTING_CHANGED_AFTER_TIME');
    return this.getSettings(owner);
  }

  async reportPermission(owner: string, permission: Permission): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_settings (owner_id, permission, permission_reported_at) VALUES ($1,$2,$3)
       ON CONFLICT (owner_id) DO UPDATE SET permission=EXCLUDED.permission, permission_reported_at=EXCLUDED.permission_reported_at, updated_at=now()`,
      [owner, permission, this.now()]);
    // 권한이 거부·미지원이면 기존 구독은 더 이상 표시되지 않으므로 비활성화한다(다시 허용하면 재구독).
    if (permission === 'denied' || permission === 'unsupported') await this.pool.query('UPDATE push_subscriptions SET active=false, updated_at=now() WHERE owner_id=$1', [owner]);
  }

  async saveSubscription(owner: string, s: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO push_subscriptions (owner_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET owner_id=EXCLUDED.owner_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, active=true, updated_at=now()`,
      [owner, s.endpoint, s.p256dh, s.auth]);
  }

  async removeSubscription(owner: string, endpoint: string): Promise<void> {
    await this.pool.query('UPDATE push_subscriptions SET active=false, updated_at=now() WHERE owner_id=$1 AND endpoint=$2', [owner, endpoint]);
  }

  async recent(owner: string, limit = 20): Promise<NotificationRow[]> {
    const r = await this.pool.query('SELECT * FROM notifications WHERE owner_id=$1 ORDER BY created_at DESC, id LIMIT $2', [owner, limit]);
    return r.rows.map(toNotification);
  }

  // ---- 생성 ----
  /** 같은 dedupe 키는 한 번만 만든다. 새로 만들었을 때만 true. */
  private async insert(owner: string, kind: NotificationKind, lifeDate: string | null, interviewId: string | null, status: DeliveryStatus, code: string | null, dedupeSuffix = ''): Promise<boolean> {
    const isReminder = kind === 'INTERVIEW_REMINDER';
    const key = isReminder ? `INTERVIEW_REMINDER:${owner}:${lifeDate}` : `${kind}:${interviewId}${dedupeSuffix}`;
    const text = isReminder ? { title: '오늘의 기록 시간입니다', body: '오늘 있었던 일을 10분 정도 이야기해 볼까요?' } : { title: RESULT_TEXT[kind as keyof typeof RESULT_TEXT].title, body: RESULT_TEXT[kind as keyof typeof RESULT_TEXT].body(lifeDate!) };
    const url = isReminder ? '/' : `/?record=${interviewId}`;
    const r = await this.pool.query(
      `INSERT INTO notifications (owner_id, kind, dedupe_key, life_date, interview_id, url, title, body, status, error_code, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9='PENDING' THEN $11::timestamptz END) ON CONFLICT (dedupe_key) DO NOTHING`,
      [owner, kind, key, lifeDate, interviewId, url, text.title, text.body, status, code, this.now()]);
    return (r.rowCount ?? 0) > 0;
  }

  /** 예약 시각이 된(또는 유예 안에 놓친) 소유자별 인터뷰 알림을 생활일당 1건만 만든다. */
  async scheduleReminders(): Promise<number> {
    const now = this.now();
    const owners = (await this.pool.query(
      `SELECT owner_id FROM notification_settings UNION SELECT owner_id FROM push_subscriptions WHERE active`)).rows.map((r) => r.owner_id as string);
    let created = 0;
    for (const owner of owners) {
      const time = (await this.getSettings(owner)).interviewTime;
      for (const slot of reminderSlots(now, time, this.graceMs)) {
        if (slot.state !== 'DUE') continue;
        // 그날 기록을 이미 확정했다면 알릴 필요가 없다.
        const done = (await this.pool.query(`SELECT 1 FROM interviews WHERE owner_id=$1 AND life_date=$2 AND status='CONFIRMED' AND deleted_at IS NULL AND server_purged_at IS NULL`, [owner, slot.date])).rowCount;
        if (await this.insert(owner, 'INTERVIEW_REMINDER', slot.date, null, done ? 'SKIPPED' : 'PENDING', done ? 'ALREADY_RECORDED' : null)) created += done ? 0 : 1;
      }
    }
    return created;
  }

  /** 완료·수정 완료·처리 실패·백업 실패 알림. 늦게 끝난 기록도 생활일과 무관하게 해당 기록 상세로 연결한다. */
  async sweepResults(): Promise<number> {
    const since = new Date(this.now().getTime() - this.lookbackMs);
    const rows = (await this.pool.query(
      `SELECT i.id, i.owner_id, to_char(i.life_date,'YYYY-MM-DD') AS life_date, p.production, p.review, p.backup,
              COALESCE((SELECT max(version) FROM record_versions v WHERE v.interview_id=i.id AND v.kind='RESULT'),0) AS rv
         FROM interviews i JOIN pipeline_states p ON p.interview_id=i.id WHERE p.updated_at >= $1 AND i.deleted_at IS NULL AND i.server_purged_at IS NULL`, [since])).rows;
    let created = 0;
    for (const r of rows) {
      const rv = Number(r.rv);
      const sfx = `:v${rv}`;
      const add = async (kind: NotificationKind) => { if (await this.insert(r.owner_id, kind, r.life_date, r.id, 'PENDING', null, sfx)) created++; };
      if (r.production === 'DONE' && r.review === 'PASSED' && rv >= 1) await add(rv > 1 ? 'RESULT_REVISED' : 'RESULT_COMPLETED');
      if (r.production === 'FAILED') await add('PROCESSING_FAILED');
      if (r.backup === 'FAILED') await add('BACKUP_FAILED');
    }
    return created;
  }

  // ---- 전달 ----
  /** 대기 중 알림을 전달한다. 실패는 알림 상태에만 기록하고 예외를 밖으로 내지 않는다. */
  async deliverPending(): Promise<number> {
    let n = 0;
    for (;;) {
      // 다른 작업자와 겹치지 않게 선점(5분 뒤 재시도 시각을 먼저 밀어 둔다).
      const now = this.now();
      const c = await this.pool.query(
        `UPDATE notifications SET next_attempt_at = $1::timestamptz + interval '5 minutes'
         WHERE id = (SELECT id FROM notifications WHERE status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`, [now]);
      if (!c.rows[0]) return n;
      await this.deliver(c.rows[0]);
      n++;
    }
  }

  private async finish(id: string, status: DeliveryStatus, code: string | null, attempts: number, retryInMs?: number) {
    await this.pool.query(
      `UPDATE notifications SET status=$2, error_code=$3, attempts=$4,
         next_attempt_at = CASE WHEN $2='PENDING' THEN $5::timestamptz END,
         delivered_at = CASE WHEN $2='ACCEPTED' THEN $6::timestamptz END WHERE id=$1`,
      [id, status, code, attempts, new Date(this.now().getTime() + (retryInMs ?? 0)), this.now()]);
  }

  private async deliver(n: Row): Promise<void> {
    const owner = n.owner_id as string;
    const attempts = Number(n.attempts) + 1;
    try {
      const { permission } = await this.getSettings(owner);
      if (permission === 'denied' || permission === 'unsupported') return await this.finish(n.id, 'UNDELIVERABLE', 'PERMISSION_DENIED', attempts);
      const subs = (await this.pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id=$1 AND active', [owner])).rows;
      if (!subs.length) return await this.finish(n.id, 'UNDELIVERABLE', 'NO_SUBSCRIPTION', attempts);
      let accepted = false;
      let lastCode = 'DELIVERY_FAILED';
      let transient = false;
      for (const s of subs) {
        const out = await this.o.sender.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { title: n.title, body: n.body, url: n.url, tag: n.dedupe_key })
          .catch((): { ok: false; gone: boolean; code: string } => ({ ok: false, gone: false, code: 'SENDER_EXCEPTION' }));
        if (out.ok) accepted = true;
        else if (out.gone) await this.pool.query('UPDATE push_subscriptions SET active=false, updated_at=now() WHERE id=$1', [s.id]);
        else { transient = true; lastCode = out.code; }
      }
      if (accepted) return await this.finish(n.id, 'ACCEPTED', null, attempts);
      if (!transient) return await this.finish(n.id, 'UNDELIVERABLE', 'NO_SUBSCRIPTION', attempts); // 모든 구독이 만료됨
      if (attempts >= this.maxAttempts) return await this.finish(n.id, 'FAILED', lastCode, attempts);
      await this.finish(n.id, 'PENDING', lastCode, attempts, 60_000 * 2 ** (attempts - 1));
    } catch (e) {
      // 알림 저장소 자체의 오류도 기록·제작 상태에는 영향을 주지 않는다. 선점 시각이 지나면 다시 시도된다.
      console.error('notify deliver error:', e instanceof Error ? e.name : 'ERROR');
    }
  }

  /** 워커 반복에서 호출. 단계별로 격리해 한 단계의 오류가 다른 단계나 작업 큐를 막지 않는다. */
  async run(): Promise<void> {
    for (const step of [() => this.scheduleReminders(), () => this.sweepResults(), () => this.deliverPending()]) {
      try { await step(); } catch (e) { console.error('notify step error:', e instanceof Error ? e.name : 'ERROR'); }
    }
  }
}
