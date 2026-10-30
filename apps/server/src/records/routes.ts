import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import type { RecordStore, Snapshot } from './store.js';
import { retentionNotice } from '../retention/view.js';
import { displayStatus, nextActions, resultFileName, summaryText } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
/** 커서는 마지막으로 받은 생활일(YYYY-MM-DD). 실제 달력 날짜만 허용한다. */
const isLifeDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

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
    const q = req.query as { limit?: string; cursor?: string };
    const limit = q.limit === undefined ? DEFAULT_PAGE : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return reply.code(400).send({ error: 'INVALID_LIMIT', message: `limit 은 1~${MAX_PAGE} 사이 정수입니다` });
    if (q.cursor !== undefined && !isLifeDate(q.cursor)) return reply.code(400).send({ error: 'INVALID_CURSOR', message: '잘못된 cursor 입니다' });
    const { rows, nextCursor } = await opts.store.listRecords(owner(req), { limit, before: q.cursor ?? null });
    const records = await Promise.all(rows.map(async (r) => {
      // 정상 완료로 보이는 기록만 결과 파일이 실제로 있는지 확인한다(이 페이지 분량만 stat).
      let status = displayStatus(r.status, r.pipeline);
      if (status === 'COMPLETED') {
        const name = r.hasResult ? resultFileName(r.resultContent) : null;
        if (!name || !(await exists(videoPath(name)))) status = displayStatus(r.status, r.pipeline, false);
      }
      return { id: r.id, lifeDate: r.lifeDate, status, pipeline: r.pipeline, hasResult: r.hasResult, attachmentCount: r.attachmentCount };
    }));
    return reply.header('cache-control', 'private, no-store').send({ records, nextCursor });
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
    const ret = await opts.store.retentionOf(owner(req), id, now());
    return reply.header('cache-control', 'private, no-store').send({
      id, lifeDate: interview.lifeDate, startedAt: interview.startedAt, writingStatus: interview.status, revision: interview.revision,
      status: displayStatus(interview.status, pipeline, fileAvailable),
      pipeline,
      nextActions: nextActions(interview.status, pipeline, fileAvailable),
      conversation: snap.items.map((i) => ({ id: i.id, seq: i.seq, kind: i.kind, body: i.body, attachmentIds: attachments.filter((a) => a.itemId === i.id).map((a) => a.id) })),
      summary: summary ? { version: summary.version, ...summaryText(summary.content) } : null,
      attachments: attachments.map((a) => ({ id: a.id, itemId: a.itemId, kind: a.kind, name: a.name, mime: a.mime, size: a.size, uploadedAt: a.uploadedAt, capturedAt: a.capturedAt })),
      result: result ? { version: result.version, fileAvailable } : null,
      retention: ret ? retentionNotice(ret, now()) : null,
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
    // 화면의 DOWNLOAD 규칙과 같은 판단: 제작 완료 + 검수 통과일 때만 내려준다.
    const status = displayStatus(snap.interview.status, snap.pipeline, true);
    if (status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status, message: '완료되어 검수를 통과한 결과만 내려받을 수 있습니다' });
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type('video/mp4').send(createReadStream(videoPath(name)));
  });
}
