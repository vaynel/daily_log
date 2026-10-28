import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { selectVideo, planOf, type BriefingItem } from '../briefing/briefing.js';
import { briefingContent } from '../briefing/routes.js';
import { parseDrafts, scenePrompt, DEFAULT_NARRATION } from '../video/scenePlan.js';
import { createTempSchema } from './db.testutil.js';
import { RecordStore } from './store.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const cookie = (sub: string, email: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 }, SECRET, 'session')}`;
};

const item = (id: string, text: string): BriefingItem => ({ id, kind: 'FACT', source: 'USER', text, emphasis: false, inVideo: false, excludedReason: null });
const ITEMS = selectVideo([item('s1', '아침에 산책을 했다'), item('s2', '점심에 비밀 프로젝트 이야기를 했다'), item('s3', '저녁에 책을 읽었다')]);

describe.skipIf(!url)('TASK-28 결과 확인·수정·버전 (실제 PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let app: FastifyInstance;
  let dir: string;
  let clock = new Date('2026-10-25T10:00:00+09:00');
  const retries: string[] = [];
  const A = cookie('owner-a', 'a@example.test');
  const B = cookie('owner-b', 'b@example.test');
  const get = (u: string, c = A) => app.inject({ method: 'GET', url: u, headers: { cookie: c } });
  const post = (u: string, payload: object, c = A) => app.inject({ method: 'POST', url: u, headers: { cookie: c }, payload });

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-rev-'));
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test,b@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    app = buildApp({
      auth, sessionSecret: SECRET, fileStorageDir: dir, records: store, now: () => clock,
      retry: async (jobId, req) => { retries.push(`${jobId}:${req.commandId}`); return { ok: true, duplicate: retries.filter((r) => r.endsWith(`:${req.commandId}`)).length > 1 }; },
    });
  });
  afterAll(async () => { await app.close(); await pool.end(); await t.drop(); await rm(dir, { recursive: true, force: true }); });

  let n = 0;
  /** 확정된 기록 + 브리핑 + (선택) 결과 파일 v1 을 만든다. */
  const seed = async (owner: string, o: { pipeline: Parameters<RecordStore['setPipeline']>[2]; file?: string | null; withBriefing?: boolean }) => {
    const date = `2026-08-${String(++n).padStart(2, '0')}`;
    const id = (await store.startInterview(owner, new Date(`${date}T10:00:00+09:00`), date)).interview.id;
    if (o.withBriefing !== false) await store.appendVersion(owner, id, 'SUMMARY', briefingContent(ITEMS), clock);
    await store.confirm(owner, id, clock);
    await store.setPipeline(owner, id, o.pipeline, clock);
    if (o.file !== undefined) {
      await store.appendVersion(owner, id, 'RESULT', { file: o.file ?? 'none.mp4' }, clock);
      if (o.file) await writeFile(path.join(dir, 'videos', o.file), `bytes-of-${o.file}`);
    }
    return id;
  };
  const done = { production: 'DONE', review: 'PASSED' } as const;

  it('AC-1 로그인한 사용자는 완성 영상을 재생 가능으로 보고 내려받고, 다른 사용자·비로그인은 막힌다', async () => {
    const id = await seed('owner-a', { pipeline: done, file: 'ac1.mp4' });
    const d = (await get(`/api/records/${id}`)).json() as { status: string; result: { version: number; playable: boolean; published: boolean }; nextActions: string[] };
    expect(d.status).toBe('COMPLETED');
    expect(d.result).toMatchObject({ version: 1, playable: true, published: false });
    expect(d.nextActions).toEqual(['DOWNLOAD', 'EDIT_AND_REMAKE']);
    const f = await get(`/api/records/${id}/results/1/file`);
    expect(f.statusCode).toBe(200);
    expect(f.rawPayload.toString()).toBe('bytes-of-ac1.mp4');
    expect(f.headers['content-type']).toContain('video/mp4');
    // 재생(inline)은 Range 를 지원하고, 같은 검수 규칙을 따른다.
    const part = await app.inject({ method: 'GET', url: `/api/records/${id}/results/1/file?inline=1`, headers: { cookie: A, range: 'bytes=3-6' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.toString()).toBe('es-o');
    expect(part.headers['content-range']).toBe('bytes 3-6/16');
    expect(String(part.headers['content-disposition'])).toMatch(/^inline/);
    expect(String(f.headers['content-disposition'])).toMatch(/^attachment/);
    expect((await app.inject({ method: 'GET', url: `/api/records/${id}/results/1/file?inline=1`, headers: { cookie: A, range: 'bytes=99-120' } })).statusCode).toBe(416);
    expect((await get(`/api/records/${id}/results/1/file`, B)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/records/${id}/results` })).statusCode).toBe(401);
    expect((await get(`/api/records/${id}/results/2/file`)).statusCode).toBe(404);
  });

  it('AC-2 제외 요청은 같은 제작 계획에서 장면·내레이션·자막을 함께 다시 만들게 하고 원본은 지우지 않는다(전후 비교)', async () => {
    const id = await seed('owner-a', { pipeline: done, file: 'ac2.mp4' });
    const before = planOf(ITEMS, 1);
    expect(before.lines).toContain('점심에 비밀 프로젝트 이야기를 했다');
    const res = await post(`/api/records/${id}/revisions`, { commandId: 'cmd-ac2', kind: 'EXCLUDE', itemId: 's2' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { executed: boolean; originalDeleted: boolean; remake: { components: string[]; removedItemIds: string[]; keptItemIds: string[]; lineCountBefore: number; lineCountAfter: number }; jobId: string; planVersion: number };
    expect(body).toMatchObject({ executed: true, originalDeleted: false });
    expect(body.remake).toMatchObject({ components: ['SCENE', 'NARRATION', 'SUBTITLE'], removedItemIds: ['s2'], keptItemIds: ['s1', 's3'], lineCountBefore: 3, lineCountAfter: 2 });
    // 새 제작 계획은 제외 내용을 담지 않고, 장면 계획 입력·근거 검증도 그 내용을 쓸 수 없다.
    const snap = (await store.loadById('owner-a', id, clock))!;
    const plan = snap.versions.filter((v) => v.kind === 'PRODUCTION_PLAN').sort((a, b) => b.version - a.version)[0]!.content as ReturnType<typeof planOf>;
    expect(plan.lines.join(' ')).not.toContain('비밀 프로젝트');
    expect(scenePrompt(before, [], DEFAULT_NARRATION)).toContain('비밀 프로젝트');
    expect(scenePrompt(plan, [], DEFAULT_NARRATION)).not.toContain('비밀 프로젝트');
    const cite = JSON.stringify([{ type: 'DAILY', narration: '점심에 이야기를 했다', visual: '스케치', evidenceIds: ['s2'], photoId: null }]);
    expect(parseDrafts(cite, before, [])).toMatchObject({ ok: true });
    expect(parseDrafts(cite, plan, [])).toMatchObject({ ok: false, code: 'UNKNOWN_EVIDENCE' });
    // 원본 대화·이전 요약 버전은 그대로 남는다.
    expect(snap.versions.filter((v) => v.kind === 'SUMMARY').map((v) => v.version)).toEqual([1, 2]);
    // 같은 명령 재전송은 작업을 하나만 만든다.
    const again = (await post(`/api/records/${id}/revisions`, { commandId: 'cmd-ac2', kind: 'EXCLUDE', itemId: 's2' })).json() as { duplicate: boolean; jobId: string };
    expect(again).toMatchObject({ duplicate: true, jobId: body.jobId });
    expect((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE subject_id = $1', [id])).rows[0].n).toBe(1);
  });

  it('음성 수정: 이번 영상 제외만 실행하고 원본 삭제·불명확 문장은 아무것도 바꾸지 않는다', async () => {
    const id = await seed('owner-a', { pipeline: done, file: 'voice.mp4' });
    const del = (await post(`/api/records/${id}/revisions`, { commandId: 'v-del', kind: 'VOICE', itemId: 's2', command: '이 내용 기록에서 지워줘' })).json() as { executed: boolean; originalDeleted: boolean };
    expect(del).toMatchObject({ executed: false, originalDeleted: false });
    const unclear = (await post(`/api/records/${id}/revisions`, { commandId: 'v-un', kind: 'VOICE', itemId: 's2', command: '음 글쎄' })).json() as { executed: boolean };
    expect(unclear.executed).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE subject_id = $1', [id])).rows[0].n).toBe(0);
    const ok = await post(`/api/records/${id}/revisions`, { commandId: 'v-ok', kind: 'VOICE', itemId: 's2', command: '이 부분은 영상에서 빼줘' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { remake: { removedItemIds: string[] } }).remake.removedItemIds).toEqual(['s2']);
  });

  it('글 수정은 해당 항목만 바꾸고, 영상에 담을 내용이 모두 없어지면 거부한다', async () => {
    const id = await seed('owner-a', { pipeline: done, file: 'edit.mp4' });
    const r = (await post(`/api/records/${id}/revisions`, { commandId: 'e1', kind: 'EDIT_TEXT', itemId: 's1', text: '아침에 공원을 걸었다' })).json() as { remake: { changedItemIds: string[]; keptItemIds: string[] } };
    expect(r.remake).toMatchObject({ changedItemIds: ['s1'], keptItemIds: ['s2', 's3'] });
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'e2', kind: 'EDIT_TEXT', itemId: 's1', text: '' })).statusCode).toBe(409); // 이미 제작 중
    const only = await seed('owner-a', { pipeline: done, file: 'only.mp4' });
    await store.appendVersion('owner-a', only, 'SUMMARY', briefingContent(selectVideo([item('s1', '아침에 산책을 했다')])), clock);
    const res = await post(`/api/records/${only}/revisions`, { commandId: 'e3', kind: 'EXCLUDE', itemId: 's1' });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('NOTHING_TO_PRODUCE');
    expect((await get(`/api/records/${only}`)).json()).toMatchObject({ status: 'COMPLETED' });
  });

  it('AC-3 파일이 없으면 이유와 가능한 조치(다시 만들기)를 주고 다운로드·확인은 막는다', async () => {
    const id = await seed('owner-a', { pipeline: done, file: null });
    const d = (await get(`/api/records/${id}`)).json() as { status: string; nextActions: string[]; result: { fileAvailable: boolean; playable: boolean } };
    expect(d.status).toBe('RESULT_FILE_MISSING');
    expect(d.nextActions).toEqual(['EDIT_AND_REMAKE']);
    expect(d.result).toMatchObject({ fileAvailable: false, playable: false });
    const f = await get(`/api/records/${id}/results/1/file`);
    expect(f.statusCode).toBe(404);
    expect((f.json() as { error: string }).error).toBe('FILE_MISSING');
    expect((await post(`/api/records/${id}/result/confirm`, { version: 1, commandId: 'c' })).statusCode).toBe(409);
    // 조치: 다시 만들기가 실제로 가능하다.
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'miss', kind: 'EXCLUDE', itemId: 's3' })).statusCode).toBe(200);
  });

  it('AC-4 확인하지 않은 결과는 기한이 지나도 자동으로 확인·공개되지 않는다', async () => {
    const id = await seed('owner-a', { pipeline: done, file: 'ac4.mp4' });
    const read = async () => (await get(`/api/records/${id}`)).json() as { status: string; result: { confirmedAt: string | null; published: boolean } };
    expect((await read()).result).toMatchObject({ confirmedAt: null, published: false });
    const realNow = clock;
    clock = new Date(realNow.getTime() + 60 * 86400_000); // 60일 경과
    try {
      const later = await read();
      expect(later.status).toBe('COMPLETED');
      expect(later.result).toMatchObject({ confirmedAt: null, published: false });
      expect((await pool.query('SELECT count(*)::int AS n FROM result_confirmations WHERE interview_id = $1', [id])).rows[0].n).toBe(0);
      expect(((await get(`/api/records/${id}/results`)).json() as { versions: { confirmedAt: string | null }[] }).versions[0]!.confirmedAt).toBeNull();
      // 사용자가 직접 확인해야만 기록된다. 없는 버전은 거부.
      expect((await post(`/api/records/${id}/result/confirm`, { version: 7, commandId: 'x' })).statusCode).toBe(409);
      expect((await post(`/api/records/${id}/result/confirm`, { version: 1, commandId: 'x1' }, B)).statusCode).toBe(404);
      const ok = (await post(`/api/records/${id}/result/confirm`, { version: 1, commandId: 'x2' })).json() as { confirmedAt: string };
      expect(ok.confirmedAt).toBe(clock.toISOString());
      const again = (await post(`/api/records/${id}/result/confirm`, { version: 1, commandId: 'x3' })).json() as { confirmedAt: string; duplicate: boolean };
      expect(again).toMatchObject({ confirmedAt: ok.confirmedAt, duplicate: true });
    } finally { clock = realNow; }
    // 검수 미통과 결과는 확인할 수 없다.
    const rej = await seed('owner-a', { pipeline: { production: 'DONE', review: 'REJECTED' }, file: 'ac4rej.mp4' });
    expect((await post(`/api/records/${rej}/result/confirm`, { version: 1, commandId: 'r' })).statusCode).toBe(409);
  });

  it('AC-5 수정 중에는 이전 결과가 완성본으로 보이지 않고, 새 결과가 미통과여도 이전 버전이 완성본으로 되돌아오지 않는다', async () => {
    const id = await seed('owner-a', { pipeline: done, file: 'v1.mp4' });
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'r1', kind: 'EXCLUDE', itemId: 's2' })).statusCode).toBe(200);
    // (1) 제작 중: 현재 결과 없음, 기존 다운로드 경로 차단, 목록에도 완료로 안 보임
    const mid = (await get(`/api/records/${id}`)).json() as { status: string; result: unknown; nextActions: string[]; previousResultCount: number };
    expect(mid).toMatchObject({ status: 'PRODUCING', result: null, nextActions: ['WAIT'], previousResultCount: 1 });
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(404);
    const listed = ((await get('/api/records?limit=100')).json() as { records: { id: string; status: string; hasResult: boolean }[] }).records.find((r) => r.id === id)!;
    expect(listed).toMatchObject({ status: 'PRODUCING', hasResult: false });
    const vs1 = ((await get(`/api/records/${id}/results`)).json() as { versions: { version: number; role: string; status: string; priorStatus: string; downloadable: boolean }[] }).versions;
    expect(vs1).toEqual([expect.objectContaining({ version: 1, role: 'PREVIOUS', status: 'SUPERSEDED', priorStatus: 'COMPLETED', downloadable: true })]);
    // 수정 진행 중 다시 수정은 막힌다.
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'r2', kind: 'EXCLUDE', itemId: 's3' })).statusCode).toBe(409);
    // (2) 새 결과 v2 가 만들어졌지만 검수 미통과
    await store.appendVersion('owner-a', id, 'RESULT', { file: 'v2.mp4' }, clock);
    await writeFile(path.join(dir, 'videos', 'v2.mp4'), 'bytes-of-v2.mp4');
    await store.setPipeline('owner-a', id, { production: 'DONE', review: 'REJECTED' }, clock);
    const rej = (await get(`/api/records/${id}`)).json() as { status: string; result: { version: number; playable: boolean } };
    expect(rej.status).toBe('REVIEW_REJECTED');
    expect(rej.result).toMatchObject({ version: 2, playable: false });
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(409);
    expect((await get(`/api/records/${id}/results/2/file`)).statusCode).toBe(409);
    const vs2 = ((await get(`/api/records/${id}/results`)).json() as { versions: { version: number; role: string; status: string; downloadable: boolean }[] }).versions;
    expect(vs2.map((v) => `${v.version}:${v.role}:${v.status}:${v.downloadable}`)).toEqual(['2:CURRENT:REVIEW_REJECTED:false', '1:PREVIOUS:SUPERSEDED:true']);
    // (3) 검수 통과 후에만 v2 가 완성본, v1 은 계속 이전 버전
    await store.setPipeline('owner-a', id, { review: 'PASSED' }, clock);
    const ok = ((await get(`/api/records/${id}/results`)).json() as { versions: { version: number; role: string; status: string }[] }).versions;
    expect(ok.map((v) => `${v.version}:${v.role}:${v.status}`)).toEqual(['2:CURRENT:COMPLETED', '1:PREVIOUS:SUPERSEDED']);
    expect((await get(`/api/records/${id}/result/file`)).rawPayload.toString()).toBe('bytes-of-v2.mp4');
  });

  it('AC-5 수정 전 상태가 미통과였던 이전 버전은 내려받을 수 없다', async () => {
    const id = await seed('owner-a', { pipeline: { production: 'DONE', review: 'REJECTED' }, file: 'rejprev.mp4' });
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'rr', kind: 'EXCLUDE', itemId: 's2' })).statusCode).toBe(200);
    const f = await get(`/api/records/${id}/results/1/file`);
    expect(f.statusCode).toBe(409);
    expect((f.json() as { status: string }).status).toBe('SUPERSEDED');
    expect(((await get(`/api/records/${id}/results`)).json() as { versions: { downloadable: boolean; priorStatus: string }[] }).versions[0]).toMatchObject({ downloadable: false, priorStatus: 'REVIEW_REJECTED' });
  });

  it('진행 중(제작·검수 대기·예산 대기)에는 수정할 수 없고, 다른 사용자는 404', async () => {
    for (const pipeline of [{ production: 'RUNNING' }, { production: 'WAITING_BUDGET' }, { production: 'DONE', review: 'PENDING' }] as const) {
      const id = await seed('owner-a', { pipeline, file: undefined });
      const r = await post(`/api/records/${id}/revisions`, { commandId: `busy-${pipeline.production}-${'review' in pipeline ? 1 : 0}`, kind: 'EXCLUDE', itemId: 's2' });
      expect(r.statusCode).toBe(409);
    }
    const id = await seed('owner-a', { pipeline: done, file: 'own.mp4' });
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'o', kind: 'EXCLUDE', itemId: 's2' }, B)).statusCode).toBe(404);
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'bad', kind: 'NOPE', itemId: 's2' })).statusCode).toBe(400);
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'nf', kind: 'EXCLUDE', itemId: 'zzz' })).statusCode).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE subject_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('수동 재시도는 처리 실패한 기록에만 허용되고 같은 명령은 한 번만 반영된다', async () => {
    const id = await seed('owner-a', { pipeline: { production: 'FAILED' } });
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'rt0', kind: 'RETRY' })).statusCode).toBe(404); // 작업 없음
    await pool.query("INSERT INTO jobs (kind, subject_id, stages, idempotency_key, state) VALUES ('VIDEO_PRODUCTION', $1, ARRAY['PRODUCE'], $2, 'FAILED')", [id, `k-${id}`]);
    const r = await post(`/api/records/${id}/revisions`, { commandId: 'rt1', kind: 'RETRY' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ executed: true, kind: 'RETRY', duplicate: false, status: 'PRODUCING' });
    expect((await get(`/api/records/${id}`)).json()).toMatchObject({ status: 'PRODUCING' });
    expect(retries).toHaveLength(1);
    const ok = await seed('owner-a', { pipeline: done, file: 'noretry.mp4' });
    expect((await post(`/api/records/${ok}/revisions`, { commandId: 'rt2', kind: 'RETRY' })).statusCode).toBe(409);
  });
});
