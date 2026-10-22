import type { PipelineState } from './store.js';

/** 목록·상세에 표시하는 종합 상태. 정상 완료(COMPLETED)와 나머지 비정상·대기 상태는 서로 겹치지 않는다. */
export type DisplayStatus =
  | 'WRITING'
  | 'AWAITING_PRODUCTION'
  | 'PRODUCING'
  | 'BUDGET_WAIT'
  | 'FAILED'
  | 'REVIEW_REJECTED'
  | 'REVIEW_PENDING'
  | 'COMPLETED';

export type NextAction = 'CONTINUE_RECORDING' | 'REQUEST_PRODUCTION' | 'WAIT' | 'RETRY' | 'EDIT_AND_REMAKE' | 'DOWNLOAD' | 'RETRY_BACKUP';

export function displayStatus(status: 'IN_PROGRESS' | 'CONFIRMED', p: PipelineState): DisplayStatus {
  if (status === 'IN_PROGRESS') return 'WRITING';
  switch (p.production) {
    case 'NONE': return 'AWAITING_PRODUCTION';
    case 'QUEUED':
    case 'RUNNING': return 'PRODUCING';
    case 'WAITING_BUDGET': return 'BUDGET_WAIT';
    case 'FAILED': return 'FAILED';
    case 'DONE':
      if (p.review === 'REJECTED') return 'REVIEW_REJECTED';
      return p.review === 'PASSED' ? 'COMPLETED' : 'REVIEW_PENDING';
  }
}

/** 제작·검수·백업은 서로 독립이므로 다음 행동도 각각의 상태에서만 정한다. */
export function nextActions(status: 'IN_PROGRESS' | 'CONFIRMED', p: PipelineState, fileAvailable: boolean): NextAction[] {
  const d = displayStatus(status, p);
  const out: NextAction[] = [];
  if (d === 'WRITING') out.push('CONTINUE_RECORDING');
  else if (d === 'AWAITING_PRODUCTION') out.push('REQUEST_PRODUCTION');
  else if (d === 'PRODUCING' || d === 'BUDGET_WAIT' || d === 'REVIEW_PENDING') out.push('WAIT');
  else if (d === 'FAILED') out.push('RETRY');
  else if (d === 'REVIEW_REJECTED') out.push('EDIT_AND_REMAKE');
  else if (d === 'COMPLETED' && fileAvailable) out.push('DOWNLOAD');
  if (p.backup === 'FAILED') out.push('RETRY_BACKUP');
  return out;
}

const SAFE_NAME = /^[\w][\w.-]{0,150}$/;

/** RESULT 버전 내용에서 결과 파일 이름을 꺼낸다. 경로 문자가 있으면 없는 것으로 본다. */
export function resultFileName(content: unknown): string | null {
  const f = (content as { file?: unknown } | null)?.file;
  return typeof f === 'string' && SAFE_NAME.test(f) && !f.includes('..') ? f : null;
}

export function summaryText(content: unknown): { diary: string | null; learning: string[] } {
  const c = (content ?? {}) as { diary?: unknown; learning?: unknown };
  return {
    diary: typeof c.diary === 'string' ? c.diary : null,
    learning: Array.isArray(c.learning) ? c.learning.filter((x): x is string => typeof x === 'string') : [],
  };
}
