import type { FastifyInstance, FastifyReply } from 'fastify';
import { RecordError, type RecordStore } from '../records/store.js';
import type { SessionClaims } from '../auth/session.js';
import { AttachmentError, LIMITS, type AttachmentKind } from './policy.js';
import type { AttachmentService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: AttachmentKind[] = ['PHOTO', 'MARKDOWN', 'NOTE'];

const STATUS: Record<string, number> = {
  UNSUPPORTED_TYPE: 415, TOO_LARGE: 413, UNREADABLE_FILE: 422, EMPTY_FILE: 422, TOO_MANY: 409,
  NOT_FOUND: 404, CONFIRMED_LOCKED: 409, IDEMPOTENCY_CONFLICT: 409, TOO_MANY_ATTACHMENTS: 409, INVALID_STATE: 409,
  INVALID_LIFE_DATE: 400, EMPTY_PAST_DATE: 400,
  IN_TRASH: 409, TRASH_EXPIRED: 410, RECORD_PURGED: 410, SERVER_CLEANED: 409,
};

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof AttachmentError || e instanceof RecordError) return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message });
  throw e;
}

/** 인증은 전역 onRequest 훅이 먼저 처리한다. 소유자는 세션의 sub 이다. */
export function registerRecordRoutes(app: FastifyInstance, opts: { store: RecordStore; attachments: AttachmentService; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;

  app.register(async (scope) => {
    scope.addContentTypeParser(['application/octet-stream', 'text/markdown', 'text/plain', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'], { parseAs: 'buffer', bodyLimit: LIMITS.photoBytes + 1024 }, (_req, body, done) => done(null, body));

    scope.post('/api/records', async (req, reply) => {
      const body = (req.body ?? {}) as { lifeDate?: string };
      try {
        const { interview, resumed } = await opts.store.startInterview(owner(req), now(), typeof body.lifeDate === 'string' ? body.lifeDate : undefined);
        return reply.header('cache-control', 'private, no-store').send({ id: interview.id, lifeDate: interview.lifeDate, status: interview.status, resumed });
      } catch (e) {
        return sendError(reply, e);
      }
    });

    scope.get('/api/records/:id/attachments', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
      try {
        return reply.header('cache-control', 'private, no-store').send({ attachments: await opts.store.listAttachments(owner(req), id) });
      } catch (e) {
        return sendError(reply, e);
      }
    });

    scope.post('/api/records/:id/attachments', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
      const h = req.headers;
      const key = String(h['x-idempotency-key'] ?? '');
      const kind = String(h['x-attachment-kind'] ?? '').toUpperCase() as AttachmentKind;
      if (!/^[\w.:-]{1,100}$/.test(key) || !KINDS.includes(kind)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'x-idempotency-key, x-attachment-kind 필요' });
      let name = 'note.md';
      try {
        if (h['x-file-name']) name = decodeURIComponent(String(h['x-file-name']));
      } catch {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: '파일 이름 인코딩 오류' });
      }
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes)) return reply.code(415).send({ error: 'UNSUPPORTED_TYPE', message: '파일 본문 필요' });
      const itemId = h['x-item-id'] ? String(h['x-item-id']) : undefined;
      if (itemId && !UUID.test(itemId)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'x-item-id 형식 오류' });
      try {
        const r = await opts.attachments.upload({ ownerId: owner(req), interviewId: id, key, kind, name, bytes, itemId, now: now() });
        return reply.code(r.duplicate ? 200 : 201).header('cache-control', 'private, no-store').send({
          id: r.id, duplicate: r.duplicate, kind: r.kind, size: r.size, storageKey: r.storageKey,
          capturedAt: r.capturedAt, capturedSource: r.capturedSource,
        });
      } catch (e) {
        return sendError(reply, e);
      }
    });
  });
}
