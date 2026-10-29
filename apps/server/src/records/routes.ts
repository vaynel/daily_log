import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { VIDEO_JOB_KIND, VIDEO_JOB_STAGES } from '../briefing/briefing.js';
import { RecordError, RevisionRejected, type RecordStore, type Snapshot } from './store.js';
import type { RevisionRequest } from './revision.js';
import { displayStatus, nextActions, resultFileName, summaryText } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
/** 커서는 마지막으로 받은 생활일(YYYY-MM-DD). 실제 달력 날짜만 허용한다. */
const isLifeDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** 수정으로 대체된 RESULT 버전은 현재 결과가 아니다. */
const latest = (snap: Snapshot, kind: 'SUMMARY' | 'RESULT') =>
  snap.versions.filter((v) => v.kind === kind && !(kind === 'RESULT' && snap.supersededResults?.includes(v.version))).sort((a, b) => b.version - a.version)[0];

/** 'bytes=a-b' 한 구간만 지원한다. 잘못되면 'invalid'(416), 헤더가 없으면 null. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? 'invalid' : { start, end };
}

const COMMAND_ID = /^[\w.:-]{8,100}$/;

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
    return reply.header('cache-control', 'private, no-store').send({
      id, lifeDate: interview.lifeDate, startedAt: interview.startedAt, writingStatus: interview.status, revision: interview.revision,
      status: displayStatus(interview.status, pipeline, fileAvailable),
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
    // 화면의 DOWNLOAD 규칙과 같은 판단: 제작 완료 + 검수 통과일 때만 내려준다.
    const status = displayStatus(snap.interview.status, snap.pipeline, true);
    if (status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status, message: '완료되어 검수를 통과한 결과만 내려받을 수 있습니다' });
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type('video/mp4').send(createReadStream(videoPath(name)));
  });

  const sendFile = async (req: { headers: { range?: string } }, reply: import('fastify').FastifyReply, name: string, download: boolean) => {
    const full = videoPath(name);
    const size = (await stat(full)).size;
    const range = parseRange(req.headers.range, size);
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('accept-ranges', 'bytes').type('video/mp4')
      .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
    if (!range) return reply.header('content-length', size).send(createReadStream(full));
    return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1)
      .send(createReadStream(full, { start: range.start, end: range.end }));
  };

  /** 결과 버전 목록: 현재 결과와 수정으로 대체된 이전 버전을 구분해 보여준다. 이전 버전은 정상 완성본으로 표시하지 않는다. */
  app.get('/api/records/:id/results', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const rows = await opts.store.listResultVersions(owner(req), id);
    const current = rows.find((r) => r.supersededAt === null)?.version ?? null;
    const versions = await Promise.all(rows.map(async (r) => {
      const name = resultFileName(r.content);
      const fileAvailable = name ? await exists(videoPath(name)) : false;
      if (r.supersededAt) {
        const wasPassed = r.reviewAtSupersede === 'PASSED';
        return { version: r.version, role: 'PREVIOUS' as const, status: 'SUPERSEDED' as const, fileAvailable, playable: fileAvailable && wasPassed, downloadable: fileAvailable && wasPassed, supersededAt: r.supersededAt, reviewAtSupersede: r.reviewAtSupersede, confirmedAt: r.confirmedAt, createdAt: r.createdAt };
      }
      const status = displayStatus(snap.interview.status, snap.pipeline, fileAvailable);
      const ok = status === 'COMPLETED';
      return { version: r.version, role: 'CURRENT' as const, status, fileAvailable, playable: ok, downloadable: ok, supersededAt: null, reviewAtSupersede: null, confirmedAt: r.confirmedAt, createdAt: r.createdAt };
    }));
    // 수정 화면이 항목별로 빼기·고치기를 할 수 있도록 현재 제작 계획의 항목을 함께 준다(공개용 문장만).
    const planContent = snap.versions.filter((v) => v.kind === 'PRODUCTION_PLAN').sort((a, b) => b.version - a.version)[0]?.content as { items?: { id: string; text: string }[] } | undefined;
    const items = (planContent?.items ?? []).map((i) => ({ id: i.id, text: i.text }));
    return reply.header('cache-control', 'private, no-store').send({ id, current, versions, items });
  });

  // 재생(inline, Range)과 내려받기(?download=1)는 같은 판정을 쓴다: 현재 결과는 COMPLETED, 이전 버전은 대체 당시 검수 통과였던 것만.
  app.get('/api/records/:id/results/:version/file', async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string };
    if (!UUID.test(id) || !/^\d{1,6}$/.test(version)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const row = (await opts.store.listResultVersions(owner(req), id)).find((r) => r.version === Number(version));
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const name = resultFileName(row.content);
    if (!name || !(await exists(videoPath(name)))) return reply.code(404).send({ error: 'FILE_MISSING', message: '결과 파일이 없어 재생·내려받기를 할 수 없습니다' });
    const status = row.supersededAt ? (row.reviewAtSupersede === 'PASSED' ? 'COMPLETED' : 'SUPERSEDED') : displayStatus(snap.interview.status, snap.pipeline, true);
    if (status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status, message: '완료되어 검수를 통과한 결과만 재생·내려받을 수 있습니다' });
    return sendFile(req, reply, name, (req.query as { download?: string }).download === '1');
  });

  /** 사용자가 완성 결과를 확인한다. 기한이 지나도 자동으로 확인·공개되지 않는다. */
  app.post('/api/records/:id/result/confirm', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { version?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!Number.isInteger(b.version) || (b.version as number) < 1) return reply.code(400).send({ error: 'BAD_REQUEST' });
    try {
      const r = await opts.store.confirmResult(owner(req), id, b.version as number, now());
      return reply.header('cache-control', 'private, no-store').send({ version: b.version, confirmedAt: r.confirmedAt, duplicate: r.duplicate });
    } catch (e) {
      if (e instanceof RecordError) return reply.code(e.code === 'NOT_FOUND' ? 404 : 409).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  /**
   * 결과 수정·재시도. 본문: { commandId, kind: EXCLUDE|EDIT_TEXT|VOICE|RETRY, itemId?, keyword?, text? }.
   * 반영되면 새 제작 계획과 작업이 한 번에 만들어지고 이전 결과는 대체 표시된다.
   */
  app.post('/api/records/:id/revisions', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    if (typeof b.commandId !== 'string' || !COMMAND_ID.test(b.commandId)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'commandId 가 필요합니다' });
    let request: RevisionRequest | null = null;
    if (b.kind === 'EXCLUDE' && (str(b.itemId) || str(b.keyword))) request = { kind: 'EXCLUDE', ...(str(b.itemId) ? { itemId: str(b.itemId)! } : {}), ...(str(b.keyword) ? { keyword: str(b.keyword)! } : {}) };
    else if (b.kind === 'EDIT_TEXT' && str(b.itemId) && str(b.text) !== undefined) request = { kind: 'EDIT_TEXT', itemId: str(b.itemId)!, text: str(b.text)! };
    else if (b.kind === 'VOICE' && str(b.text) && str(b.text)!.length <= 300) request = { kind: 'VOICE', text: str(b.text)! };
    else if (b.kind === 'RETRY') request = { kind: 'RETRY' };
    if (!request) return reply.code(400).send({ error: 'BAD_REQUEST' });
    reply.header('cache-control', 'private, no-store');
    try {
      const r = await opts.store.reviseResult(owner(req), id, { commandId: b.commandId, request, job: { kind: VIDEO_JOB_KIND, stages: VIDEO_JOB_STAGES } }, now());
      return reply.code(r.duplicate ? 200 : 202).send({ ...r, remake: request.kind === 'RETRY' ? [] : ['SCENE', 'NARRATION', 'SUBTITLE'] });
    } catch (e) {
      if (e instanceof RevisionRejected) return reply.code(422).send({ error: e.rejection.code, message: e.rejection.message, ...(e.rejection.code === 'NOT_EXECUTED' ? { scope: e.rejection.scope } : {}) });
      if (e instanceof RecordError) return reply.code(e.code === 'NOT_FOUND' ? 404 : 409).send({ error: e.code, message: e.message });
      throw e;
    }
  });
}
