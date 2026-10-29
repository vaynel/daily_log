import { classifyCommand, keywordsFromCommand } from '../briefing/rules.js';
import { classifyExclusion } from '../briefing/exclusion.js';
import type { ProductionPlan } from '../briefing/briefing.js';

/** 수정 범위가 정해지면 장면·내레이션·자막은 항상 같은 제작 계획에서 함께 다시 만든다(따로 낡은 채로 남기지 않는다). */
export const REMAKE_COMPONENTS = ['SCENE', 'NARRATION', 'SUBTITLE'] as const;

export type RevisionKind = 'EXCLUDE' | 'EDIT_TEXT' | 'VOICE' | 'RETRY';
export type RevisionRequest =
  | { kind: 'EXCLUDE'; itemId?: string; keyword?: string }
  | { kind: 'EDIT_TEXT'; itemId: string; text: string }
  | { kind: 'VOICE'; text: string }
  | { kind: 'RETRY' };

/** 수정이 반영된 제작 계획. ProductionPlan 과 호환되며 수정 이력만 덧붙는다. */
export type RevisedPlan = ProductionPlan & { revisedFrom: number; remake: { components: readonly string[]; reason: RevisionKind }; excludedIds?: string[] };

export type RevisionRejection =
  | { code: 'NO_MATCH'; message: string }
  | { code: 'NO_CONTENT'; message: string }
  | { code: 'EXCLUDED_CONTENT'; message: string }
  | { code: 'NOT_EXECUTED'; scope: string; message: string };

export type RevisionOutcome = { ok: true; plan: RevisedPlan; removedIds: string[]; changedIds: string[]; suggestedKeywords: string[] } | ({ ok: false } & RevisionRejection);

const MAX_TEXT = 500;
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

const finish = (plan: ProductionPlan, items: ProductionPlan['items'], reason: RevisionKind, removedIds: string[], changedIds: string[], suggestedKeywords: string[] = []): RevisionOutcome => {
  if (!items.length) return { ok: false, code: 'NO_CONTENT', message: '남는 내용이 없어 영상을 다시 만들 수 없습니다. 일부만 빼 주세요.' };
  const prior = plan as Partial<RevisedPlan>;
  return {
    ok: true, removedIds, changedIds, suggestedKeywords,
    plan: {
      ...plan, items, lines: items.map((i) => i.text), revisedFrom: plan.briefingVersion,
      remake: { components: REMAKE_COMPONENTS, reason },
      ...(removedIds.length || prior.excludedIds?.length ? { excludedIds: [...new Set([...(prior.excludedIds ?? []), ...removedIds])] } : {}),
    },
  };
};

const dropMatching = (plan: ProductionPlan, match: (i: ProductionPlan['items'][number]) => boolean, reason: RevisionKind, suggested: string[] = []): RevisionOutcome => {
  const removed = plan.items.filter(match).map((i) => i.id);
  if (!removed.length) return { ok: false, code: 'NO_MATCH', message: '제외할 내용을 영상에서 찾지 못했습니다. 아무것도 바뀌지 않았습니다.' };
  return finish(plan, plan.items.filter((i) => !removed.includes(i.id)), reason, removed, [], suggested);
};

/**
 * 결과 수정 요청을 제작 계획에 반영한다. 순수 함수이며 DB 를 쓰지 않는다.
 * 삭제·불명확한 음성 명령은 실행하지 않고 NOT_EXECUTED 로 돌려준다. 반복 제외("앞으로")는 이번 영상에만 적용하고 기준 저장은 제안으로만 남긴다.
 */
export function applyRevision(plan: ProductionPlan, req: Exclude<RevisionRequest, { kind: 'RETRY' }>): RevisionOutcome {
  if (req.kind === 'EXCLUDE') {
    const kw = req.keyword?.trim();
    if (req.itemId) return dropMatching(plan, (i) => i.id === req.itemId, 'EXCLUDE');
    if (kw && kw.length >= 2) return dropMatching(plan, (i) => norm(i.text).includes(norm(kw)), 'EXCLUDE');
    return { ok: false, code: 'NO_MATCH', message: '제외할 항목이나 단어를 알려 주세요.' };
  }
  if (req.kind === 'EDIT_TEXT') {
    const text = req.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_TEXT) return { ok: false, code: 'NO_MATCH', message: `글은 1~${MAX_TEXT}자여야 합니다.` };
    if (!plan.items.some((i) => i.id === req.itemId)) return { ok: false, code: 'NO_MATCH', message: '수정할 항목을 찾지 못했습니다.' };
    if (classifyExclusion(text)) return { ok: false, code: 'EXCLUDED_CONTENT', message: '영상에 넣을 수 없는 내용이 들어 있어 반영하지 않았습니다.' };
    return finish(plan, plan.items.map((i) => (i.id === req.itemId ? { ...i, text } : i)), 'EDIT_TEXT', [], [req.itemId]);
  }
  const scope = classifyCommand(req.text);
  if (scope === 'DELETE_ORIGINAL') return { ok: false, code: 'NOT_EXECUTED', scope, message: '원본 삭제는 여기서 실행하지 않습니다. 영상에서만 빼려면 "영상에서 빼줘"라고 말해 주세요.' };
  if (scope === 'UNCLEAR') return { ok: false, code: 'NOT_EXECUTED', scope, message: '무엇을 바꿀지 알아듣지 못했습니다. 아무것도 바뀌지 않았습니다.' };
  const keywords = keywordsFromCommand(req.text);
  if (!keywords.length) return { ok: false, code: 'NOT_EXECUTED', scope, message: '빼려는 단어를 따옴표로 알려 주세요. 아무것도 바뀌지 않았습니다.' };
  return dropMatching(plan, (i) => keywords.some((k) => norm(i.text).includes(norm(k))), 'VOICE', scope === 'ALWAYS_EXCLUDE' ? keywords : []);
}
