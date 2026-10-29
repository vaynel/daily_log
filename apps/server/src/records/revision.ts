import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { applyCorrection, planOf, VIDEO_JOB_KIND, VIDEO_JOB_STAGES, type BriefingItem } from '../briefing/briefing.js';
import { briefingContent, latestBriefing } from '../briefing/routes.js';
import { classifyCommand, keywordsFromCommand, type ExclusionRuleStore } from '../briefing/rules.js';
import { RecordError, type RecordStore } from './store.js';
import { displayStatus } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 내용이 바뀌면 장면·내레이션·자막은 항상 함께 다시 만든다. 일부만 다시 만들면 서로 어긋난다. */
export const REMAKE_SCOPE = ['SCENE', 'NARRATION', 'SUBTITLE'];

/** 음성 문장에서 대상 항목을 고른다: 따옴표로 지정한 단어가 정확히 한 항목에만 있을 때만. 애매하면 null. */
export function pickItemByVoice(items: BriefingItem[], text: string, itemId?: string): BriefingItem | null {
  if (itemId) return items.find((i) => i.id === itemId) ?? null;
  const kws = keywordsFromCommand(text).map((k) => k.toLowerCase());
  if (!kws.length) return null;
  const hits = items.filter((i) => i.inVideo && i.excludedReason === null && kws.some((k) => i.text.toLowerCase().includes(k)));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * 결과 수정 요청(TASK-28): 버튼·음성·상세 글 수정·수동 재시도를 같은 결과 버전 흐름에 연결한다.
 * 이전 결과는 지우지 않고 '이전 버전'으로 남기며, 새 제작이 끝나 검수를 통과하기 전에는 정상 완성본이 되지 않는다.
 * 원본 삭제 명령은 여기서 실행하지 않는다(영상 제외와 분리).
 */
export function registerRevisionRoutes(app: FastifyInstance, o: { store: RecordStore; rules?: ExclusionRuleStore; now?: () => Date }) {
  const now = o.now ?? (() => new Date());
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;

  app.post('/api/records/:id/revisions', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { type?: unknown; commandId?: unknown; itemId?: unknown; text?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const type = b.type;
    if (type !== 'EXCLUDE' && type !== 'EDIT_TEXT' && type !== 'VOICE' && type !== 'RETRY') return reply.code(400).send({ error: 'BAD_REQUEST' });
    if (typeof b.commandId !== 'string' || !b.commandId.trim() || b.commandId.length > 100) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'commandId 가 필요합니다' });
    if ((b.itemId !== undefined && typeof b.itemId !== 'string') || (b.text !== undefined && (typeof b.text !== 'string' || b.text.length > 300))) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const ownerId = owner(req);
    reply.header('cache-control', 'private, no-store');
    const snap = await o.store.loadById(ownerId, id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (snap.interview.status !== 'CONFIRMED') return reply.code(409).send({ error: 'INVALID_STATE', message: '아직 브리핑을 확인하지 않은 기록입니다' });
    const cur = latestBriefing(snap);
    if (!cur) return reply.code(404).send({ error: 'NO_BRIEFING' });

    let items = cur.items;
    let summary: unknown;
    let speech: string | undefined;
    if (type === 'RETRY') {
      const st = displayStatus(snap.interview.status, snap.pipeline);
      if (st !== 'FAILED' && st !== 'REVIEW_REJECTED') return reply.code(409).send({ error: 'INVALID_STATE', status: st, message: '실패했거나 검수를 통과하지 못한 결과만 다시 시도할 수 있습니다' });
    } else {
      let action: 'EXCLUDE' | 'REPLACE' = type === 'EDIT_TEXT' ? 'REPLACE' : 'EXCLUDE';
      let target: BriefingItem | null;
      if (type === 'VOICE') {
        if (typeof b.text !== 'string') return reply.code(400).send({ error: 'BAD_REQUEST' });
        const scope = classifyCommand(b.text);
        if (scope === 'DELETE_ORIGINAL') return { scope, executed: false, originalDeleted: false, message: '원본 삭제는 영상 제외와 별개입니다. 기록 삭제 화면에서 따로 확인해 주세요. 지금은 아무것도 바꾸지 않았습니다.' };
        if (scope === 'UNCLEAR') return { scope, executed: false, message: '무엇을 영상에서 뺄지 다시 말씀해 주세요. 예: "회의" 부분은 빼 줘.' };
        target = pickItemByVoice(items, b.text, b.itemId as string | undefined);
        if (!target) return { scope, executed: false, needsTarget: true, message: '어느 부분인지 정확히 알 수 없어요. 화면에서 해당 항목을 눌러 주세요. 지금은 아무것도 바꾸지 않았습니다.' };
        action = 'EXCLUDE';
      } else {
        if (typeof b.itemId !== 'string') return reply.code(400).send({ error: 'BAD_REQUEST' });
        target = items.find((i) => i.id === b.itemId) ?? null;
        if (!target) return reply.code(404).send({ error: 'NOT_FOUND' });
        if (action === 'REPLACE' && typeof b.text !== 'string') return reply.code(400).send({ error: 'BAD_REQUEST' });
      }
      const res = applyCorrection(items, { itemId: target.id, action, text: b.text as string | undefined }, o.rules ? await o.rules.list(ownerId) : []);
      if (!res.ok) return reply.code(res.code === 'NOT_FOUND' ? 404 : 422).send({ error: res.code });
      items = res.items;
      summary = briefingContent(items);
      speech = res.speech;
    }

    const plan = { ...planOf(items, cur.version), remake: { reason: type, scope: REMAKE_SCOPE } };
    if (!plan.lines.length) return reply.code(422).send({ error: 'NOTHING_TO_PRODUCE', message: '영상에 담을 내용이 없어 다시 만들 수 없습니다. 항목을 되돌리거나 다른 항목을 남기세요.' });
    try {
      const r = await o.store.reviseResult(ownerId, id, { commandId: b.commandId, kind: type, summary, plan, remakeScope: REMAKE_SCOPE, job: { kind: VIDEO_JOB_KIND, stages: VIDEO_JOB_STAGES } }, now());
      return { executed: true, duplicate: r.duplicate, jobId: r.jobId, revision: r.revision, planVersion: r.planVersion, remakeScope: REMAKE_SCOPE, previousVersionKept: r.supersededVersion, originalDeleted: false, ...(speech ? { correctionSpeech: speech } : {}), lines: plan.lines };
    } catch (e) {
      if (e instanceof RecordError && (e.code === 'INVALID_STATE' || e.code === 'NOT_FOUND')) return reply.code(e.code === 'NOT_FOUND' ? 404 : 409).send({ error: e.code, message: e.message });
      throw e;
    }
  });
}
