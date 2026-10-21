const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000; // Asia/Seoul은 DST 없는 UTC+9
/** 이 시각(KST) 이전에 시작한 인터뷰는 전날 생활일로 제안한다. */
export const LIFE_DAY_CUTOFF_HOUR_KST = 5;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === s;
}

/** Asia/Seoul 달력 날짜 (YYYY-MM-DD). */
export function seoulDate(at: Date): string {
  return new Date(at.getTime() + SEOUL_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** 05:00 KST 전 시작은 전날, 이후는 당일을 생활일로 제안한다. 사용자가 수정할 수 있다. */
export function suggestLifeDate(startedAt: Date): string {
  return seoulDate(new Date(startedAt.getTime() - LIFE_DAY_CUTOFF_HOUR_KST * 60 * 60 * 1000));
}

/** Asia/Seoul 기준 다음 달 동일 일·시각(없으면 말일)의 시점. */
export function addCalendarMonthSeoul(at: Date): Date {
  const k = new Date(at.getTime() + SEOUL_OFFSET_MS);
  const y = k.getUTCFullYear();
  const mo = k.getUTCMonth() + 1; // 다음 달의 0-기준 인덱스
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const day = Math.min(k.getUTCDate(), lastDay);
  const ms = Date.UTC(y, mo, day, k.getUTCHours(), k.getUTCMinutes(), k.getUTCSeconds(), k.getUTCMilliseconds());
  return new Date(ms - SEOUL_OFFSET_MS);
}

