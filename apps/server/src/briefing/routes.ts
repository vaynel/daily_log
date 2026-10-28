import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { DEFAULT_LIMITS, type InterviewLimits } from '../interview/limits.js';
import type { LiveUsageStore } from '../interview/usage.js';
import { RecordError, type Snapshot, type VersionKind } from '../records/store.js';
import {
  applyCorrection, decideEntry, generateBriefing, planOf, videoJobKey, viewOf, VIDEO_JOB_KIND, VIDEO_JOB_STAGES,
  type BriefingItem, type Correction, type ProInfer,
} from './briefing.js';
import { waitReason } from './pro.js';
import {
  classifyCommand, keywordsFromCommand, normalizeRuleInput, RuleError, RULE_CATEGORY_LABEL, type ExclusionRuleStore,
} from './rules.js';
import { classifyExclusion } from './exclusion.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RecordStore 중 브리핑이 쓰는 부분(시험에서 메모리 구현으로 대체 가능). */
export interface BriefingRecords {
  loadById(ownerId: string, id: string, now: Date): Promise<Snapshot | null>;
  appendVersion(ownerId: string, interviewId: string, kind: VersionKind, content: unknown, now: Date): Promise<{ version: number; duplicate: boolean }>;
  confirmBriefing(
    ownerId: string, interviewId: string, o: { briefingVersion: number; plan: unknown; job: { kind: string; stages: string[]; idempotencyKey: string } }, now: Date,
  ): Promise<{ jobId: string; duplicate: boolean; revision: number }>;
}

export interface BriefingRouteOptions {
  records: BriefingRecords;
  usage: LiveUsageStore;
  /** 없으면 브리핑 생성은 fail closed(PRO_UNAVAILABLE). 유료 모델로 대신하지 않는다. */
  infer: ProInfer | null;
  /** 사용자가 확인한 반복 제외 기준. 없으면 상시 기준만 적용한다. */
  rules?: ExclusionRuleStore;
  limits?: InterviewLimits;
  now?: () => Date;
}

export interface StoredBriefing { kind: 'BRIEFING'; items: BriefingItem[]; diary: string }

export const latestBriefing = (snap: Snapshot): { version: number; items: BriefingItem[] } | null => {
  const v = snap.versions.filter((x) => x.kind === 'SUMMARY' && (x.content as StoredBriefing | null)?.kind === 'BRIEFING').sort((a, b) => b.version - a.version)[0];
  return v ? { version: v.version, items: (v.content as StoredBriefing).items } : null;
};

export const briefingContent = (items: BriefingItem[]): StoredBriefing => ({ kind: 'BRIEFING', items, diary: viewOf(items).summary.map((s) => s.text).join(' ') });

/**
 * 통합 브리핑 라우트. 인증은 전역 훅이 먼저 처리하고 소유자는 세션 sub 이다.
 * 제작 작업은 confirm 에서만, 확정과 같은 트랜잭션으로 만들어진다.
 */
