import { ORGANIZE_INSTRUCTION, attachmentBlock, parseStatements, type AttachmentNote, type Statement, type StatementKind, type StatementSource } from '../interview/policy.js';
import type { InterviewLimits } from '../interview/limits.js';
import { classifyExclusion, EXCLUSION_LABEL, isSecurityLearning, type ExclusionReason } from './exclusion.js';

/**
 * 통합 브리핑(TASK-20). 대화 종료 뒤 Pro 로 정리한 문장(사실·자료·의견·불확실)을 받아
 * 하루 요약과 영상 핵심을 한 화면·한 음성 안내에 함께 보여 준다. 사용자가 확인하기 전에는 제작 작업이 만들어지지 않는다.
 */

export type ExcludedReason = ExclusionReason | 'UNCERTAIN' | 'MATERIAL' | 'USER';

export interface BriefingItem {
  id: string;
  kind: StatementKind;
  source: StatementSource;
  text: string;
  emphasis: boolean;
  /** 공개 제작(영상) 입력에 쓰이는지. */
  inVideo: boolean;
  /** 영상에서 뺀 이유. 길이 제한 때문에 고르지 않은 항목은 null. */
  excludedReason: ExcludedReason | null;
  topic?: 'SECURITY';
}

export const MAX_VIDEO_ITEMS = 6;

const EMPHASIS = /제일|가장|특히|무엇보다|핵심|꼭|중요/;

export const EXCLUDED_LABEL: Record<ExcludedReason, string> = {
  ...EXCLUSION_LABEL, UNCERTAIN: '확실하지 않은 내용', MATERIAL: '첨부 자료 내용(내가 한 일이 아님)', USER: '내가 뺀 내용',
};

/** 정리 결과 → 브리핑 항목. 영상 선정: 사실·의견 중 제외 대상이 아닌 것, 강조 우선, 최대 MAX_VIDEO_ITEMS. */
export function buildItems(statements: Statement[]): BriefingItem[] {
  const base: BriefingItem[] = statements.map((s, i) => {
    const emphasis = s.emphasis === true || (s.source === 'USER' && EMPHASIS.test(s.text));
    let excludedReason: ExcludedReason | null = null;
    if (s.kind === 'UNCERTAIN') excludedReason = 'UNCERTAIN';
    else if (s.kind === 'MATERIAL') excludedReason = 'MATERIAL';
    else excludedReason = classifyExclusion(s.text);
    return { id: `s${i + 1}`, kind: s.kind, source: s.source, text: s.text, emphasis, inVideo: false, excludedReason, ...(isSecurityLearning(s.text) ? { topic: 'SECURITY' as const } : {}) };
  });
  return selectVideo(base);
}

/** 제외 사유가 없는 항목 중 강조 우선·원래 순서로 최대 개수까지 영상에 넣는다. 사용자 제외·정정 뒤에도 같은 규칙을 다시 적용한다. */
export function selectVideo(items: BriefingItem[]): BriefingItem[] {
  const eligible = items.filter((i) => i.excludedReason === null);
  const chosen = new Set([...eligible.filter((i) => i.emphasis), ...eligible.filter((i) => !i.emphasis)].slice(0, MAX_VIDEO_ITEMS).map((i) => i.id));
  return items.map((i) => ({ ...i, inVideo: chosen.has(i.id) }));
}

export interface BriefingView {
  /** 하루 요약: 내가 한 일·생각(제외된 항목도 기록에는 남으므로 요약에는 표시). */
  summary: { id: string; text: string }[];
  /** 영상 핵심: 캐릭터가 1인칭으로 말할 내용. */
  video: { id: string; text: string }[];
  excluded: { id: string; text: string; reason: ExcludedReason; label: string }[];
  /** 같은 단계에서 한 번에 읽어 주는 음성 안내문. */
  speech: string;
}

