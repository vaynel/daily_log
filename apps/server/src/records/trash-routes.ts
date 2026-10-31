import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import type { RetentionService } from '../retention/service.js';
import { RecordError, type RecordStore } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  NOT_FOUND: 404, INVALID_STATE: 409, TRASH_EXPIRED: 410, RECORD_PURGED: 410, CONFIRM_REQUIRED: 422, RECORD_IN_TRASH: 409, SERVER_CLEANED: 409,
};

/** 삭제 화면에 항상 같이 보여주는 범위 안내. 서버 사본과 Drive 백업·완성 영상은 서로 다른 정책이다. */
export const SCOPE_NOTICE = '서버에 있는 사본만 지워집니다. Google Drive 백업과 완성 영상은 지워지지 않습니다.';

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof RecordError) return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message });
  throw e;
}

/**
 * 휴지통·복구·영구 삭제(TASK-29). 인증은 전역 훅이 먼저 처리하고 소유자는 세션 sub 이다.
 * 어떤 명령도 Google Drive 에 요청을 보내지 않으며 Drive 백업·완성 영상을 지우지 않는다.
 */
export function registerTrashRoutes(app: FastifyInstance, opts: { store: RecordStore; retention?: RetentionService; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;
  const noStore = (r: FastifyReply) => r.header('cache-control', 'private, no-store');
  const confirmed = (req: { body?: unknown }) => (req.body as { confirm?: unknown } | null | undefined)?.confirm === true;

  app.get('/api/trash', async (req, reply) => {
    const entries = await opts.store.listTrash(owner(req), now());
    return noStore(reply).send({ entries, notice: SCOPE_NOTICE });
  });

  app.post('/api/records/:id/trash', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    try { return noStore(reply).send({ ...(await opts.store.trashRecord(owner(req), id, now())), notice: SCOPE_NOTICE }); } catch (e) { return fail(reply, e); }
  });

  app.post('/api/records/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    try { await opts.store.restoreRecord(owner(req), id, now()); return noStore(reply).send({ ok: true }); } catch (e) { return fail(reply, e); }
  });

  app.post('/api/records/:id/purge', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!confirmed(req)) return reply.code(422).send({ error: 'CONFIRM_REQUIRED', message: '영구 삭제는 확인이 필요합니다' });
    if (!opts.retention) return reply.code(501).send({ error: 'NOT_AVAILABLE' });
    try { await opts.retention.purgeNow(owner(req), { scope: 'RECORD', interviewId: id }, now()); return noStore(reply).send({ ok: true, notice: SCOPE_NOTICE }); } catch (e) { return fail(reply, e); }
  });

  for (const [seg, scope] of [['items', 'ITEM'], ['attachments', 'ATTACHMENT']] as const) {
    const ids = (req: { params: unknown }) => req.params as { id: string; childId: string };
    const bad = (p: { id: string; childId: string }) => !UUID.test(p.id) || !UUID.test(p.childId);
    app.post(`/api/records/:id/${seg}/:childId/trash`, async (req, reply) => {
      const p = ids(req);
      if (bad(p)) return reply.code(404).send({ error: 'NOT_FOUND' });
      try {
        const r = scope === 'ITEM' ? await opts.store.trashItem(owner(req), p.id, p.childId, now()) : await opts.store.trashAttachment(owner(req), p.id, p.childId, now());
        return noStore(reply).send({ ...r, notice: SCOPE_NOTICE });
      } catch (e) { return fail(reply, e); }
    });
    app.post(`/api/records/:id/${seg}/:childId/restore`, async (req, reply) => {
      const p = ids(req);
      if (bad(p)) return reply.code(404).send({ error: 'NOT_FOUND' });
      try {
        if (scope === 'ITEM') await opts.store.restoreItem(owner(req), p.id, p.childId, now());
        else await opts.store.restoreAttachment(owner(req), p.id, p.childId, now());
        return noStore(reply).send({ ok: true });
      } catch (e) { return fail(reply, e); }
    });
    app.post(`/api/records/:id/${seg}/:childId/purge`, async (req, reply) => {
      const p = ids(req);
      if (bad(p)) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (!confirmed(req)) return reply.code(422).send({ error: 'CONFIRM_REQUIRED', message: '영구 삭제는 확인이 필요합니다' });
      if (!opts.retention) return reply.code(501).send({ error: 'NOT_AVAILABLE' });
      try { await opts.retention.purgeNow(owner(req), { scope, interviewId: p.id, id: p.childId }, now()); return noStore(reply).send({ ok: true, notice: SCOPE_NOTICE }); } catch (e) { return fail(reply, e); }
    });
  }
}