export function registerBriefing(app: FastifyInstance, o: BriefingRouteOptions) {
  const now = o.now ?? (() => new Date());
  const limits = o.limits ?? DEFAULT_LIMITS;
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;
  const inflight = new Map<string, Promise<unknown>>();
  const noStore = (reply: { header: (k: string, v: string) => unknown }) => reply.header('cache-control', 'private, no-store');

  const present = (snap: Snapshot, b: { version: number; items: BriefingItem[] }, extra: object = {}) => ({
    id: snap.interview.id, lifeDate: snap.interview.lifeDate, version: b.version, confirmed: snap.interview.status === 'CONFIRMED', ...viewOf(b.items), ...extra,
  });

  app.get('/api/briefing/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await o.records.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const b = latestBriefing(snap);
    noStore(reply);
    return b ? present(snap, b) : reply.code(404).send({ error: 'NO_BRIEFING', message: '아직 브리핑이 없습니다' });
  });

  app.post('/api/briefing/:id/start', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { finish?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const ownerId = owner(req);
    const snap = await o.records.loadById(ownerId, id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    noStore(reply);
    const existing = latestBriefing(snap);
    if (existing) return present(snap, existing, { created: false }); // 다시 열어도 Pro 를 다시 부르지 않는다
    if (snap.interview.status === 'CONFIRMED') return reply.code(409).send({ error: 'CONFIRMED_LOCKED', message: '이미 확정된 기록입니다' });
    const usage = await o.usage.get(ownerId, id);
    const entry = decideEntry({
      answers: snap.items.filter((i) => i.kind === 'ANSWER').length, endReason: usage?.endReason ?? null, finishRequested: body.finish === true, usedMs: usage?.usedMs ?? 0, limits,
    });
    if (!entry.enter) return reply.code(409).send({ error: entry.reason, message: entry.reason === 'NO_CONTENT' ? '아직 정리할 대화가 없습니다' : '대화를 끝낸 뒤에 브리핑을 만들 수 있습니다' });
    if (!o.infer) return reply.code(503).send({ error: 'PRO_UNAVAILABLE', message: 'Pro 정리가 설정되지 않아 브리핑을 만들 수 없습니다. 대화 내용은 저장되어 있습니다.' });
    const rules = o.rules ? await o.rules.list(ownerId) : [];
    const key = `${ownerId}:${id}`;
    const running = inflight.get(key);
    if (running) { await running.catch(() => {}); return reply.redirect(`/api/briefing/${id}`, 303); }
    const work = (async () => {
      const gen = await generateBriefing({
        conversation: snap.items.map((i) => ({ role: i.kind === 'ANSWER' ? 'user' as const : 'model' as const, text: i.body })),
        attachments: snap.attachments, infer: o.infer!, rules,
      });
      if (!gen.ok) return { gen } as const;
      const saved = await o.records.appendVersion(ownerId, id, 'SUMMARY', briefingContent(gen.items), now());
      return { gen, version: saved.version } as const;
    })();
    inflight.set(key, work);
    try {
      const r = await work;
      if (!r.gen.ok) {
        // 대기·형식 오류: 제작 작업은 만들지 않고 저장된 대화는 그대로 둔다. 유료 모델로 자동 전환하지 않는다.
        return reply.code(r.gen.code === 'PRO_WAITING' ? 503 : 502).send({ error: r.gen.code === 'PRO_WAITING' ? 'PRO_WAITING' : 'BAD_OUTPUT', state: r.gen.state ?? null, message: r.gen.code === 'PRO_WAITING' ? `${waitReason(r.gen.state)} 대화 내용은 저장되어 있고 영상은 만들어지지 않았습니다.` : 'Pro 정리 결과를 읽지 못했습니다. 잠시 뒤 다시 시도하세요. 대화 내용은 저장되어 있습니다.' });
      }
      return { ...present(snap, { version: r.version!, items: r.gen.items }), created: true };
    } finally { inflight.delete(key); }
  });

  app.post('/api/briefing/:id/correct', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { version?: unknown; itemId?: unknown; action?: unknown; text?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!Number.isInteger(b.version) || typeof b.itemId !== 'string' || (b.action !== 'EXCLUDE' && b.action !== 'REPLACE' && b.action !== 'INCLUDE') || (b.text !== undefined && typeof b.text !== 'string')) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const ownerId = owner(req);
    const snap = await o.records.loadById(ownerId, id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    noStore(reply);
    const cur = latestBriefing(snap);
    if (!cur) return reply.code(404).send({ error: 'NO_BRIEFING' });
    if (snap.interview.status === 'CONFIRMED') return reply.code(409).send({ error: 'CONFIRMED_LOCKED', message: '이미 확인한 브리핑은 고칠 수 없습니다. 기록 상세에서 수정을 요청하세요.' });
    if (cur.version !== b.version) return reply.code(409).send({ error: 'STALE_BRIEFING', message: '화면의 브리핑이 최신이 아닙니다. 새로 불러오세요.' });
    const res = applyCorrection(cur.items, { itemId: b.itemId, action: b.action, text: b.text as string | undefined } satisfies Correction, o.rules ? await o.rules.list(ownerId) : []);
    if (!res.ok) return reply.code(res.code === 'NOT_FOUND' ? 404 : 422).send({ error: res.code });
    const saved = await o.records.appendVersion(ownerId, id, 'SUMMARY', briefingContent(res.items), now());
    // 응답은 바뀐 항목과 짧은 안내만 음성으로 쓰게 한다. 전체 브리핑 안내문(speech)은 화면 표시용 값으로만 함께 준다.
    return { ...present(snap, { version: saved.version, items: res.items }), changed: { id: res.changed.id, text: res.changed.text, inVideo: res.changed.inVideo, excludedReason: res.changed.excludedReason }, correctionSpeech: res.speech, repeatsFullBriefing: false };
  });

  /**
   * 제외 명령(음성·버튼 문장). 이번 영상 제외는 해당 항목만 뺀다. 원본 삭제는 여기서 실행하지 않는다.
   * 반복 제외("앞으로")는 이번 영상에서만 먼저 빼고, 기준 저장은 제안으로만 돌려준다. 확인은 POST /api/exclusion-rules 에서 한다.
   */
  app.post('/api/briefing/:id/exclude-command', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { version?: unknown; itemId?: unknown; text?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!Number.isInteger(b.version) || typeof b.itemId !== 'string' || typeof b.text !== 'string' || b.text.length > 300) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const ownerId = owner(req);
    const snap = await o.records.loadById(ownerId, id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    noStore(reply);
    const cur = latestBriefing(snap);
    if (!cur) return reply.code(404).send({ error: 'NO_BRIEFING' });
    const scope = classifyCommand(b.text);
    if (scope === 'DELETE_ORIGINAL') {
      return { scope, executed: false, originalDeleted: false, message: '원본 삭제는 영상 제외와 별개입니다. 기록 삭제 화면에서 따로 확인해 주세요. 지금은 아무것도 지우지 않았습니다.' };
    }
    if (scope === 'UNCLEAR') return { scope, executed: false, message: '이번 영상에서만 뺄지, 앞으로도 뺄지, 기록을 지울지 다시 말씀해 주세요.' };
    if (snap.interview.status === 'CONFIRMED') return reply.code(409).send({ error: 'CONFIRMED_LOCKED', message: '이미 확인한 브리핑은 고칠 수 없습니다.' });
    if (cur.version !== b.version) return reply.code(409).send({ error: 'STALE_BRIEFING', message: '화면의 브리핑이 최신이 아닙니다. 새로 불러오세요.' });
    const res = applyCorrection(cur.items, { itemId: b.itemId, action: 'EXCLUDE' });
    if (!res.ok) return reply.code(res.code === 'NOT_FOUND' ? 404 : 422).send({ error: res.code });
    const saved = await o.records.appendVersion(ownerId, id, 'SUMMARY', briefingContent(res.items), now());
    const base = { ...present(snap, { version: saved.version, items: res.items }), scope, executed: true, originalDeleted: false, ruleSaved: false };
    if (scope === 'THIS_VIDEO') return { ...base, correctionSpeech: res.speech };
    const target = cur.items.find((i) => i.id === b.itemId)!;
    if (classifyExclusion(target.text)) {
      return { ...base, correctionSpeech: res.speech, proposal: null, message: '이 종류는 이미 항상 영상에서 제외하고 있어요.' };
    }
    const keywords = keywordsFromCommand(b.text);
    return {
      ...base, correctionSpeech: `이번 영상에서는 뺐어요. 앞으로도 빼 둘까요? 확인하시기 전에는 기준을 저장하지 않아요.`,
      proposal: { needsConfirmation: true, keywords, needKeywords: keywords.length === 0, categories: RULE_CATEGORY_LABEL },
    };
  });

  app.post('/api/briefing/:id/confirm', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { version?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!Number.isInteger(b.version)) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const ownerId = owner(req);
    const snap = await o.records.loadById(ownerId, id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    noStore(reply);
    const cur = latestBriefing(snap);
    if (!cur) return reply.code(404).send({ error: 'NO_BRIEFING' });
    if (cur.version !== b.version) return reply.code(409).send({ error: 'STALE_BRIEFING', message: '화면의 브리핑이 최신이 아닙니다. 새로 불러와 다시 확인하세요.' });
    const plan = planOf(cur.items, cur.version);
    if (!plan.lines.length) return reply.code(422).send({ error: 'NOTHING_TO_PRODUCE', message: '영상에 담을 내용이 없어 제작할 수 없습니다. 항목을 되돌리거나 대화를 더 남기세요.' });
    try {
      const r = await o.records.confirmBriefing(ownerId, id, { briefingVersion: cur.version, plan, job: { kind: VIDEO_JOB_KIND, stages: VIDEO_JOB_STAGES, idempotencyKey: videoJobKey(id, cur.version) } }, now());
      return { confirmed: true, jobId: r.jobId, duplicate: r.duplicate, revision: r.revision, lines: plan.lines };
    } catch (e) {
      if (e instanceof RecordError && (e.code === 'STALE_BRIEFING' || e.code === 'CONFIRMED_LOCKED')) return reply.code(409).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  // ---- 반복 제외 기준 관리(D27-02·04) ----
  const ruleView = (r: { id: string; category: string; keywords: string[]; active: boolean; updatedAt: string; history: unknown[] }) => ({ id: r.id, category: r.category, keywords: r.keywords, active: r.active, updatedAt: r.updatedAt, history: r.history });
  const ruleErr = (e: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (e instanceof RuleError) return reply.code(e.code === 'NOT_FOUND' ? 404 : 422).send({ error: e.code, message: e.message });
    throw e;
  };

  app.get('/api/exclusion-rules', async (req, reply) => {
    noStore(reply);
    if (!o.rules) return { rules: [] };
    return { rules: (await o.rules.list(owner(req))).map(ruleView) };
  });

  app.post('/api/exclusion-rules', async (req, reply) => {
    const b = (req.body ?? {}) as { confirm?: unknown; category?: unknown; keywords?: unknown };
    noStore(reply);
    if (!o.rules) return reply.code(503).send({ error: 'RULES_UNAVAILABLE' });
    // 사용자가 반복 적용을 확인하지 않으면 영구 규칙을 만들지 않는다.
    if (b.confirm !== true) return reply.code(422).send({ error: 'CONFIRM_REQUIRED', message: '앞으로도 뺄지 확인한 뒤에만 기준을 저장합니다.' });
    const input = normalizeRuleInput(b);
    if (!input) return reply.code(400).send({ error: 'BAD_RULE', message: '범주를 고르고 2~20자 단어를 1~5개 입력하세요. 발언 전체는 저장하지 않습니다.' });
    try { return reply.code(201).send(ruleView(await o.rules.create(owner(req), input, now()))); } catch (e) { return ruleErr(e, reply); }
  });

  app.patch('/api/exclusion-rules/:ruleId', async (req, reply) => {
    const ruleId = (req.params as { ruleId: string }).ruleId;
    const b = (req.body ?? {}) as { category?: unknown; keywords?: unknown; active?: unknown };
    noStore(reply);
    if (!o.rules) return reply.code(503).send({ error: 'RULES_UNAVAILABLE' });
    if (!UUID.test(ruleId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const patch: { category?: never; keywords?: string[]; active?: boolean } = {};
    if (b.category !== undefined || b.keywords !== undefined) {
      const cur = (await o.rules.list(owner(req))).find((r) => r.id === ruleId);
      if (!cur) return reply.code(404).send({ error: 'NOT_FOUND' });
      const input = normalizeRuleInput({ category: b.category ?? cur.category, keywords: b.keywords ?? cur.keywords });
      if (!input) return reply.code(400).send({ error: 'BAD_RULE' });
      Object.assign(patch, input);
    }
    if (b.active !== undefined) { if (typeof b.active !== 'boolean') return reply.code(400).send({ error: 'BAD_REQUEST' }); patch.active = b.active; }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'BAD_REQUEST' });
    try { return ruleView(await o.rules.update(owner(req), ruleId, patch, now())); } catch (e) { return ruleErr(e, reply); }
  });
}
