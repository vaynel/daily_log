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
  result: { version: number; fileAvailable: boolean; superseded?: boolean } | null;
  revisableItems?: { id: string; text: string }[];
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

// ---- 결과 확인·수정·다운로드(TASK-28) ----

export type ResultVersionState = 'CURRENT' | 'PREVIOUS' | 'NOT_PASSED' | 'SUPERSEDED_NOT_PASSED';
export interface ResultVersion { version: number; state: ResultVersionState; downloadable: boolean; playable: boolean; fileAvailable: boolean; createdAt: string }

export const RESULT_STATE_LABEL: Record<ResultVersionState, string> = {
  CURRENT: '현재 완성본', PREVIOUS: '이전 버전(현재 완성본 아님)', NOT_PASSED: '검수 미통과', SUPERSEDED_NOT_PASSED: '미통과 이전 버전',
};

export const resultFileUrl = (id: string, version: number, download = false) => `/api/records/${id}/results/${version}/file${download ? '?download=1' : ''}`;

/** 영상을 볼 수 없을 때 이유와 가능한 조치(AC-3). 정상 완료이고 파일이 있으면 null. */
export function resultProblem(status: DisplayStatus, fileAvailable: boolean | undefined): { reason: string; actions: string[] } | null {
  if (status === 'COMPLETED' && fileAvailable !== false) return null;
  switch (status) {
    case 'RESULT_FILE_MISSING': case 'COMPLETED':
      return { reason: '결과 파일을 찾을 수 없어 재생·내려받기를 할 수 없습니다.', actions: ['잠시 뒤 새로고침해 보세요.', '계속 같으면 “다시 만들기”로 영상을 새로 만드세요.', '백업이 확인된 기록이면 관리자에게 복구를 요청하세요.'] };
    case 'REVIEW_REJECTED':
      return { reason: '영상이 검수를 통과하지 못해 보여드리지 않습니다.', actions: ['내용을 수정한 뒤 “다시 만들기”를 누르세요.', '문제가 되는 부분을 영상에서 빼고 다시 만들 수 있습니다.'] };
    case 'FAILED':
      return { reason: '제작 처리 중 오류가 나서 영상이 만들어지지 않았습니다.', actions: ['“다시 시도”를 누르세요.'] };
    case 'BUDGET_WAIT':
      return { reason: '이번 달 추가 비용 한도 때문에 제작이 대기 중입니다.', actions: ['한도가 풀리면 자동으로 이어집니다. 유료로 자동 전환하지 않습니다.'] };
    case 'REVIEW_PENDING':
      return { reason: '영상이 만들어졌고 검수를 기다립니다. 통과 전에는 볼 수 없습니다.', actions: ['검수가 끝날 때까지 기다려 주세요.'] };
    case 'PRODUCING':
      return { reason: '영상을 만들고 있습니다. 수정한 경우 이전 영상은 완성본이 아니라 이전 버전으로만 표시됩니다.', actions: ['끝나면 이 화면에 표시됩니다.'] };
    default:
      return { reason: '아직 볼 수 있는 영상이 없습니다.', actions: [] };
  }
}

export type RevisionRequest =
  | { type: 'EXCLUDE'; itemId: string }
  | { type: 'EDIT_TEXT'; itemId: string; text: string }
  | { type: 'VOICE'; text: string; itemId?: string }
  | { type: 'RETRY' };

export interface RevisionOutcome { executed: boolean; message: string; ok: boolean }

/** 수정 요청을 보낸다. commandId 는 요청마다 새로 만들고 재전송에는 같은 값을 쓴다(중복 제작 방지). */
export async function postRevision(id: string, req: RevisionRequest, commandId: string, f: typeof fetch = fetch): Promise<RevisionOutcome> {
  try {
    const r = await f(`/api/records/${id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...req, commandId }) });
    const body = (await r.json().catch(() => ({}))) as { executed?: boolean; message?: string; error?: string };
    if (r.status === 401 || r.status === 403) return { ok: false, executed: false, message: '접근이 만료되었습니다. 다시 로그인해 주세요.' };
    if (r.ok && body.executed) return { ok: true, executed: true, message: '수정 요청을 접수했습니다. 영상을 다시 만들고 있고, 끝나기 전에는 이전 영상이 완성본으로 표시되지 않습니다.' };
    if (r.ok) return { ok: true, executed: false, message: body.message ?? '아무것도 바꾸지 않았습니다.' };
    return { ok: false, executed: false, message: body.message ?? '수정 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  } catch {
    return { ok: false, executed: false, message: '연결을 확인하고 다시 시도해 주세요. 아무것도 바꾸지 않았습니다.' };
  }
}
