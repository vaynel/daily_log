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
  | 'COMPLETED'
  | 'RESULT_FILE_MISSING';

export type NextAction = 'CONTINUE_RECORDING' | 'REQUEST_PRODUCTION' | 'WAIT' | 'RETRY' | 'EDIT_AND_REMAKE' | 'DOWNLOAD' | 'RETRY_BACKUP';

/**
 * fileAvailable 이 false 로 확인된 완료 기록은 정상 완료가 아니라 RESULT_FILE_MISSING 이다.
 * undefined(확인하지 않음)는 기존 동작을 유지한다.
 */
export function displayStatus(status: 'IN_PROGRESS' | 'CONFIRMED', p: PipelineState, fileAvailable?: boolean): DisplayStatus {
  if (status === 'IN_PROGRESS') return 'WRITING';
  switch (p.production) {
    case 'NONE': return 'AWAITING_PRODUCTION';
    case 'QUEUED':
    case 'RUNNING': return 'PRODUCING';
    case 'WAITING_BUDGET': return 'BUDGET_WAIT';
    case 'FAILED': return 'FAILED';
    case 'DONE':
      if (p.review === 'REJECTED') return 'REVIEW_REJECTED';
      if (p.review !== 'PASSED') return 'REVIEW_PENDING';
      return fileAvailable === false ? 'RESULT_FILE_MISSING' : 'COMPLETED';
  }
}

/** 제작·검수·백업은 서로 독립이므로 다음 행동도 각각의 상태에서만 정한다. */
export function nextActions(status: 'IN_PROGRESS' | 'CONFIRMED', p: PipelineState, fileAvailable: boolean): NextAction[] {
  const d = displayStatus(status, p, fileAvailable);
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

export type ResultVersionState = 'CURRENT' | 'PREVIOUS' | 'NOT_PASSED' | 'SUPERSEDED_NOT_PASSED';

/**
 * 결과 버전 한 건의 표시 상태(TASK-28). 다운로드 허용 판단은 displayStatus 를 그대로 쓰고 복제하지 않는다.
 * - 최신이고 대체되지 않았으며 displayStatus 가 COMPLETED 일 때만 CURRENT(정상 완성본).
 * - 수정으로 대체된 버전은 항상 PREVIOUS(이전 버전). 대체 당시 검수 통과였던 것만 내려받을 수 있다.
 * - 통과하지 못한 버전은 대체 여부와 상관없이 정상본으로 바뀌지 않는다.
 */
export function resultVersionState(i: { isLatest: boolean; superseded: boolean; wasPassed: boolean | null; status: DisplayStatus }): { state: ResultVersionState; downloadable: boolean } {
  if (i.superseded) return i.wasPassed ? { state: 'PREVIOUS', downloadable: true } : { state: 'SUPERSEDED_NOT_PASSED', downloadable: false };
  if (i.isLatest && i.status === 'COMPLETED') return { state: 'CURRENT', downloadable: true };
  return { state: 'NOT_PASSED', downloadable: false };
}

/** 최신 결과가 수정으로 대체된 뒤 새 결과가 아직 등록되지 않았다면, 파이프라인이 끝난 것처럼 보여도 완료로 표시하지 않는다. */
export function statusWithSupersede(status: DisplayStatus, latestSuperseded: boolean): DisplayStatus {
  return status === 'COMPLETED' && latestSuperseded ? 'PRODUCING' : status;
}
