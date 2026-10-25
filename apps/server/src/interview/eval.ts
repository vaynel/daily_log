/**
 * 대표 대화 평가표(TASK-19). 모델 답변 한 턴을 규칙으로 점검한다. 규칙 검사이며 사용자 자연스러움(4/5)을 대신하지 않는다.
 * 실제 Live 모델 답변은 비용 원칙상 이 저장소 시험에서 호출하지 않으므로, 전사(사람이 정한 시나리오 또는 실기기 세션 기록)를 입력으로 쓴다.
 */
export type Violation = 'MULTI_QUESTION' | 'TOO_LONG' | 'VAGUE_QUESTION' | 'REPEATED_SHAPE' | 'PRIOR_DAY' | 'REPEATED_TOPIC' | 'ASSERTS_ATTACHMENT' | 'ECHO';

export const MAX_REPLY_CHARS = 100;
const VAGUE = /(어땠나요|어떤가요|어땠어요\?|어떠셨나요|어떻게 생각하세요)\s*[?？]?\s*$/;
const PRIOR_DAY = /(어제|전날|지난번|저번에|그저께)/;
const ASSERT_ATTACHMENT = /(자료를|자료는|글을|문서를|책을).{0,12}(읽으셨|이해하셨|공부하셨|해 보셨|따라 하셨)(?![^.?!]*[?？])/;

export const questionCount = (t: string) => (t.match(/[?？]/g) ?? []).length;
/** 마지막 질문 문장의 앞 두 어절. 같은 틀("어떤 부분이 …")의 반복을 잡는다. */
const shape = (t: string) => (t.match(/[^.!?？]*[?？]/g)?.pop() ?? '').trim().split(/\s+/).slice(0, 2).join(' ');
const norm = (t: string) => t.replace(/[\s.,!?'"·]/g, '');

export interface EvalTurn { user: string; ai: string }
export interface EvalOptions {
  /** 사용자가 건너뛰자고 한 주제 키워드가 이후 AI 턴에 다시 나오면 반복으로 본다. */
  skipped?: { afterTurn: number; keyword: string }[];
}

/** 한 대화를 평가해 턴 번호(1부터)별 위반을 돌려준다. */
export function evaluateConversation(turns: EvalTurn[], o: EvalOptions = {}): { turn: number; violation: Violation }[] {
  const out: { turn: number; violation: Violation }[] = [];
  const add = (turn: number, violation: Violation) => out.push({ turn, violation });
  turns.forEach((t, i) => {
    const n = i + 1;
    if (questionCount(t.ai) > 1) add(n, 'MULTI_QUESTION');
    if (t.ai.length > MAX_REPLY_CHARS) add(n, 'TOO_LONG');
    if (VAGUE.test(t.ai.trim())) add(n, 'VAGUE_QUESTION');
    if (i > 0 && questionCount(t.ai) > 0 && questionCount(turns[i - 1]!.ai) > 0 && shape(t.ai) === shape(turns[i - 1]!.ai)) add(n, 'REPEATED_SHAPE');
    if (PRIOR_DAY.test(t.ai) && !turns.slice(0, i + 1).some((x) => PRIOR_DAY.test(x.user))) add(n, 'PRIOR_DAY');
    if (ASSERT_ATTACHMENT.test(t.ai)) add(n, 'ASSERTS_ATTACHMENT');
    const u = norm(t.user);
    if (u.length >= 8 && norm(t.ai).includes(u)) add(n, 'ECHO');
    for (const s of o.skipped ?? []) if (n > s.afterTurn && t.ai.includes(s.keyword)) add(n, 'REPEATED_TOPIC');
  });
  return out;
}
