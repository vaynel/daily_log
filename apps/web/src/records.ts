export type DisplayStatus = 'WRITING' | 'AWAITING_PRODUCTION' | 'PRODUCING' | 'BUDGET_WAIT' | 'FAILED' | 'REVIEW_REJECTED' | 'REVIEW_PENDING' | 'COMPLETED';
export type NextAction = 'CONTINUE_RECORDING' | 'REQUEST_PRODUCTION' | 'WAIT' | 'RETRY' | 'EDIT_AND_REMAKE' | 'DOWNLOAD' | 'RETRY_BACKUP';
export interface Pipeline { production: string; review: string; backup: string }
export interface RecordRow { id: string; lifeDate: string; status: DisplayStatus; pipeline: Pipeline; hasResult: boolean; attachmentCount: number }
export interface RecordDetail {
  id: string; lifeDate: string; status: DisplayStatus; pipeline: Pipeline; nextActions: NextAction[];
  conversation: { id: string; seq: number; kind: 'QUESTION' | 'ANSWER'; body: string; attachmentIds: string[] }[];
  summary: { version: number; diary: string | null; learning: string[] } | null;
  attachments: { id: string; itemId: string | null; kind: string; name: string | null; size: number | null; capturedAt: string | null }[];
  result: { version: number; fileAvailable: boolean } | null;
}

/** tone 은 색에만 의존하지 않도록 항상 문구와 함께 쓴다. ok 는 정상 완료만. */
export const STATUS_INFO: Record<DisplayStatus, { label: string; tone: 'ok' | 'info' | 'wait' | 'bad'; hint: string }> = {
  WRITING: { label: '작성 중', tone: 'info', hint: '아직 확정하지 않은 기록입니다. 이어서 기록할 수 있습니다.' },
  AWAITING_PRODUCTION: { label: '확정됨 · 제작 전', tone: 'info', hint: '확정한 기록입니다. 영상 제작을 요청할 수 있습니다.' },
  PRODUCING: { label: '제작 중', tone: 'info', hint: '영상을 만들고 있습니다. 끝나면 이 화면에 표시됩니다.' },
  BUDGET_WAIT: { label: '예산 대기', tone: 'wait', hint: '이번 달 추가 비용 한도 때문에 제작이 대기 중입니다. 자동으로 유료 전환하지 않습니다.' },
  FAILED: { label: '처리 실패', tone: 'bad', hint: '제작 처리 중 오류가 났습니다. 영상은 만들어지지 않았습니다.' },
  REVIEW_REJECTED: { label: '검수 미통과', tone: 'bad', hint: '영상이 검수를 통과하지 못했습니다. 내용을 수정해 다시 만들 수 있습니다.' },
  REVIEW_PENDING: { label: '검수 중', tone: 'wait', hint: '영상이 만들어졌고 검수를 기다립니다. 통과 전에는 완료가 아닙니다.' },
  COMPLETED: { label: '완료', tone: 'ok', hint: '제작과 검수가 끝났습니다.' },
};

export const PIPELINE_LABEL: Record<'production' | 'review' | 'backup', Record<string, string>> = {
  production: { NONE: '제작 전', QUEUED: '제작 대기열', RUNNING: '제작 중', DONE: '제작 완료', FAILED: '제작 실패', WAITING_BUDGET: '예산 대기' },
  review: { NONE: '검수 전', PENDING: '검수 중', PASSED: '검수 통과', REJECTED: '검수 미통과' },
  backup: { NONE: '백업 전', PENDING: '백업 중', VERIFIED: '백업 확인됨', FAILED: '백업 실패' },
};

export const ACTION_LABEL: Record<NextAction, string> = {
  CONTINUE_RECORDING: '이어서 기록하기', REQUEST_PRODUCTION: '영상 제작 요청', WAIT: '기다리면 됩니다',
  RETRY: '다시 시도', EDIT_AND_REMAKE: '내용 수정 후 다시 만들기', DOWNLOAD: '영상 내려받기', RETRY_BACKUP: '백업 다시 시도',
};

export type Loaded<T> = { state: 'ok'; data: T } | { state: 'expired' } | { state: 'not-found' } | { state: 'error' };

/** 401 은 세션 만료, 404 는 없거나 접근할 수 없는 기록. 그 외·네트워크 오류는 일반 오류. */
export async function fetchJson<T>(url: string, f: typeof fetch = fetch): Promise<Loaded<T>> {
  try {
    const r = await f(url);
    if (r.status === 401 || r.status === 403) return { state: 'expired' };
    if (r.status === 404) return { state: 'not-found' };
    if (!r.ok) return { state: 'error' };
    return { state: 'ok', data: (await r.json()) as T };
  } catch {
    return { state: 'error' };
  }
}

/** 달력의 한 칸. date 가 null 이면 해당 월이 아닌 빈 칸이다. */
export interface CalendarCell { date: string | null; day: number | null }

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM' 형식인지 확인한다. */
export const isYearMonth = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** 'YYYY-MM' 에 달 수를 더한다. 연도 경계(12→1월)도 처리한다. 시간대와 무관한 순수 계산이다. */
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${pad((idx % 12) + 1)}`;
}

/** 한 달의 주 단위 칸(일요일 시작). 시간대 영향을 받지 않도록 UTC 로만 계산한다. */
export function monthGrid(ym: string): CalendarCell[][] {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: CalendarCell[] = [
    ...Array.from({ length: lead }, () => ({ date: null, day: null })),
    ...Array.from({ length: days }, (_, i) => ({ date: `${ym}-${pad(i + 1)}`, day: i + 1 })),
  ];
  while (cells.length % 7) cells.push({ date: null, day: null });
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** 생활일(YYYY-MM-DD) → 기록. 영상 제작·완성 시각은 쓰지 않고 서버가 준 생활일 그대로 놓는다. */
export function byLifeDate(rows: RecordRow[]): Map<string, RecordRow> {
  const m = new Map<string, RecordRow>();
  for (const r of rows) if (!m.has(r.lifeDate)) m.set(r.lifeDate, r);
  return m;
}

/** 처음 보여줄 달: 가장 최근 생활일의 달. 기록이 없으면 지금 달(로컬 날짜). */
export function initialMonth(rows: RecordRow[], today: Date = new Date()): string {
  const latest = rows.map((r) => r.lifeDate).sort().at(-1);
  return latest ? latest.slice(0, 7) : `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
}
