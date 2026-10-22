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
