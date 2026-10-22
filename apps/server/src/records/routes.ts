import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import type { RecordStore, Snapshot } from './store.js';
import { displayStatus, nextActions, resultFileName, summaryText } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const latest = (snap: Snapshot, kind: 'SUMMARY' | 'RESULT') => snap.versions.filter((v) => v.kind === kind).sort((a, b) => b.version - a.version)[0];

/**
 * 조회 전용 라우트(TASK-16). 인증은 전역 훅이 먼저 처리하고 소유자는 세션 sub 이다.
 * 결과 파일은 디스크에 실제로 있을 때만 available=true / 다운로드 200 이다.
 */
export function registerRecordViewRoutes(app: FastifyInstance, opts: { store: RecordStore; fileStorageDir: string; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;
  const videoPath = (name: string) => path.join(opts.fileStorageDir, 'videos', name);
  const exists = (full: string) => stat(full).then((s) => s.isFile() && s.size > 0, () => false);

  app.get('/api/records', async (req, reply) => {
    const rows = await opts.store.listRecords(owner(req));
    return reply.header('cache-control', 'private, no-store').send({
      records: rows.map((r) => ({ id: r.id, lifeDate: r.lifeDate, status: displayStatus(r.status, r.pipeline), pipeline: r.pipeline, hasResult: r.hasResult, attachmentCount: r.attachmentCount })),
    });
  });

  app.get('/api/records/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const attachments = await opts.store.listAttachments(owner(req), id);
    const summary = latest(snap, 'SUMMARY');
    const result = latest(snap, 'RESULT');
    const fileName = result ? resultFileName(result.content) : null;
    const fileAvailable = fileName ? await exists(videoPath(fileName)) : false;
    const { interview, pipeline } = snap;
    return reply.header('cache-control', 'private, no-store').send({
      id, lifeDate: interview.lifeDate, startedAt: interview.startedAt, writingStatus: interview.status, revision: interview.revision,
      status: displayStatus(interview.status, pipeline),
      pipeline,
      nextActions: nextActions(interview.status, pipeline, fileAvailable),
      conversation: snap.items.map((i) => ({ id: i.id, seq: i.seq, kind: i.kind, body: i.body, attachmentIds: attachments.filter((a) => a.itemId === i.id).map((a) => a.id) })),
      summary: summary ? { version: summary.version, ...summaryText(summary.content) } : null,
      attachments: attachments.map((a) => ({ id: a.id, itemId: a.itemId, kind: a.kind, name: a.name, mime: a.mime, size: a.size, uploadedAt: a.uploadedAt, capturedAt: a.capturedAt })),
      result: result ? { version: result.version, fileAvailable } : null,
    });
  });

  app.get('/api/records/:id/attachments/:attId/file', async (req, reply) => {
    const { id, attId } = req.params as { id: string; attId: string };
    if (!UUID.test(id) || !UUID.test(attId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const a = (await opts.store.listAttachments(owner(req), id).catch(() => [])).find((x) => x.id === attId);
    if (!a || !/^[0-9a-f]{64}\.\w{1,8}$/.test(a.storageKey)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const full = path.join(opts.fileStorageDir, 'attachments', a.storageKey);
    if (!(await exists(full))) return reply.code(404).send({ error: 'FILE_MISSING', message: '원본 파일을 찾을 수 없습니다' });
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name ?? a.storageKey)}`)
      .type(a.mime ?? 'application/octet-stream').send(createReadStream(full));
  });

  app.get('/api/records/:id/result/file', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const result = latest(snap, 'RESULT');
    const name = result ? resultFileName(result.content) : null;
    if (!name || !(await exists(videoPath(name)))) return reply.code(404).send({ error: 'FILE_MISSING', message: '결과 파일이 없어 내려받을 수 없습니다' });
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type('video/mp4').send(createReadStream(videoPath(name)));
  });
}