export function viewOf(items: BriefingItem[]): BriefingView {
  const summary = items.filter((i) => i.kind === 'FACT' || i.kind === 'OPINION').map((i) => ({ id: i.id, text: i.text }));
  const video = items.filter((i) => i.inVideo).map((i) => ({ id: i.id, text: i.text }));
  const excluded = items.filter((i) => i.excludedReason).map((i) => ({ id: i.id, text: i.text, reason: i.excludedReason!, label: EXCLUDED_LABEL[i.excludedReason!] }));
  return { summary, video, excluded, speech: speechOf(summary, video, excluded.length) };
}

function speechOf(summary: { text: string }[], video: { text: string }[], excludedCount: number): string {
  const day = summary.length ? `오늘 하루는 ${summary.map((s) => s.text).join(' ')}` : '오늘 정리할 내용이 많지 않아요.';
  const core = video.length ? `영상에는 ${video.map((s) => s.text).join(' ')} 이 내용을 담을게요.` : '영상에 담을 내용이 아직 없어요.';
  const ex = excludedCount ? ` 영상에서 뺀 내용이 ${excludedCount}개 있어요.` : '';
  return `${day} ${core}${ex} 맞으면 확인을 눌러 주세요. 고칠 부분만 말씀하시면 그 부분만 다시 정리할게요.`;
}

// ---- 진입(D17-01) ----

export type EntryDecision = { enter: true; reason: 'USER_FINISH' | 'TIME_LIMIT' | 'COST_LIMIT' } | { enter: false; reason: 'NO_CONTENT' | 'NOT_FINISHED' };

/**
 * 마무리 의사(사용자가 끝냄) 또는 약 10분(시간·비용 상한) 도달이면 브리핑으로 들어간다. 사용자 답변이 하나도 없으면 들어가지 않는다.
 * 일시정지·연결 끊김처럼 끝낸 것이 아닌 경우에는 이어서 대화할 수 있으므로 들어가지 않는다.
 */
export function decideEntry(i: { answers: number; endReason: string | null; finishRequested: boolean; usedMs: number; limits: InterviewLimits }): EntryDecision {
  if (i.answers < 1) return { enter: false, reason: 'NO_CONTENT' };
  if (i.endReason === 'TIME_LIMIT' || i.endReason === 'COST_LIMIT') return { enter: true, reason: i.endReason };
  if (i.endReason === 'USER_END' || i.finishRequested) return { enter: true, reason: 'USER_FINISH' };
  if (i.usedMs >= i.limits.maxMs) return { enter: true, reason: 'TIME_LIMIT' };
  return { enter: false, reason: 'NOT_FINISHED' };
}

// ---- 생성(D17-02): Pro 정리 → 검증 → 필터 ----

export type ProOutcome = { state: 'SUCCEEDED'; text: string } | { state: string };
/** Pro 구독 경로(runtime.infer)와 같은 모양의 호출. 유료 모델로 자동 전환하지 않으므로 대기 상태는 그대로 돌려준다. */
export type ProInfer = (input: { text: string }) => Promise<ProOutcome>;

export type GenerateResult =
  | { ok: true; items: BriefingItem[]; proCalls: number }
  | { ok: false; code: 'PRO_WAITING' | 'BAD_OUTPUT'; state?: string; proCalls: number };

export function organizePrompt(conversation: { role: 'user' | 'model'; text: string }[], attachments: AttachmentNote[]): string {
  const transcript = conversation.filter((c) => c.text.trim()).map((c) => `${c.role === 'user' ? '사용자' : '인터뷰어'}: ${c.text.trim().replace(/\s+/g, ' ')}`).join('\n');
  return [
    ORGANIZE_INSTRUCTION,
    '사용자가 직접 "제일/가장/핵심/중요"처럼 강조한 항목에는 "emphasis":true 를 추가하세요. 사용자가 확실하지 않다고 한 사실은 UNCERTAIN 으로 두고 되묻지 마세요.',
    attachmentBlock(attachments),
    `[전사]\n${transcript}`,
  ].join('\n\n');
}

