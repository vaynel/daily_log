import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { RecordError, type RecordStore } from '../records/store.js';
import { BACKUP_KEPT } from './view.js';
import type { RetentionService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = { NOT_FOUND: 404, IN_TRASH: 409, TRASH_EXPIRED: 410, RECORD_PURGED: 410, SERVER_CLEANED: 409, CONFIRMED_LOCKED: 409, INVALID_STATE: 409 };

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof RecordError) return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message });
  throw e;
}

/**
 * 휴지통·복구·영구 삭제 라우트. 모든 삭제는 서버 사본에만 적용되며 응답 문구도 Drive 백업·완성 영상이 유지됨을 함께 알린다.
 * 인증은 전역 훅이 먼저 처리하고 소유자는 세션 sub 이다.
 */
export function registerTrashRoutes(app: FastifyInstance, opts: { store: RecordStore; retention: RetentionService; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;
  const ids = (req: { params: unknown }) => req.params as { id: string; itemId?: string; attId?: string };
  const bad = (reply: FastifyReply) => reply.code(404).send({ error: 'NOT_FOUND' });
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'private, no-store');

  app.get('/api/trash', async (req, reply) => noStore(reply).send({ ...(await opts.store.listTrash(owner(req), now())), backupNote: BACKUP_KEPT }));

  // 기록(하루) 삭제 = 30일 휴지통. 기록은 생활일당 하나이므로 하루 삭제와 같은 명령이다.
  app.post('/api/records/:id/trash', async (req, reply) => {
    const { id } = ids(req);
    if (!UUID.test(id)) return bad(reply);
    try {
      const r = await opts.store.trashRecord(owner(req), id, now());
      return noStore(reply).send({ id, deletedAt: r.deletedAt, purgeAt: r.purgeAt, duplicate: r.duplicate, message: `휴지통으로 옮겼습니다. 30일 안에 복구할 수 있습니다. ${BACKUP_KEPT}` });
    } catch (e) { return sendError(reply, e); }
  });

  app.post('/api/records/:id/restore', async (req, reply) => {
    const { id } = ids(req);
    if (!UUID.test(id)) return bad(reply);
    try {
      const r = await opts.store.restoreRecord(owner(req), id, now());
      return noStore(reply).send({ id, restored: r.restored, duplicate: r.duplicate });
    } catch (e) { return sendError(reply, e); }
  });

  // 즉시 삭제: 되돌릴 수 없으므로 confirm:true 가 없으면 아무것도 지우지 않는다.
  app.post('/api/records/:id/purge', async (req, reply) => {
    const { id } = ids(req);
    if (!UUID.test(id)) return bad(reply);
    if ((req.body as { confirm?: unknown } | null)?.confirm !== true) return reply.code(422).send({ error: 'CONFIRM_REQUIRED', message: '서버 사본을 지금 영구 삭제하려면 확인이 필요합니다. 복구할 수 없습니다.' });
    try {
      const r = await opts.retention.purgeNow(owner(req), id, now());
      return noStore(reply).send({ id, serverCopy: 'PURGED', already: r.already, pendingFiles: (await opts.retention.pendingFiles()).length, message: `서버 사본을 영구 삭제했습니다. ${BACKUP_KEPT}` });
    } catch (e) { return sendError(reply, e); }
  });

  for (const [seg, kind] of [['items/:itemId', 'item'], ['attachments/:attId', 'attachment']] as const) {
    app.post(`/api/records/:id/${seg}/trash`, async (req, reply) => {
      const { id, itemId, attId } = ids(req);
      const sub = (kind === 'item' ? itemId : attId)!;
      if (!UUID.test(id) || !UUID.test(sub)) return bad(reply);
      try {
        const r = kind === 'item' ? await opts.store.trashItem(owner(req), id, sub, now()) : await opts.store.trashAttachment(owner(req), id, sub, now());
        return noStore(reply).send({ id: sub, purgeAt: r.purgeAt, duplicate: r.duplicate, message: `휴지통으로 옮겼습니다. 30일 안에 복구할 수 있습니다. ${BACKUP_KEPT}` });
      } catch (e) { return sendError(reply, e); }
    });
    app.post(`/api/records/:id/${seg}/restore`, async (req, reply) => {
      const { id, itemId, attId } = ids(req);
      const sub = (kind === 'item' ? itemId : attId)!;
      if (!UUID.test(id) || !UUID.test(sub)) return bad(reply);
      try {
        const r = kind === 'item' ? await opts.store.restoreItem(owner(req), id, sub, now()) : await opts.store.restoreAttachment(owner(req), id, sub, now());
        return noStore(reply).send({ id: sub, restored: r.restored, duplicate: r.duplicate });
      } catch (e) { return sendError(reply, e); }
    });
  }
}
