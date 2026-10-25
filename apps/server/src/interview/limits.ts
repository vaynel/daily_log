/** 관리자 결정(Task PM 갱신 3): 하루 1회·세션 최대 10분·세션당 추정 700원. 근접(8분·560원)하면 마무리, 도달하면 종료. */
export interface InterviewLimits {
  maxMs: number;
  wrapMs: number;
  maxCostKrw: number;
  wrapCostKrw: number;
}

export const DEFAULT_LIMITS: InterviewLimits = { maxMs: 10 * 60_000, wrapMs: 8 * 60_000, maxCostKrw: 700, wrapCostKrw: 560 };

export type LimitPhase = 'NORMAL' | 'WRAP_UP' | 'TIME_LIMIT' | 'COST_LIMIT';

/** 누적 사용 시간·추정 비용으로 현재 단계를 판정한다. 도달(>=)이 근접보다 우선한다. */
export function limitPhase(l: InterviewLimits, usedMs: number, costKrw: number): LimitPhase {
  if (costKrw >= l.maxCostKrw) return 'COST_LIMIT';
  if (usedMs >= l.maxMs) return 'TIME_LIMIT';
  if (usedMs >= l.wrapMs || costKrw >= l.wrapCostKrw) return 'WRAP_UP';
  return 'NORMAL';
}

export const WRAP_UP_TEXT = '[진행 안내] 오늘 대화 시간이 거의 끝났습니다. 방금 말씀에 짧게 반응하고, 오늘 꼭 남기고 싶은 것을 묻는 마무리 질문 하나만 한 뒤 따뜻한 인사로 마무리하세요.';

export interface HistoryLine { role: 'user' | 'model'; text: string }

const HISTORY_CHARS = 3000;

/** 이어하기: 오늘 이미 나눈 대화를 지시문에 덧붙인다(같은 질문 반복 금지). 오래된 줄부터 버려 길이를 제한한다. */
export function instructionWithHistory(base: string, history: HistoryLine[]): string {
  const lines = history.filter((h) => h.text.trim()).map((h) => `${h.role === 'user' ? '사용자' : '인터뷰어'}: ${h.text.trim()}`);
  if (!lines.length) return base;
  let used = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i]!.length + 1;
    if (used > HISTORY_CHARS) break;
    kept.unshift(lines[i]!);
  }
  return `${base}\n\n[이어하기] 오늘 이미 아래 대화를 나눴습니다. 인사부터 다시 하지 말고 이어서 진행하며, 이미 물은 질문을 반복하지 마세요.\n${kept.join('\n')}`;
}
