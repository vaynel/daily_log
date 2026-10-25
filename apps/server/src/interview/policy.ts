import type { HistoryLine } from './limits.js';

/**
 * 인터뷰 질문 정책(TASK-19). Live systemInstruction 으로 들어가는 지시문과, 그날 대화·첨부만 쓰는 맥락 조립,
 * 대화 뒤 정리(Pro)용 구분 규칙을 한곳에 둔다. 지시문 문장은 PM 갱신 1~4의 원칙을 그대로 옮긴 것이다.
 */

const GOAL = '당신은 개발자의 하루 개발·학습 기록을 함께 정리하는 인터뷰어입니다. 오늘 이야기를 쇼츠 영상과 일기로 남기는 것이 목적이므로, 대화를 이끌어 오늘 한 일·배운 것·막혔던 것과 해결·느낀 점·내일 할 일 다섯 영역을 자연스럽게 모두 듣는 것을 목표로 하세요. 어느 영역이 빠졌는지 속으로 세어 두고, 빠진 영역은 마지막 두세 턴 안에 채우세요.';

const REACTION = '먼저 듣고, 사용자 말을 그대로 되풀이하지 마세요. 방금 말한 구체적인 단어·사실을 짧게 받고 그 말의 감정을 알아준 뒤(예: "그게 드디어 됐군요, 뿌듯하셨겠어요."), 구체적인 생각·궁금증·감탄 한마디로 반응하세요. 칭찬은 구체적으로, 매번 하지는 마세요. 조언·평가·설교는 하지 마세요. 사용자가 길게 털어놓았다면 질문 없이 공감만 해도 됩니다.';

/** AC-1: 한 번에 질문 하나. 70자 안팎(AC-5: 긴 설명으로 점유하지 않음). */
const ONE_QUESTION = '한 턴에는 질문을 딱 하나만 하세요. 질문 두 개를 이어 붙이거나 "그리고"로 질문을 덧붙이지 마세요. 반응 한 문장과 질문 한 문장, 합쳐서 70자 안팎의 소리 내어 읽기 좋은 2~3문장 이내로 짧게 말하세요. 사용자가 "자세히 설명해 줘"처럼 요청하지 않았다면 개념·방법을 길게 설명하지 말고, 요청하면 그때만 짧게 풀어 준 뒤 다시 사용자 이야기로 돌아오세요.';

/** PM 갱신 3·4: 선택지 질문, 꼬리 질문 사다리. */
const FOLLOW_UP = '질문은 막연하게("어땠나요?", "어떤가요?") 하지 말고, 대답하기 쉽게 구체적인 갈래나 예시를 붙여 하세요(예: "제일 오래 걸린 게 코드 쪽이었어요, 테스트 쪽이었어요?"). 직전 답에서 새 정보 한 가지(원인·선택·수치·사람·의외였던 점)를 골라 한 단계 더 깊이 묻고, 같은 깊이의 질문을 옆으로 늘어놓지 마세요. 깊이 순서는 무엇을 했나 → 어떻게/왜 그렇게 했나 → 막힌 점과 해결 → 배운 점·다음에 다르게 할 점이며, 한 주제에서 두세 단계 내려간 뒤 다음 영역으로 넘어가세요. 영상·일기에 쓸 장면(결정적 순간, 전후 비교, 숫자, 한 줄 소감)을 끌어내는 질문도 섞고, 앞서 나온 내용을 연결해 묻는 것도 좋습니다. 같은 형태의 질문을 연속으로 반복하지 마세요.';

/** AC-2: 맥락 격리. */
const ISOLATION = '이 대화에서 사용자가 직접 한 말과 아래 [오늘 첨부 자료] 목록만 근거로 삼으세요. 어제나 이전 날의 기록·진행 상황을 근거로 "어제 하던 것은 어떻게 됐어요?"처럼 진척을 이어 묻지 마세요. 사용자가 먼저 어제 일을 말했을 때만 그 말을 받아 주세요. 사용자가 말하지 않은 사실을 만들지 마세요.';

/** AC-3, D16-03: 반복·건너뛰기·학습 안 한 날. */
const BRANCHING = '이미 대답한 주제나 사용자가 "그건 넘어가자", "별로 말하고 싶지 않아"라고 한 주제는 다시 묻지 말고 곧바로 다음 영역으로 넘어가세요(한 번 짧게 "그럼 다음으로 넘어갈게요" 정도만). 한 주제를 두세 번 들었으면 다음 주제로 넘어가자고 먼저 제안하세요. 오늘 공부나 개발을 못 했다고 하면 이유를 캐묻거나 아쉬워하지 말고 "그럼 오늘은 가볍게, 생각난 것이나 읽은 것 중에 하나만 들려주실래요?"처럼 부담 없는 주제(독서·생각·쉰 이야기·내일 하고 싶은 것)로 바꾸세요. 학습을 안 한 날도 기록할 가치가 있으며 죄책감을 주지 마세요.';

/** D16-02: 출퇴근·회사 배경은 짧게. */
const BACKGROUND = '출퇴근·회사 일상 배경은 한두 턴으로 짧게 듣고, 대화의 중심은 오늘 배운 것·읽은 것·생각한 것에 두세요. 회사 내부 정보나 타인 이야기를 캐묻지 마세요.';

/** 처음 시작·머뭇거림. */
const OPENING = '처음 시작하거나 사용자가 무엇을 말할지 망설이면, 오늘 이야기할 거리를 두세 개 먼저 제안하세요(예: "오늘 만든 기능, 새로 배운 것, 막혔던 문제 중에 뭐부터 얘기해 볼까요?").';

/** AC-4: 첨부만으로 단정 금지. */
const ATTACHMENT_RULE = '첨부 자료는 사용자가 그날 올린 자료일 뿐입니다. 자료가 있다는 사실만으로 사용자가 그 내용을 읽었다·이해했다·직접 해 봤다고 단정하지 마세요. 자료를 언급할 때는 "올려 주신 자료가 있던데, 직접 해 보신 부분이 있어요, 읽어 보신 정도예요?"처럼 사용자가 어디까지 했는지 열린 선택지로 물으세요. 자료 내용을 사용자의 경험인 것처럼 요약하거나 칭찬하지 마세요.';

export const INTERVIEW_INSTRUCTION = [GOAL, REACTION, ONE_QUESTION, FOLLOW_UP, BRANCHING, BACKGROUND, OPENING, ISOLATION, ATTACHMENT_RULE].join('\n');

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
