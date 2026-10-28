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
  result: { version: number; fileAvailable: boolean; playable: boolean; confirmedAt: string | null; published: boolean } | null;
  previousResultCount: number;
  editableItems: EditableItem[];
}
export interface EditableItem { id: string; text: string; inVideo: boolean; excludedReason: string | null }
export interface ResultVersion {
  version: number; role: 'CURRENT' | 'PREVIOUS'; status: DisplayStatus | 'SUPERSEDED'; priorStatus?: string;
  fileAvailable: boolean; downloadable: boolean; confirmedAt?: string | null;
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

export const resultFileUrl = (id: string, version: number, inline: boolean) => `/api/records/${id}/results/${version}/file${inline ? '?inline=1' : ''}`;

/** 이전 버전은 어떤 경우에도 "완료"로 표시하지 않는다. 수정 전 상태를 함께 알려 준다. */
export function versionLabel(v: ResultVersion): string {
  if (v.role === 'CURRENT') return STATUS_INFO[v.status as DisplayStatus]?.label ?? '알 수 없음';
  return v.priorStatus === 'COMPLETED' ? '이전 버전 (수정 전 검수 통과)' : '이전 버전 (수정 전 검수 통과 못 함)';
}

/** 파일이 없거나 막힌 이유와 할 수 있는 조치. 상태별로 서로 다른 문구를 쓴다. */
export function resultProblem(status: DisplayStatus, fileAvailable: boolean): { reason: string; action: string } | null {
  if (status === 'RESULT_FILE_MISSING' || (status === 'COMPLETED' && !fileAvailable)) {
    return { reason: '검수는 끝났지만 영상 파일을 찾을 수 없어 재생하거나 내려받을 수 없습니다.', action: '아래 "수정해서 다시 만들기"로 영상을 새로 만들 수 있습니다. 기록 원본은 그대로입니다.' };
  }
  if (status === 'REVIEW_REJECTED') return { reason: '영상이 검수를 통과하지 못해 재생과 내려받기를 막았습니다.', action: '내용을 수정해 다시 만들 수 있습니다. 이전에 통과한 버전은 완성본으로 바뀌지 않습니다.' };
  if (status === 'FAILED') return { reason: '제작 처리 중 오류가 나서 영상이 만들어지지 않았습니다.', action: '"다시 시도"를 누르거나 내용을 수정해 다시 만들 수 있습니다.' };
  if (status === 'REVIEW_PENDING') return { reason: '영상이 만들어졌고 검수를 기다립니다. 통과 전에는 재생하지 않습니다.', action: '검수가 끝날 때까지 기다려 주세요.' };
  return null;
}

export const REVISE_ERROR: Record<string, string> = {
  INVALID_STATE: '지금은 제작 또는 검수가 진행 중이라 수정할 수 없습니다. 끝난 뒤에 다시 시도해 주세요.',
  STALE_BRIEFING: '화면의 내용이 최신이 아닙니다. 새로 불러온 뒤 다시 시도해 주세요.',
  NOTHING_TO_PRODUCE: '영상에 담을 내용이 모두 없어져 다시 만들 수 없습니다. 일부만 빼 주세요.',
  NO_BRIEFING: '이 기록은 화면에서 수정할 수 없습니다.',
  NOT_RETRYABLE: '처리 실패한 제작만 다시 시도할 수 있습니다.',
  UNRESOLVED_EXTERNAL: '외부 처리 결과를 먼저 확인해야 해서 지금은 다시 시도할 수 없습니다.',
  BAD_TEXT: '고칠 문장을 1~300자로 입력해 주세요.',
  NOT_FOUND: '수정할 항목을 찾을 수 없습니다.',
};

export type ReviseBody = { commandId: string; kind: 'EXCLUDE' | 'EDIT_TEXT' | 'VOICE' | 'RETRY'; itemId?: string; text?: string; command?: string };
export type ReviseOutcome = { state: 'done'; duplicate: boolean } | { state: 'not-executed'; message: string } | { state: 'error'; message: string };

/** 수정·재시도 명령 전송. 서버가 거부한 사유는 사람이 읽는 문구로 바꾼다. */
export async function sendRevision(id: string, body: ReviseBody, f: typeof fetch = fetch): Promise<ReviseOutcome> {
  try {
    const r = await f(`/api/records/${id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { executed?: boolean; duplicate?: boolean; error?: string; message?: string };
    if (r.status === 401 || r.status === 403) return { state: 'error', message: '접근이 만료되었습니다. 다시 로그인해 주세요.' };
    if (r.ok && j.executed === false) return { state: 'not-executed', message: j.message ?? '아무것도 바꾸지 않았습니다.' };
    if (r.ok) return { state: 'done', duplicate: j.duplicate === true };
    return { state: 'error', message: (j.error && REVISE_ERROR[j.error]) || '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  } catch {
    return { state: 'error', message: '연결을 확인하고 다시 시도해 주세요. 같은 요청이 두 번 처리되지는 않습니다.' };
  }
}

export const newCommandId = () => (globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
