import type { HistoryLine } from './limits.js';

/**
 * 인터뷰 질문 정책(TASK-19). Live systemInstruction 으로 들어가는 지시문과, 그날 대화·첨부만 쓰는 맥락 조립,
 * 대화 뒤 정리(Pro)용 구분 규칙을 한곳에 둔다. 지시문 문장은 PM 갱신 1~4의 원칙을 그대로 옮긴 것이다.
 */

/**
 * PM 실제 모델 평가(2026-10-25) 2차 v2 지시문. 규칙을 맨 앞에 두고 좋은 예/나쁜 예를 붙였을 때
 * 실제 Live 12턴 평가 위반이 15건에서 1건으로 줄었다. 문장을 바꾸면 같은 평가를 다시 해야 한다.
 */
export const INTERVIEW_INSTRUCTION = `[반드시 지킬 규칙 — 매 턴 확인]
1. 물음표(?)는 한 턴에 딱 1개. 질문을 두 개 이상 하지 않는다. 선택지는 한 문장 안에 "A예요, B예요?"로 넣는다.
2. 한 턴은 두 문장, 60자 이내. 첫 문장은 짧은 반응, 둘째 문장은 질문.
3. 첨부 자료는 이름만 알 뿐 내용은 볼 수 없다. 사진·문서 내용을 본 것처럼 말하지 말고, 사용자가 무엇을 했는지 묻는다.
4. 사용자 말을 길게 되풀이하지 않는다. 핵심 단어 하나만 받는다.

[역할]
개발자의 하루(한 일·배운 것·막힌 것과 해결·느낀 점·내일 할 일)를 쇼츠와 일기로 남기려고 함께 정리하는 다정한 인터뷰어. 친한 사람처럼 자연스러운 구어체 존댓말.

[진행]
- 직전 답에서 새 정보 하나(원인·선택·수치·사람·의외였던 점)를 골라 한 단계 더 깊이 묻는다. 한 주제를 두세 번 들었으면 빠진 영역으로 넘어간다.
- 막연한 질문("어땠나요?") 대신 구체적인 갈래를 준다.
- 사용자가 넘어가자고 한 주제는 다시 꺼내지 않는다.
- 처음이나 머뭇거릴 때는 이야기 거리 두세 개를 제안하되 질문은 하나로 한다(예: "오늘 만든 것, 배운 것, 막힌 것 중에 뭐부터 얘기해 볼까요?").
- 어제 일은 사용자가 먼저 말했을 때만 받는다. 조언·설교·긴 설명은 하지 않는다.
- 사용자가 끝내자고 하면 한 문장으로 짧게 인사하고 끝낸다.

[좋은 예]
사용자: 오전엔 에코 버그를 고쳤어.
인터뷰어: 오, 에코 버그 잡으셨군요. 원인 찾는 데 오래 걸렸어요, 고치는 데 오래 걸렸어요?
사용자: 화이트보드 사진 보면 알 거야.
인터뷰어: 사진은 제가 내용까지는 못 봐서요. 거기 적은 것 중에 제일 핵심이 뭐였어요?
사용자: 친구랑 점심 먹었어.
인터뷰어: 오랜만이었나 봐요. 무슨 얘기가 제일 기억에 남아요?

[나쁜 예 — 질문 두 개, 너무 김]
인터뷰어: 에코 버그를 잡으셨다니 대단해요! 원인은 어떻게 찾으셨어요? 코드 문제였나요?`;

export interface AttachmentNote { kind?: string; name?: string | null }

const KIND_LABEL: Record<string, string> = { PHOTO: '사진', MARKDOWN: 'Markdown 자료', NOTE: '학습 메모' };
const MAX_ATTACHMENTS = 10;
const MAX_NAME = 40;

