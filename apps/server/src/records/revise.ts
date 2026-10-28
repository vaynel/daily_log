import type { ProductionPlan } from '../briefing/briefing.js';

/** 수정 하나가 다시 만들어야 하는 구성 요소. 장면·내레이션·자막은 같은 제작 계획에서 함께 만들어지므로 항상 함께 다시 만든다. */
export const REMAKE_COMPONENTS = ['SCENE', 'NARRATION', 'SUBTITLE'] as const;

/** 수정 전후 제작 계획을 비교해 영상에서 빠지거나 바뀐 항목을 알려준다(전후 비교). 원문 문장은 담지 않는다. */
export function remakeScope(before: ProductionPlan, after: ProductionPlan) {
  const prev = new Map(before.items.map((i) => [i.id, i.text]));
  const next = new Map(after.items.map((i) => [i.id, i.text]));
  return {
    components: [...REMAKE_COMPONENTS],
    removedItemIds: [...prev.keys()].filter((k) => !next.has(k)),
    changedItemIds: [...next.keys()].filter((k) => prev.has(k) && prev.get(k) !== next.get(k)),
    keptItemIds: [...next.keys()].filter((k) => prev.get(k) === next.get(k)),
    lineCountBefore: before.lines.length,
    lineCountAfter: after.lines.length,
  };
}
