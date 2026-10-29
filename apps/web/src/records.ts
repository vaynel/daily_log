export type DisplayStatus = 'WRITING' | 'AWAITING_PRODUCTION' | 'PRODUCING' | 'BUDGET_WAIT' | 'FAILED' | 'REVIEW_REJECTED' | 'REVIEW_PENDING' | 'COMPLETED' | 'RESULT_FILE_MISSING';
export type NextAction = 'CONTINUE_RECORDING' | 'REQUEST_PRODUCTION' | 'WAIT' | 'RETRY' | 'EDIT_AND_REMAKE' | 'DOWNLOAD' | 'RETRY_BACKUP';
export interface Pipeline { qualityReasons?: string[]; production: string; review: string; backup: string }
export const PAGE_SIZE = 50;
export interface RecordsPage { records: RecordRow[]; nextCursor: string | null }
export interface RecordRow { id: string; lifeDate: string; status: DisplayStatus; pipeline: Pipeline; hasResult: boolean; attachmentCount: number }
export interface RecordDetail {
  id: string; lifeDate: string; status: DisplayStatus; pipeline: Pipeline; nextActions: NextAction[];
  conversation: { id: string; seq: number; kind: 'QUESTION' | 'ANSWER'; body: string; attachmentIds: string[] }[];
  summary: { version: number; diary: string | null; learning: string[] } | null;
  attachments: { id: string; itemId: string | null; kind: string; name: string | null; size: number | null; capturedAt: string | null }[];
  result: { version: number; fileAvailable: boolean } | null;
}

