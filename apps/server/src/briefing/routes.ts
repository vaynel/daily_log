import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { DEFAULT_LIMITS, type InterviewLimits } from '../interview/limits.js';
import type { LiveUsageStore } from '../interview/usage.js';
import { RecordError, type Snapshot, type VersionKind } from '../records/store.js';
import {
  applyCorrection, decideEntry, generateBriefing, planOf, videoJobKey, viewOf, VIDEO_JOB_KIND, VIDEO_JOB_STAGES,
  type BriefingItem, type Correction, type ProInfer,
} from './briefing.js';

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
  limits?: InterviewLimits;
  now?: () => Date;
}

interface StoredBriefing { kind: 'BRIEFING'; items: BriefingItem[]; diary: string }

const latestBriefing = (snap: Snapshot): { version: number; items: BriefingItem[] } | null => {
  const v = snap.versions.filter((x) => x.kind === 'SUMMARY' && (x.content as StoredBriefing | null)?.kind === 'BRIEFING').sort((a, b) => b.version - a.version)[0];
  return v ? { version: v.version, items: (v.content as StoredBriefing).items } : null;
};

const content = (items: BriefingItem[]): StoredBriefing => ({ kind: 'BRIEFING', items, diary: viewOf(items).summary.map((s) => s.text).join(' ') });

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
    const key = `${ownerId}:${id}`;
    const running = inflight.get(key);
    if (running) { await running.catch(() => {}); return reply.redirect(`/api/briefing/${id}`, 303); }
    const work = (async () => {
      const gen = await generateBriefing({
        conversation: snap.items.map((i) => ({ role: i.kind === 'ANSWER' ? 'user' as const : 'model' as const, text: i.body })),
        attachments: snap.attachments, infer: o.infer!,
      });
      if (!gen.ok) return { gen } as const;
      const saved = await o.records.appendVersion(ownerId, id, 'SUMMARY', content(gen.items), now());
      return { gen, version: saved.version } as const;
    })();
    inflight.set(key, work);
    try {
      const r = await work;
      if (!r.gen.ok) {
        // 대기·형식 오류: 제작 작업은 만들지 않고 저장된 대화는 그대로 둔다. 유료 모델로 자동 전환하지 않는다.
        return reply.code(r.gen.code === 'PRO_WAITING' ? 503 : 502).send({ error: r.gen.code === 'PRO_WAITING' ? 'PRO_WAITING' : 'BAD_OUTPUT', state: r.gen.state ?? null, message: 'Pro 정리를 지금 끝내지 못했습니다. 잠시 뒤 다시 시도하세요. 대화 내용은 저장되어 있습니다.' });
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
    const res = applyCorrection(cur.items, { itemId: b.itemId, action: b.action, text: b.text as string | undefined } satisfies Correction);
    if (!res.ok) return reply.code(res.code === 'NOT_FOUND' ? 404 : 422).send({ error: res.code });
    const saved = await o.records.appendVersion(ownerId, id, 'SUMMARY', content(res.items), now());
    // 응답은 바뀐 항목과 짧은 안내만 음성으로 쓰게 한다. 전체 브리핑 안내문(speech)은 화면 표시용 값으로만 함께 준다.
    return { ...present(snap, { version: saved.version, items: res.items }), changed: { id: res.changed.id, text: res.changed.text, inVideo: res.changed.inVideo, excludedReason: res.changed.excludedReason }, correctionSpeech: res.speech, repeatsFullBriefing: false };
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
}
