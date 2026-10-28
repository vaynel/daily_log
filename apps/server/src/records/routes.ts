import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { RecordError, type RecordStore, type Snapshot } from './store.js';
import { displayStatus, nextActions, resultFileName, summaryText, type DisplayStatus } from './view.js';
import { applyCorrection, planOf, videoJobKey, VIDEO_JOB_KIND, VIDEO_JOB_STAGES } from '../briefing/briefing.js';
import { briefingContent, latestBriefing } from '../briefing/routes.js';
import { classifyCommand } from '../briefing/rules.js';
import { remakeScope } from './revise.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
/** 커서는 마지막으로 받은 생활일(YYYY-MM-DD). 실제 달력 날짜만 허용한다. */
const isLifeDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const latest = (snap: Snapshot, kind: 'SUMMARY' | 'RESULT') => snap.versions.filter((v) => v.kind === kind).sort((a, b) => b.version - a.version)[0];

/**
 * 현재 결과 버전. 수정 요청으로 "이전 버전"이 된 버전은 새 결과가 나오기 전까지 현재 결과가 아니다.
 * 그래서 수정 중에는 이전 파일이 현재 완성본으로 보이거나 내려받아지지 않는다.
 */
const current = (snap: Snapshot) => {
  const old = new Set((snap.supersededResults ?? []).map((m) => m.version));
  return snap.versions.filter((v) => v.kind === 'RESULT' && !old.has(v.version)).sort((a, b) => b.version - a.version)[0];
};

/**
 * mp4 전송. 재생(inline)은 Range 요청을 지원해 휴대폰 브라우저에서 탐색이 되고, 다운로드는 attachment 로 내려준다.
 * 권한·상태 확인은 호출 전에 끝내야 한다.
 */
async function sendVideo(req: FastifyRequest, reply: FastifyReply, full: string, name: string, inline: boolean) {
  const size = (await stat(full)).size;
  reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('accept-ranges', 'bytes').type('video/mp4')
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (inline && m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(end, size - 1);
    if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(createReadStream(full, { start, end }));
  }
  return reply.header('content-length', size).send(createReadStream(full));
}

const RETRY_ERRORS: Record<string, number> = { NOT_FOUND: 404, NOT_RETRYABLE: 409, UNRESOLVED_EXTERNAL: 409, INVALID_COMMAND: 400 };

/**
 * 조회 전용 라우트(TASK-16). 인증은 전역 훅이 먼저 처리하고 소유자는 세션 sub 이다.
 * 결과 파일은 디스크에 실제로 있을 때만 available=true / 다운로드 200 이다.
 */
export interface ManualRetry {
  (jobId: string, req: { commandId: string; actor: string }): Promise<{ ok: true; duplicate: boolean } | { ok: false; code: string }>;
}

