import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import type { RecordStore, Snapshot } from './store.js';
import { latestBriefing } from '../briefing/routes.js';
import { displayStatus, nextActions, resultFileName, resultVersionState, statusWithSupersede, summaryText } from './view.js';

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
      let status = statusWithSupersede(displayStatus(r.status, r.pipeline), r.resultSuperseded);
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
    const marks = await opts.store.listResultVersions(owner(req), id);
    const superseded = marks.find((m) => m.version === result?.version)?.superseded ?? false;
    const fileName = result && !superseded ? resultFileName(result.content) : null;
    const fileAvailable = fileName ? await exists(videoPath(fileName)) : false;
    const { interview, pipeline } = snap;
    return reply.header('cache-control', 'private, no-store').send({
      id, lifeDate: interview.lifeDate, startedAt: interview.startedAt, writingStatus: interview.status, revision: interview.revision,
      status: statusWithSupersede(displayStatus(interview.status, pipeline, superseded ? undefined : fileAvailable), superseded),
      pipeline,
      nextActions: superseded ? nextActions(interview.status, { ...pipeline, production: 'RUNNING' }, false) : nextActions(interview.status, pipeline, fileAvailable),
      conversation: snap.items.map((i) => ({ id: i.id, seq: i.seq, kind: i.kind, body: i.body, attachmentIds: attachments.filter((a) => a.itemId === i.id).map((a) => a.id) })),
      summary: summary ? { version: summary.version, ...summaryText(summary.content) } : null,
      attachments: attachments.map((a) => ({ id: a.id, itemId: a.itemId, kind: a.kind, name: a.name, mime: a.mime, size: a.size, uploadedAt: a.uploadedAt, capturedAt: a.capturedAt })),
      result: result ? { version: result.version, fileAvailable, superseded } : null,
      // 확정된 기록에서만 수정 대상 항목(영상에 들어간 것)을 준다. 제외·불확실 항목과 원문 대화는 포함하지 않는다.
      revisableItems: interview.status === 'CONFIRMED' ? (latestBriefing(snap)?.items ?? []).filter((i) => i.inVideo && i.excludedReason === null).map((i) => ({ id: i.id, text: i.text })) : [],
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
    // 수정으로 대체된 결과는 새 결과가 등록되기 전에는 정상본으로 내려주지 않는다(TASK-28).
    if ((await opts.store.listResultVersions(owner(req), id)).find((m) => m.version === result!.version)?.superseded) return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status: 'PRODUCING', message: '수정한 결과를 다시 만드는 중입니다' });
    // 화면의 DOWNLOAD 규칙과 같은 판단: 제작 완료 + 검수 통과일 때만 내려준다.
    const status = displayStatus(snap.interview.status, snap.pipeline, true);
    if (status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status, message: '완료되어 검수를 통과한 결과만 내려받을 수 있습니다' });
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type('video/mp4').send(createReadStream(videoPath(name)));
  });

  /** 결과 버전 조회(최신순). 정상본·이전 버전·미통과를 서로 다른 state 로 돌려준다. 파일 경로·이름은 노출하지 않는다. */
  app.get('/api/records/:id/results', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const versions = (await opts.store.listResultVersions(owner(req), id)).reverse();
    const out = await Promise.all(versions.map(async (v, idx) => {
      const name = resultFileName(v.content);
      const fileAvailable = name ? await exists(videoPath(name)) : false;
      const status = displayStatus(snap.interview.status, snap.pipeline, fileAvailable);
      const st = resultVersionState({ isLatest: idx === 0, superseded: v.superseded, wasPassed: v.wasPassed, status });
      const downloadable = st.downloadable && fileAvailable;
      return { version: v.version, state: st.state, downloadable, playable: downloadable, fileAvailable, createdAt: v.createdAt };
    }));
    return reply.header('cache-control', 'private, no-store').send({ results: out });
  });

  /**
   * 버전별 재생·내려받기. 재생은 Range 를 지원한다(?download=1 이면 첨부로 내려준다).
   * 허용 여부는 results 목록과 같은 resultVersionState 판정이다.
   */
  app.get('/api/records/:id/results/:version/file', async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string };
    const q = req.query as { download?: string };
    if (!UUID.test(id) || !/^[1-9]\d{0,8}$/.test(version)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const versions = await opts.store.listResultVersions(owner(req), id);
    const idx = versions.findIndex((v) => v.version === Number(version));
    if (idx < 0) return reply.code(404).send({ error: 'NOT_FOUND' });
    const v = versions[idx]!;
    const name = resultFileName(v.content);
    if (!name || !(await exists(videoPath(name)))) return reply.code(404).send({ error: 'FILE_MISSING', message: '결과 파일이 없어 재생·내려받기를 할 수 없습니다' });
    const status = displayStatus(snap.interview.status, snap.pipeline, true);
    const st = resultVersionState({ isLatest: idx === versions.length - 1, superseded: v.superseded, wasPassed: v.wasPassed, status });
    if (!st.downloadable) return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status: st.state === 'NOT_PASSED' ? status : st.state, message: '완료되어 검수를 통과한 결과만 재생·내려받을 수 있습니다' });
    const full = videoPath(name);
    const size = (await stat(full)).size;
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('accept-ranges', 'bytes').header('x-result-state', st.state)
      .header('content-disposition', `${q.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`).type('video/mp4');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start); end = Math.min(end, size - 1);
      if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(createReadStream(full, { start, end }));
    }
    return reply.header('content-length', size).send(createReadStream(full));
  });
}