/** tone 은 색에만 의존하지 않도록 항상 문구와 함께 쓴다. ok 는 정상 완료만. */
export const STATUS_INFO: Record<DisplayStatus, { label: string; tone: 'ok' | 'info' | 'wait' | 'warn' | 'bad'; hint: string }> = {
  WRITING: { label: '작성 중', tone: 'info', hint: '아직 확정하지 않은 기록입니다. 이어서 기록할 수 있습니다.' },
  AWAITING_PRODUCTION: { label: '확정됨 · 제작 전', tone: 'info', hint: '확정한 기록입니다. 영상 제작을 요청할 수 있습니다.' },
  PRODUCING: { label: '제작 중', tone: 'info', hint: '영상을 만들고 있습니다. 끝나면 이 화면에 표시됩니다.' },
  BUDGET_WAIT: { label: '예산 대기', tone: 'wait', hint: '이번 달 추가 비용 한도 때문에 제작이 대기 중입니다. 자동으로 유료 전환하지 않습니다.' },
  FAILED: { label: '처리 실패', tone: 'bad', hint: '제작 처리 중 오류가 났습니다. 영상은 만들어지지 않았습니다.' },
  REVIEW_REJECTED: { label: '검수 미통과', tone: 'bad', hint: '영상이 검수를 통과하지 못했습니다. 내용을 수정해 다시 만들 수 있습니다.' },
  REVIEW_PENDING: { label: '검수 중', tone: 'wait', hint: '영상이 만들어졌고 검수를 기다립니다. 통과 전에는 완료가 아닙니다.' },
  COMPLETED: { label: '완료', tone: 'ok', hint: '제작과 검수가 끝났습니다.' },
  RESULT_FILE_MISSING: { label: '결과 파일 없음', tone: 'warn', hint: '검수는 끝났지만 결과 파일을 찾을 수 없어 내려받을 수 없습니다. 완료로 볼 수 없습니다.' },
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

/** 목록 요청 주소. cursor 는 직전 페이지의 nextCursor(생활일)다. */
export const recordsUrl = (cursor: string | null) => `/api/records?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

/** 달력이 보여줄 달(ym)의 첫날까지 불러왔는지: 다음 페이지가 없거나 가장 오래된 행이 그 달 첫날 이전이면 충분하다. */
export function coversMonth(rows: RecordRow[], nextCursor: string | null, ym: string): boolean {
  if (!nextCursor) return true;
  const oldest = rows.at(-1)?.lifeDate;
  return !!oldest && oldest <= `${ym}-01`;
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

export const QUALITY_REASON_LABEL: Record<string, string> = { QUALITY_EXHAUSTED: '품질 자동 재제작 1회를 모두 사용했습니다.', BUDGET: '예산 확보를 기다립니다.', PERMISSION: '제작 권한 확인을 기다립니다.' };

// ---- 결과 확인·수정(TASK-28) ----

export type ResultRole = 'CURRENT' | 'PREVIOUS';
export interface ResultVersion {
  version: number; role: ResultRole; status: DisplayStatus | 'SUPERSEDED'; fileAvailable: boolean; playable: boolean; downloadable: boolean;
  confirmedAt: string | null; createdAt: string; supersededAt: string | null;
}
export interface ResultsInfo { id: string; current: number | null; versions: ResultVersion[]; items: { id: string; text: string }[] }
export type RevisionBody = { kind: 'EXCLUDE'; itemId?: string; keyword?: string } | { kind: 'EDIT_TEXT'; itemId: string; text: string } | { kind: 'VOICE'; text: string } | { kind: 'RETRY' };

export const resultFileUrl = (id: string, version: number, download = false) => `/api/records/${id}/results/${version}/file${download ? '?download=1' : ''}`;

/** 같은 버튼을 두 번 눌러도 한 번만 처리되도록 서버가 보는 명령 식별자. */
export const newCommandId = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 서버 오류 코드 → 사용자에게 보일 문구. 코드가 낯설면 아무것도 바뀌지 않았다고만 알린다. */
export const REVISION_ERROR: Record<string, string> = {
  NO_MATCH: '해당 내용을 영상에서 찾지 못했습니다. 아무것도 바뀌지 않았습니다.',
  NO_CONTENT: '남는 내용이 없어 다시 만들 수 없습니다. 일부만 빼 주세요.',
  EXCLUDED_CONTENT: '영상에 넣을 수 없는 내용이 들어 있어 반영하지 않았습니다.',
  NOT_EXECUTED: '명령을 실행하지 않았습니다. 원본 삭제나 알아듣지 못한 명령은 영상에 반영되지 않습니다.',
  REMAKE_IN_PROGRESS: '이미 다시 만드는 중입니다. 끝난 뒤에 수정해 주세요.',
  NOT_RETRYABLE: '다시 시도할 수 있는 실패·대기 작업이 없습니다.',
  NOT_REVISABLE: '지금은 수정할 수 없는 기록입니다.',
  IDEMPOTENCY_CONFLICT: '같은 요청이 다른 내용으로 다시 들어왔습니다. 화면을 새로 불러와 주세요.',
};

/** 수정 가능한 상태. 제작 중이거나 아직 제작 전이면 수정 대신 기다림 안내를 보인다. */
export const canRevise = (s: DisplayStatus) => s === 'COMPLETED' || s === 'REVIEW_REJECTED' || s === 'REVIEW_PENDING' || s === 'RESULT_FILE_MISSING' || s === 'FAILED';

export const FILE_MISSING_ACTIONS = ['화면을 새로 불러와 다시 확인하기', '내용을 수정해 영상을 다시 만들기', '계속 없으면 관리자에게 문의하기(검수는 끝났지만 파일 저장에 문제가 있을 수 있습니다)'];

export async function postJson(url: string, body: unknown, f: typeof fetch = fetch): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

export function revisionMessage(r: { ok: boolean; status: number; data: Record<string, unknown> }): string {
  if (r.ok) return r.status === 200 ? '이미 접수된 요청입니다.' : '수정을 접수했습니다. 장면·내레이션·자막을 함께 다시 만듭니다.';
  if (r.status === 0) return '연결하지 못했습니다. 아무것도 바뀌지 않았습니다. 다시 시도해 주세요.';
  if (r.status === 401 || r.status === 403) return '접근이 만료되었습니다. 다시 로그인해 주세요.';
  return REVISION_ERROR[String(r.data.error)] ?? '반영하지 못했습니다. 아무것도 바뀌지 않았습니다.';
}