export function registerRecordViewRoutes(app: FastifyInstance, opts: { store: RecordStore; fileStorageDir: string; now?: () => Date; retry?: ManualRetry }) {
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
    const result = current(snap);
    const fileName = result ? resultFileName(result.content) : null;
    const fileAvailable = fileName ? await exists(videoPath(fileName)) : false;
    const { interview, pipeline } = snap;
    const confirmedAt = result ? snap.resultConfirmations?.find((c) => c.version === result.version)?.confirmedAt ?? null : null;
    return reply.header('cache-control', 'private, no-store').send({
      id, lifeDate: interview.lifeDate, startedAt: interview.startedAt, writingStatus: interview.status, revision: interview.revision,
      status: displayStatus(interview.status, pipeline, fileAvailable),
      pipeline,
      nextActions: nextActions(interview.status, pipeline, fileAvailable),
      conversation: snap.items.map((i) => ({ id: i.id, seq: i.seq, kind: i.kind, body: i.body, attachmentIds: attachments.filter((a) => a.itemId === i.id).map((a) => a.id) })),
      summary: summary ? { version: summary.version, ...summaryText(summary.content) } : null,
      attachments: attachments.map((a) => ({ id: a.id, itemId: a.itemId, kind: a.kind, name: a.name, mime: a.mime, size: a.size, uploadedAt: a.uploadedAt, capturedAt: a.capturedAt })),
      // 재생 가능 여부는 다운로드와 같은 판단(COMPLETED)을 쓴다. published 는 이 기능이 공개를 하지 않으므로 항상 false 다.
      result: result ? { version: result.version, fileAvailable, playable: fileAvailable && displayStatus(interview.status, pipeline, fileAvailable) === 'COMPLETED', confirmedAt, published: false } : null,
      previousResultCount: (snap.supersededResults ?? []).length,
      // 결과 수정 화면이 고를 수 있는 항목. 뺀 항목은 이유와 함께 보여 준다.
      editableItems: (latestBriefing(snap)?.items ?? []).map((i) => ({ id: i.id, text: i.text, inVideo: i.inVideo, excludedReason: i.excludedReason })),
    });
  });

  /** 결과 버전 조회: 현재 결과와 수정 전 "이전 버전". 이전 버전은 어떤 경우에도 현재 완성본 상태로 표시하지 않는다. */
  app.get('/api/records/:id/results', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const marks = new Map((snap.supersededResults ?? []).map((m) => [m.version, m]));
    const cur = current(snap);
    const versions = await Promise.all(snap.versions.filter((v) => v.kind === 'RESULT').sort((a, b) => b.version - a.version).map(async (v) => {
      const name = resultFileName(v.content);
      const fileAvailable = name ? await exists(videoPath(name)) : false;
      const mark = marks.get(v.version);
      if (mark) {
        return { version: v.version, role: 'PREVIOUS' as const, status: 'SUPERSEDED' as const, priorStatus: mark.priorStatus, supersededAt: mark.supersededAt, fileAvailable, downloadable: fileAvailable && mark.priorStatus === 'COMPLETED' };
      }
      const status = displayStatus(snap.interview.status, snap.pipeline, fileAvailable);
      return { version: v.version, role: 'CURRENT' as const, status, fileAvailable, downloadable: v.version === cur?.version && status === 'COMPLETED', confirmedAt: snap.resultConfirmations?.find((c) => c.version === v.version)?.confirmedAt ?? null };
    }));
    return reply.header('cache-control', 'private, no-store').send({ versions });
  });

  /** 특정 결과 버전 내려받기. 현재 버전은 COMPLETED 일 때만, 이전 버전은 수정 전에 검수를 통과(COMPLETED)했던 경우만 허용한다. */
  app.get('/api/records/:id/results/:version/file', async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string };
    const n = Number(version);
    if (!UUID.test(id) || !Number.isInteger(n) || n < 1) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const v = snap.versions.find((x) => x.kind === 'RESULT' && x.version === n);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND' });
    const name = resultFileName(v.content);
    if (!name || !(await exists(videoPath(name)))) return reply.code(404).send({ error: 'FILE_MISSING', message: '결과 파일이 없어 내려받을 수 없습니다' });
    const mark = snap.supersededResults?.find((m) => m.version === n);
    const status: DisplayStatus | 'SUPERSEDED' = mark ? (mark.priorStatus === 'COMPLETED' ? 'COMPLETED' : 'SUPERSEDED') : (current(snap)?.version === n ? displayStatus(snap.interview.status, snap.pipeline, true) : 'SUPERSEDED');
    if (status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status: mark ? 'SUPERSEDED' : status, message: '검수를 통과한 결과만 내려받을 수 있습니다' });
    return sendVideo(req, reply, videoPath(name), name, (req.query as { inline?: string }).inline === '1');
  });

  /** 사용자가 현재 결과를 확인했다고 남긴다. 완료(검수 통과)된 현재 버전만 확인할 수 있고, 시간이 지나도 자동으로 확인되지 않는다. */
  app.post('/api/records/:id/result/confirm', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { version?: unknown; commandId?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!Number.isInteger(b.version) || typeof b.commandId !== 'string' || !b.commandId.trim() || b.commandId.length > 100) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const snap = await opts.store.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const cur = current(snap);
    const name = cur ? resultFileName(cur.content) : null;
    const fileAvailable = name ? await exists(videoPath(name)) : false;
    const status = displayStatus(snap.interview.status, snap.pipeline, fileAvailable);
    if (!cur || cur.version !== b.version || status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_CONFIRMABLE', status, message: '완료되어 검수를 통과한 현재 결과만 확인할 수 있습니다' });
    const r = await opts.store.confirmResult(owner(req), id, cur.version, b.commandId, now());
    return reply.header('cache-control', 'private, no-store').send({ confirmed: true, version: cur.version, confirmedAt: r.confirmedAt, duplicate: r.duplicate, published: false });
  });

  /**
   * 결과 수정·재시도 명령.
   *  EXCLUDE: 지정한 내용을 영상에서 뺀다 / EDIT_TEXT: 문장을 고친다 / VOICE: 음성 문장을 분류해 이번 영상 제외로 처리 / RETRY: 처리 실패 작업의 수동 재시도.
   * 수정은 새 요약·제작 계획·작업을 만들어 장면·내레이션·자막을 같은 계획에서 함께 다시 만들게 하며, 원본 기록은 지우지 않는다.
   */
  app.post('/api/records/:id/revisions', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { commandId?: unknown; kind?: unknown; itemId?: unknown; text?: unknown; command?: unknown };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (typeof b.commandId !== 'string' || !b.commandId.trim() || b.commandId.length > 100 || !['EXCLUDE', 'EDIT_TEXT', 'VOICE', 'RETRY'].includes(b.kind as string)) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const ownerId = owner(req);
    const snap = await opts.store.loadById(ownerId, id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.header('cache-control', 'private, no-store');
    const cur = current(snap);
    const name = cur ? resultFileName(cur.content) : null;
    const fileAvailable = name ? await exists(videoPath(name)) : false;
    const status = displayStatus(snap.interview.status, snap.pipeline, fileAvailable);

    if (b.kind === 'RETRY') {
      if (status !== 'FAILED') return reply.code(409).send({ error: 'NOT_RETRYABLE', status, message: '처리 실패한 제작만 다시 시도할 수 있습니다' });
      if (!opts.retry) return reply.code(503).send({ error: 'RETRY_UNAVAILABLE' });
      const jobId = await opts.store.latestJobId(ownerId, id);
      if (!jobId) return reply.code(404).send({ error: 'NO_JOB', message: '다시 시도할 제작 작업이 없습니다' });
      const r = await opts.retry(jobId, { commandId: b.commandId, actor: ownerId });
      if (!r.ok) return reply.code(RETRY_ERRORS[r.code] ?? 409).send({ error: r.code });
      if (!r.duplicate) await opts.store.markRetryQueued(ownerId, id, now());
      return { executed: true, kind: 'RETRY', jobId, duplicate: r.duplicate, status: 'PRODUCING' };
    }

    if (typeof b.itemId !== 'string') return reply.code(400).send({ error: 'BAD_REQUEST' });
    const action: 'EXCLUDE' | 'REPLACE' = b.kind === 'EDIT_TEXT' ? 'REPLACE' : 'EXCLUDE';
    if (b.kind === 'EDIT_TEXT' && typeof b.text !== 'string') return reply.code(400).send({ error: 'BAD_REQUEST' });
    if (b.kind === 'VOICE') {
      if (typeof b.command !== 'string' || b.command.length > 300) return reply.code(400).send({ error: 'BAD_REQUEST' });
      const scope = classifyCommand(b.command);
      if (scope === 'DELETE_ORIGINAL') return { executed: false, scope, originalDeleted: false, message: '원본 삭제는 영상 제외와 별개입니다. 기록 삭제 화면에서 따로 확인해 주세요. 지금은 아무것도 지우지 않았습니다.' };
      if (scope === 'UNCLEAR') return { executed: false, scope, message: '이번 영상에서만 뺄지, 앞으로도 뺄지, 기록을 지울지 다시 말씀해 주세요.' };
    }
    // 이미 이 명령으로 만든 수정이면 같은 작업을 돌려준다(재전송).
    const done = await opts.store.findRevision(ownerId, id, b.commandId);
    if (done) return { executed: true, duplicate: true, kind: b.kind, jobId: done.jobId, revisionId: done.revisionId, status: 'PRODUCING', originalDeleted: false, summaryVersion: done.summaryVersion, planVersion: done.planVersion };
    const brief = latestBriefing(snap);
    if (!brief) return reply.code(409).send({ error: 'NO_BRIEFING', message: '수정할 정리 내용이 없어 이 기록은 화면에서 수정할 수 없습니다' });
    if (!['COMPLETED', 'REVIEW_REJECTED', 'RESULT_FILE_MISSING', 'FAILED'].includes(status)) return reply.code(409).send({ error: 'INVALID_STATE', status, message: '제작 또는 검수가 진행 중이라 지금은 수정할 수 없습니다' });
    const res = applyCorrection(brief.items, { itemId: b.itemId, action, text: b.text as string | undefined });
    if (!res.ok) return reply.code(res.code === 'NOT_FOUND' ? 404 : 422).send({ error: res.code });
    const newBriefVersion = brief.version + 1;
    const plan = planOf(res.items, newBriefVersion);
    if (!plan.lines.length) return reply.code(422).send({ error: 'NOTHING_TO_PRODUCE', message: '영상에 담을 내용이 없어 다시 만들 수 없습니다. 다른 항목은 그대로 두고 일부만 빼 보세요.' });
    try {
      const r = await opts.store.reviseResult(ownerId, id, {
        commandId: b.commandId, scope: action === 'EXCLUDE' ? 'EXCLUDE' : 'EDIT_TEXT', itemId: b.itemId, expectedSummaryVersion: brief.version,
        summary: briefingContent(res.items), plan, allowed: true, priorStatus: status,
        job: { kind: VIDEO_JOB_KIND, stages: VIDEO_JOB_STAGES, idempotencyKey: `${videoJobKey(id, newBriefVersion)}:revise` },
      }, now());
      return { executed: true, duplicate: r.duplicate, kind: b.kind, jobId: r.jobId, revisionId: r.revisionId, status: 'PRODUCING', originalDeleted: false,
        summaryVersion: r.summaryVersion, planVersion: r.planVersion, remake: remakeScope(planOf(brief.items, brief.version), plan), changed: { id: res.changed.id, text: res.changed.text, inVideo: res.changed.inVideo, excludedReason: res.changed.excludedReason } };
    } catch (e) {
      if (e instanceof RecordError && (e.code === 'INVALID_STATE' || e.code === 'STALE_BRIEFING')) return reply.code(409).send({ error: e.code, status, message: e.message });
      throw e;
    }
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
    const result = current(snap);
    const name = result ? resultFileName(result.content) : null;
    if (!name || !(await exists(videoPath(name)))) return reply.code(404).send({ error: 'FILE_MISSING', message: '결과 파일이 없어 내려받을 수 없습니다' });
    // 화면의 DOWNLOAD 규칙과 같은 판단: 제작 완료 + 검수 통과일 때만 내려준다.
    const status = displayStatus(snap.interview.status, snap.pipeline, true);
    if (status !== 'COMPLETED') return reply.code(409).send({ error: 'NOT_DOWNLOADABLE', status, message: '완료되어 검수를 통과한 결과만 내려받을 수 있습니다' });
    return sendVideo(req, reply, videoPath(name), name, false);
  });
}