/** 같은 입력으로 형식 오류에 한해 한 번만 다시 호출한다(처리 오류 자동 재시도 1회 원칙). */
export async function generateBriefing(i: { conversation: { role: 'user' | 'model'; text: string }[]; attachments: AttachmentNote[]; infer: ProInfer }): Promise<GenerateResult> {
  const text = organizePrompt(i.conversation, i.attachments);
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const out = await i.infer({ text }).catch(() => ({ state: 'WAIT_RECONCILIATION' }) as ProOutcome);
    if (out.state !== 'SUCCEEDED' || typeof (out as { text?: unknown }).text !== 'string') return { ok: false, code: 'PRO_WAITING', state: out.state, proCalls: calls };
    const parsed = parseStatements((out as { text: string }).text);
    if (parsed.ok) return { ok: true, items: buildItems(parsed.statements), proCalls: calls };
  }
  return { ok: false, code: 'BAD_OUTPUT', proCalls: calls };
}

// ---- 정정(D17-04, AC-3): 지정한 항목만 바꾸고 다시 선정한다 ----

export type Correction = { itemId: string; action: 'EXCLUDE' | 'REPLACE' | 'INCLUDE'; text?: string };

export type CorrectionResult = { ok: true; items: BriefingItem[]; changed: BriefingItem; speech: string } | { ok: false; code: 'NOT_FOUND' | 'BAD_TEXT' | 'NOT_ALLOWED' };

const MAX_TEXT = 300;

export function applyCorrection(items: BriefingItem[], c: Correction): CorrectionResult {
  const target = items.find((i) => i.id === c.itemId);
  if (!target) return { ok: false, code: 'NOT_FOUND' };
  let next: BriefingItem;
  if (c.action === 'EXCLUDE') next = { ...target, excludedReason: 'USER' };
  else if (c.action === 'REPLACE') {
    const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_TEXT) return { ok: false, code: 'BAD_TEXT' };
    // 사용자가 직접 고친 문장은 사용자의 사실이다. 단 정책 제외·불확실 표시는 문장이 바뀌어도 다시 판정한다.
    const reason = classifyExclusion(text);
    next = { ...target, kind: target.kind === 'MATERIAL' || target.kind === 'UNCERTAIN' ? 'FACT' : target.kind, source: 'USER', text, excludedReason: reason, ...(isSecurityLearning(text) ? { topic: 'SECURITY' as const } : { topic: undefined }) };
  } else {
    // 되돌리기: 정책 제외·첨부 자료·불확실 항목은 사용자가 되살려도 공개 입력에 넣지 않는다.
    if (target.kind === 'UNCERTAIN' || target.kind === 'MATERIAL' || classifyExclusion(target.text)) return { ok: false, code: 'NOT_ALLOWED' };
    next = { ...target, excludedReason: null };
  }
  const items2 = selectVideo(items.map((i) => (i.id === next.id ? next : i)));
  const changed = items2.find((i) => i.id === next.id)!;
  const speech = changed.excludedReason
    ? `알겠어요. "${changed.text}" 부분은 영상에서 뺄게요. 나머지는 그대로예요. 이제 확인을 눌러 주세요.`
    : `알겠어요. 이 부분만 "${changed.text}"로 바꿨어요. 나머지는 그대로예요. 이제 확인을 눌러 주세요.`;
  return { ok: true, items: items2, changed, speech };
}

// ---- 제작 입력(D17-04): 확인 시점의 공개용 내용 ----

export interface ProductionPlan {
  source: 'BRIEFING';
  briefingVersion: number;
  /** 캐릭터 A가 1인칭 담담한 독백으로 말할 공개용 문장. 불확실·첨부 자료·제외 항목은 들어가지 않는다. */
  lines: string[];
}

export function planOf(items: BriefingItem[], briefingVersion: number): ProductionPlan {
  return { source: 'BRIEFING', briefingVersion, lines: items.filter((i) => i.inVideo && i.excludedReason === null).map((i) => i.text) };
}

export const VIDEO_JOB_KIND = 'VIDEO_PRODUCTION';
export const VIDEO_JOB_STAGES = ['PRODUCE'];
export const videoJobKey = (interviewId: string, briefingVersion: number) => `produce:${interviewId}:${briefingVersion}`;