/** 파일 이름은 제어문자·줄바꿈을 지우고 자른다(지시문 주입 방지). 내용은 싣지 않는다. */
export function attachmentLine(a: AttachmentNote): string {
  const label = KIND_LABEL[a.kind ?? ''] ?? '자료';
  const name = (a.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name ? `- ${label}: ${name}` : `- ${label}`;
}

/** 그날 첨부 목록 블록. 첨부가 없으면 없다고 명시해 모델이 자료를 지어내지 않게 한다. */
export function attachmentBlock(list: AttachmentNote[]): string {
  if (!list.length) return '[오늘 첨부 자료]\n없음. 첨부 자료를 언급하지 마세요.';
  const shown = list.slice(0, MAX_ATTACHMENTS).map(attachmentLine);
  const more = list.length > shown.length ? [`- 외 ${list.length - shown.length}건`] : [];
  return `[오늘 첨부 자료] (제목·종류만 알고 있으며 사용자가 이해·수행했는지는 모릅니다)\n${[...shown, ...more].join('\n')}`;
}

const HISTORY_CHARS = 3000;

/** 이어하기: 오늘 이미 나눈 대화에서 어떤 말을 했는지 지시문에 덧붙인다. 오래된 줄부터 버려 길이를 제한한다. */
export function historyBlock(history: HistoryLine[]): string {
  const lines = history.filter((h) => h.text.trim()).map((h) => `${h.role === 'user' ? '사용자' : '인터뷰어'}: ${h.text.trim().replace(/\s+/g, ' ')}`);
  if (!lines.length) return '';
  let used = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i]!.length + 1;
    if (used > HISTORY_CHARS) break;
    kept.unshift(lines[i]!);
  }
  return `[이어하기] 오늘 이미 아래 대화를 나눴습니다. 인사부터 다시 하지 말고 이어서 진행하며, 이미 대답한 주제나 이미 물은 질문은 다시 묻지 마세요. 사용자가 넘어가자고 한 주제는 건너뛰세요.\n${kept.join('\n')}`;
}

/** Live systemInstruction: 정책 + 그날 첨부 + 그날 대화. 입력은 호출자가 그날 기록에서만 가져온다. */
export function buildInterviewInstruction(o: { history?: HistoryLine[]; attachments?: AttachmentNote[]; base?: string }): string {
  const parts = [o.base ?? INTERVIEW_INSTRUCTION, attachmentBlock(o.attachments ?? [])];
  const h = historyBlock(o.history ?? []);
  if (h) parts.push(h);
  return parts.join('\n\n');
}

// ---- D16-04: 대화 뒤 정리에서 사실·자료·의견·불확실성을 구분 ----

export type StatementKind = 'FACT' | 'MATERIAL' | 'OPINION' | 'UNCERTAIN';
export type StatementSource = 'USER' | 'ATTACHMENT';
export interface Statement { kind: StatementKind; source: StatementSource; text: string }

/** Pro 정리 단계(브리핑·대본) 지시문 조각. 모델 출력은 JSON 배열이며 parseStatements 로 검증한다. */
export const ORGANIZE_INSTRUCTION = [
  '아래 전사와 첨부 목록에서 문장을 뽑아 JSON 배열로만 답하세요. 각 항목은 {"kind","source","text"} 입니다.',
  'kind: FACT=사용자가 직접 말한 한 일·사실, MATERIAL=첨부 자료에 들어 있는 내용(사용자의 경험으로 쓰지 않음), OPINION=사용자의 생각·감정·평가, UNCERTAIN=사용자가 확실하지 않다고 말했거나 근거가 없는 것.',
  'source: 사용자가 말한 것은 USER, 첨부에서 온 것은 ATTACHMENT. 첨부에서 온 MATERIAL 은 사용자가 이해했거나 수행했다고 말하지 않았다면 FACT 로 바꾸지 마세요.',
  '전사에 없는 사실을 만들지 마세요. 전날 기록은 사용하지 않습니다.',
].join('\n');

const KINDS = new Set<StatementKind>(['FACT', 'MATERIAL', 'OPINION', 'UNCERTAIN']);

export type ParseResult = { ok: true; statements: Statement[] } | { ok: false; code: 'NOT_JSON' | 'BAD_SHAPE' | 'ATTACHMENT_AS_FACT'; index?: number };

/**
 * 모델 출력 검증. 첨부에서 온 문장이 사용자 사실(FACT)·사용자 출처로 둔갑하면 거절한다(AC-4).
 * 규칙: ATTACHMENT 출처는 MATERIAL 만, MATERIAL 은 ATTACHMENT 출처만 허용하고, FACT/OPINION 은 USER 출처만 허용한다.
 */
export function parseStatements(raw: string): ParseResult {
  let v: unknown;
  try { v = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, code: 'NOT_JSON' }; }
  if (!Array.isArray(v)) return { ok: false, code: 'BAD_SHAPE' };
  const out: Statement[] = [];
  for (const [i, e] of v.entries()) {
    const s = e as Partial<Statement> | null;
    if (!s || typeof s.text !== 'string' || !s.text.trim() || !KINDS.has(s.kind as StatementKind) || (s.source !== 'USER' && s.source !== 'ATTACHMENT')) return { ok: false, code: 'BAD_SHAPE', index: i };
    if ((s.source === 'ATTACHMENT') !== (s.kind === 'MATERIAL') && s.kind !== 'UNCERTAIN') return { ok: false, code: 'ATTACHMENT_AS_FACT', index: i };
    out.push({ kind: s.kind as StatementKind, source: s.source, text: s.text.trim() });
  }
  return { ok: true, statements: out };
}
