import { addDays, seoulDate } from '../records/time.js';

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000; // Asia/Seoul은 DST 없는 UTC+9
export const DEFAULT_INTERVIEW_TIME = '22:00';
/** 예약 시각을 놓쳤더라도(서버 중단 등) 이 시간 안에는 늦게라도 한 번 보낸다. 넘으면 그날은 건너뛴다. */
export const REMINDER_GRACE_MS = 3 * 60 * 60 * 1000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isValidTime = (s: unknown): s is string => typeof s === 'string' && TIME_RE.test(s);

/** 생활일(KST 달력 날짜)의 'HH:MM'(KST)에 해당하는 실제 시점. */
export function scheduledAt(date: string, time: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!) - SEOUL_OFFSET_MS);
}

export type ReminderSlot = { date: string; at: Date; state: 'NOT_YET' | 'DUE' | 'MISSED' };

/**
 * 지금 시점에서 확인해야 할 알림 날짜. 자정 직후에도 전날 늦은 예약(예: 23:59)을 놓치지 않도록 오늘·어제를 본다.
 * DUE: 예약 시각 이후 유예 시간 안, MISSED: 유예를 넘김, NOT_YET: 아직 전.
 */
export function reminderSlots(now: Date, time: string, graceMs = REMINDER_GRACE_MS): ReminderSlot[] {
  const today = seoulDate(now);
  return [addDays(today, -1), today].map((date) => {
    const at = scheduledAt(date, time);
    const age = now.getTime() - at.getTime();
    return { date, at, state: age < 0 ? 'NOT_YET' : age <= graceMs ? 'DUE' : 'MISSED' } as ReminderSlot;
  });
}
