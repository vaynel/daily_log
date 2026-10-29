import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import type { ProductionPlan, ProInfer } from '../briefing/briefing.js';
import { buildSubtitles } from '../video/subtitles.js';
import { buildScenePlan, scenePrompt, DEFAULT_NARRATION } from '../video/scenePlan.js';
import { createTempSchema } from './db.testutil.js';
import { applyRevision } from './revision.js';
import { parseRange } from './routes.js';
import { RecordStore } from './store.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const cookie = (sub: string, email: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 * 24 * 400 }, SECRET, 'session')}`;
};

const PLAN: ProductionPlan = {
  source: 'BRIEFING', briefingVersion: 1,
  lines: ['아침에 산책을 했다', '회사 동료와 점심을 먹었다', '저녁에 책을 읽었다'],
  items: [
    { id: 'i1', text: '아침에 산책을 했다', emphasis: false },
    { id: 'i2', text: '회사 동료와 점심을 먹었다', emphasis: false },
    { id: 'i3', text: '저녁에 책을 읽었다', emphasis: true },
  ],
};

/** 프롬프트의 [확정 기록] 항목마다 장면 하나를 그대로 돌려주는 가짜 모델(유료 호출 없음). */
const echoInfer: ProInfer = async ({ text }) => {
  const block = text.split('[확정 기록]\n')[1]!.split('\n\n[사진]')[0]!;
  const scenes = block.split('\n').map((l) => /^- (\S+?)(?: \[강조\])?: (.+)$/.exec(l)!).map((m) => ({ type: 'DAILY', narration: m[2], visual: `${m[2]} 장면`, evidenceIds: [m[1]], photoId: null }));
  return { state: 'SUCCEEDED', text: JSON.stringify(scenes) } as never;
};

describe('applyRevision (순수 로직)', () => {
  it('키워드 제외는 해당 항목만 빼고 장면·내레이션·자막 재제작을 지정한다', () => {
    const r = applyRevision(PLAN, { kind: 'EXCLUDE', keyword: '동료' });
    expect(r.ok && r.plan.items.map((i) => i.id)).toEqual(['i1', 'i3']);
    expect(r.ok && r.plan.remake.components).toEqual(['SCENE', 'NARRATION', 'SUBTITLE']);
    expect(r.ok && r.plan.lines).toEqual(['아침에 산책을 했다', '저녁에 책을 읽었다']);
  });
  it('일치 항목이 없거나 전부 빼면 거부하고, 삭제·불명확 음성 명령은 실행하지 않는다', () => {
    expect(applyRevision(PLAN, { kind: 'EXCLUDE', keyword: '없는말' })).toMatchObject({ ok: false, code: 'NO_MATCH' });
    expect(applyRevision({ ...PLAN, items: [PLAN.items[0]!], lines: ['x'] }, { kind: 'EXCLUDE', itemId: 'i1' })).toMatchObject({ ok: false, code: 'NO_CONTENT' });
    expect(applyRevision(PLAN, { kind: 'VOICE', text: '"동료" 기록 삭제해줘' })).toMatchObject({ ok: false, code: 'NOT_EXECUTED', scope: 'DELETE_ORIGINAL' });
    expect(applyRevision(PLAN, { kind: 'VOICE', text: '음 글쎄' })).toMatchObject({ ok: false, code: 'NOT_EXECUTED', scope: 'UNCLEAR' });
    const v = applyRevision(PLAN, { kind: 'VOICE', text: '앞으로 "동료" 얘기는 빼줘' });
    expect(v).toMatchObject({ ok: true, suggestedKeywords: ['동료'], removedIds: ['i2'] });
  });
  it('글 수정은 항목 글만 바꾸고, 상시 제외 내용은 거부한다', () => {
    const r = applyRevision(PLAN, { kind: 'EDIT_TEXT', itemId: 'i1', text: '공원을 걸었다' });
    expect(r.ok && r.plan.items[0]!.text).toBe('공원을 걸었다');
    expect(applyRevision(PLAN, { kind: 'EDIT_TEXT', itemId: 'zz', text: '가' })).toMatchObject({ ok: false, code: 'NO_MATCH' });
  });
  it('parseRange', () => {
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange('bytes=20-30', 10)).toBe('invalid');
    expect(parseRange(undefined, 10)).toBeNull();
  });
});

describe('AC-2 제외 전/후 비교: 장면 계획·내레이션·자막', () => {
  it('제외한 항목이 장면 프롬프트·내레이션 원고·자막 줄 모두에서 사라진다', async () => {
    const out = applyRevision(PLAN, { kind: 'EXCLUDE', keyword: '동료' });
    if (!out.ok) throw new Error('rejected');
    const build = async (plan: ProductionPlan) => {
      const prompt = scenePrompt(plan, [], DEFAULT_NARRATION);
      const r = await buildScenePlan({ plan, photos: [], lifeDate: '2026-10-20', infer: echoInfer });
      if (!r.ok) throw new Error(r.code);
      let t = 0;
      const subtitles = r.plan.scenes.flatMap((s) => { const seg = { startSec: t, endSec: t + 4 }; t += 4.5; return buildSubtitles(s, seg); });
      return { prompt, scenes: r.plan.scenes, narration: r.plan.scenes.map((s) => s.narration).join(' '), subtitleText: subtitles.map((c) => c.text.replace(/\n/g, ' ')).join(' ') };
    };
    const before = await build(PLAN);
    const after = await build(out.plan);
    for (const part of [before.prompt, before.scenes.map((s) => s.visual).join(' '), before.narration, before.subtitleText]) expect(part).toContain('동료');
    for (const part of [after.prompt, after.scenes.map((s) => s.visual).join(' '), after.narration, after.subtitleText]) expect(part).not.toContain('동료');
    expect(before.scenes).toHaveLength(3);
    expect(after.scenes).toHaveLength(2);
  });
});

describe.skipIf(!url)('결과 버전·수정·재생·다운로드 API (실제 PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let app: FastifyInstance;
  let dir: string;
  let clock = new Date('2026-10-25T10:00:00+09:00');
  const A = cookie('owner-a', 'a@example.test');
  const B = cookie('owner-b', 'b@example.test');
  const get = (u: string, c: string | null = A, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: u, headers: { ...(c ? { cookie: c } : {}), ...headers } });
  const post = (u: string, body: unknown, c: string | null = A) => app.inject({ method: 'POST', url: u, payload: body as object, headers: c ? { cookie: c } : {} });
  const BYTES = Buffer.from('0123456789abcdef');
  let seq = 0;

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-rev-'));
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    await writeFile(path.join(dir, 'videos', 'v1.mp4'), BYTES);
    await writeFile(path.join(dir, 'videos', 'v2.mp4'), BYTES);
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test,b@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    app = buildApp({ auth, sessionSecret: SECRET, fileStorageDir: dir, records: store, now: () => clock });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  /** 확정·제작 완료된 기록(결과 v1). */
  const completed = async (review: 'PASSED' | 'PENDING' | 'REJECTED' = 'PASSED', file = 'v1.mp4') => {
    const date = `2026-09-${String(++seq).padStart(2, '0')}`;
    const id = (await store.startInterview('owner-a', new Date(`${date}T10:00:00+09:00`), date)).interview.id;
    await store.confirm('owner-a', id, clock);
    await store.startProduction('owner-a', id, PLAN, clock);
    await store.setPipeline('owner-a', id, { production: 'DONE', review }, clock);
    await store.appendVersion('owner-a', id, 'RESULT', { file }, clock);
    return id;
  };
  const rev = (id: string, body: object, c: string | null = A) => post(`/api/records/${id}/revisions`, { commandId: `cmd-${Math.random().toString(36).slice(2, 12)}`, ...body }, c);

  it('AC-1 로그인한 소유자는 재생(Range 206)·내려받기 가능, 타 사용자 404·비로그인 401', async () => {
    const id = await completed();
    const list = (await get(`/api/records/${id}/results`)).json() as { current: number; versions: { version: number; role: string; status: string; playable: boolean; downloadable: boolean }[] };
    expect(list.current).toBe(1);
    expect(list.versions[0]).toMatchObject({ role: 'CURRENT', status: 'COMPLETED', playable: true, downloadable: true });
    const full = await get(`/api/records/${id}/results/1/file`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(String(full.headers['content-disposition'])).toMatch(/^inline/);
    expect(full.rawPayload.equals(BYTES)).toBe(true);
    const part = await get(`/api/records/${id}/results/1/file`, A, { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    expect(part.rawPayload.toString()).toBe('2345');
    expect((await get(`/api/records/${id}/results/1/file`, A, { range: 'bytes=99-120' })).statusCode).toBe(416);
    const dl = await get(`/api/records/${id}/results/1/file?download=1`);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment/);
    expect(dl.rawPayload.equals(BYTES)).toBe(true);
    expect((await get(`/api/records/${id}/results/1/file`, B)).statusCode).toBe(404);
    expect((await get(`/api/records/${id}/results`, B)).statusCode).toBe(404);
    expect((await get(`/api/records/${id}/results/1/file`, null)).statusCode).toBe(401);
    expect((await get(`/api/records/${id}/results/9/file`)).statusCode).toBe(404);
  });

  it('AC-3 파일이 없으면 404 FILE_MISSING 과 RESULT_FILE_MISSING 상태(재생·내려받기 모두)', async () => {
    const id = await completed('PASSED', 'gone.mp4');
    const f = await get(`/api/records/${id}/results/1/file`);
    expect(f.statusCode).toBe(404);
    expect(f.json()).toMatchObject({ error: 'FILE_MISSING' });
    const d = (await get(`/api/records/${id}`)).json() as { status: string; nextActions: string[] };
    expect(d.status).toBe('RESULT_FILE_MISSING');
    expect(d.nextActions).not.toContain('DOWNLOAD');
    const list = (await get(`/api/records/${id}/results`)).json() as { versions: { status: string; playable: boolean }[] };
    expect(list.versions[0]).toMatchObject({ status: 'RESULT_FILE_MISSING', playable: false });
  });

  it('AC-4 미확인(검수 중) 결과는 시간이 아무리 지나도 공개·확인되지 않는다', async () => {
    const id = await completed('PENDING');
    const check = async () => {
      expect((await get(`/api/records/${id}/results/1/file`)).statusCode).toBe(409);
      expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(409);
      expect((await get(`/api/records/${id}`)).json()).toMatchObject({ status: 'REVIEW_PENDING' });
      expect((await post(`/api/records/${id}/result/confirm`, { version: 1 })).statusCode).toBe(409);
    };
    await check();
    const real = clock;
    for (const days of [1, 31, 400]) { clock = new Date(real.getTime() + days * 86400_000); await check(); }
    clock = real;
    expect((await pool.query('SELECT 1 FROM result_confirmations WHERE interview_id=$1', [id])).rowCount).toBe(0);
  });

  it('완료 결과는 사용자가 확인하며 재확인은 처음 시각을 유지한다', async () => {
    const id = await completed();
    const c1 = (await post(`/api/records/${id}/result/confirm`, { version: 1 })).json() as { confirmedAt: string; duplicate: boolean };
    expect(c1.duplicate).toBe(false);
    clock = new Date(clock.getTime() + 3600_000);
    const c2 = (await post(`/api/records/${id}/result/confirm`, { version: 1 })).json() as { confirmedAt: string; duplicate: boolean };
    expect(c2).toMatchObject({ duplicate: true, confirmedAt: c1.confirmedAt });
    expect((await post(`/api/records/${id}/result/confirm`, { version: 2 })).statusCode).toBe(409);
    expect((await post(`/api/records/${id}/result/confirm`, { version: 1 }, B)).statusCode).toBe(404);
  });

  it('AC-5 수정하면 이전 결과는 대체되어 정상 완성본으로 보이지 않고, 새 결과도 검수 전에는 완료가 아니다', async () => {
    const id = await completed();
    const r = await rev(id, { kind: 'EXCLUDE', keyword: '동료' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ duplicate: false, planVersion: 2, remake: ['SCENE', 'NARRATION', 'SUBTITLE'] });
    // 수정 직후: 제작 중. 이전 결과 파일이 남아 있어도 완료로 보이거나 내려받아지지 않는다.
    const d = (await get(`/api/records/${id}`)).json() as { status: string; result: unknown; nextActions: string[] };
    expect(d.status).toBe('PRODUCING');
    expect(d.result).toBeNull();
    expect(d.nextActions).not.toContain('DOWNLOAD');
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(404);
    // 이전 버전은 PREVIOUS/SUPERSEDED 로만 조회된다.
    let list = (await get(`/api/records/${id}/results`)).json() as { current: number | null; versions: { version: number; role: string; status: string }[] };
    expect(list.current).toBeNull();
    expect(list.versions).toMatchObject([{ version: 1, role: 'PREVIOUS', status: 'SUPERSEDED' }]);
    // 새 결과(v2)가 생겨도 검수 통과 전에는 정상 완성본이 아니다.
    await store.appendVersion('owner-a', id, 'RESULT', { file: 'v2.mp4' }, clock);
    await store.setPipeline('owner-a', id, { production: 'DONE', review: 'PENDING' }, clock);
    list = (await get(`/api/records/${id}/results`)).json() as typeof list;
    expect(list.versions.map((v) => [v.version, v.role, v.status])).toEqual([[2, 'CURRENT', 'REVIEW_PENDING'], [1, 'PREVIOUS', 'SUPERSEDED']]);
    expect((await get(`/api/records/${id}/results/2/file`)).statusCode).toBe(409);
    await store.setPipeline('owner-a', id, { review: 'REJECTED' }, clock);
    expect((await get(`/api/records/${id}`)).json()).toMatchObject({ status: 'REVIEW_REJECTED' });
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(409);
    // 통과하면 v2 만 완료이고 v1 은 여전히 이전 버전이다.
    await store.setPipeline('owner-a', id, { review: 'PASSED' }, clock);
    list = (await get(`/api/records/${id}/results`)).json() as typeof list;
    expect(list.versions.map((v) => [v.version, v.status])).toEqual([[2, 'COMPLETED'], [1, 'SUPERSEDED']]);
    expect((await get(`/api/records/${id}/results/2/file`)).statusCode).toBe(200);
    expect((await get(`/api/records/${id}`)).json()).toMatchObject({ status: 'COMPLETED', result: { version: 2 } });
  });

  it('수정 계획은 한 트랜잭션으로 새 제작 계획 버전·작업·표식을 만들고 제외 항목이 계획에서 빠진다', async () => {
    const id = await completed();
    const r = (await rev(id, { kind: 'VOICE', text: '"동료" 부분은 영상에서 빼줘' })).json() as { jobId: string; planVersion: number };
    const plan = await pool.query("SELECT content FROM record_versions WHERE interview_id=$1 AND kind='PRODUCTION_PLAN' AND version=$2", [id, r.planVersion]);
    const content = plan.rows[0].content as { lines: string[]; items: { id: string }[]; remake: { components: string[] }; excludedIds: string[] };
    expect(JSON.stringify(content.lines)).not.toContain('동료');
    expect(content.remake.components).toEqual(['SCENE', 'NARRATION', 'SUBTITLE']);
    expect(content.excludedIds).toEqual(['i2']);
    expect((await pool.query('SELECT state FROM jobs WHERE id=$1', [r.jobId])).rows[0].state).toBe('QUEUED');
    expect((await pool.query('SELECT review_at_supersede FROM result_version_marks WHERE interview_id=$1', [id])).rows[0].review_at_supersede).toBe('PASSED');
    expect((await pool.query('SELECT review, production FROM pipeline_states WHERE interview_id=$1', [id])).rows[0]).toEqual({ review: 'NONE', production: 'QUEUED' });
  });

  it('commandId 멱등: 같은 요청은 한 번만 처리, 다른 내용은 충돌, 진행 중에는 새 수정 거부', async () => {
    const id = await completed();
    const body = { commandId: 'cmd-idem-0001', kind: 'EXCLUDE', keyword: '동료' };
    const a = await post(`/api/records/${id}/revisions`, body);
    const b = await post(`/api/records/${id}/revisions`, body);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ duplicate: true, jobId: (a.json() as { jobId: string }).jobId });
    expect((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE subject_id=$1", [id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM record_versions WHERE interview_id=$1 AND kind='PRODUCTION_PLAN'", [id])).rows[0].n).toBe(2);
    expect((await post(`/api/records/${id}/revisions`, { ...body, keyword: '산책' })).statusCode).toBe(409);
    expect((await rev(id, { kind: 'EXCLUDE', keyword: '산책' })).statusCode).toBe(409); // 제작 진행 중
  });

  it('반영되지 않는 요청(일치 없음·삭제 명령·불명확)은 아무것도 바꾸지 않는다', async () => {
    const id = await completed();
    for (const [body, code] of [
      [{ kind: 'EXCLUDE', keyword: '없는말' }, 'NO_MATCH'],
      [{ kind: 'VOICE', text: '"동료" 삭제해줘' }, 'NOT_EXECUTED'],
      [{ kind: 'VOICE', text: '음...' }, 'NOT_EXECUTED'],
    ] as const) {
      const r = await rev(id, body);
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ error: code });
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM record_versions WHERE interview_id=$1 AND kind='PRODUCTION_PLAN'", [id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM result_version_marks WHERE interview_id=$1', [id])).rows[0].n).toBe(0);
    expect((await get(`/api/records/${id}`)).json()).toMatchObject({ status: 'COMPLETED' });
    expect((await rev(id, { kind: 'BOGUS' })).statusCode).toBe(400);
    expect((await rev(id, { kind: 'EXCLUDE', keyword: '동료' }, B)).statusCode).toBe(404);
    expect((await post(`/api/records/${id}/revisions`, { kind: 'RETRY' }, null)).statusCode).toBe(401);
  });

  it('수동 재시도는 실패한 같은 작업을 다시 올리고 자동 재시도 횟수를 계승한다', async () => {
    const id = await completed();
    await store.setPipeline('owner-a', id, { production: 'FAILED', review: 'NONE' }, clock);
    const job = await pool.query("INSERT INTO jobs (kind, subject_id, stages, idempotency_key, state, auto_retries_used) VALUES ('VIDEO_PRODUCTION',$1,ARRAY['PRODUCE'],$2,'FAILED',1) RETURNING id", [id, `k-${id}`]);
    expect((await rev(id, { kind: 'RETRY' }, B)).statusCode).toBe(404);
    const r = await post(`/api/records/${id}/revisions`, { commandId: 'cmd-retry-0001', kind: 'RETRY' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ jobId: job.rows[0].id, remake: [] });
    expect((await pool.query('SELECT state, auto_retries_used, manual_requests FROM jobs WHERE id=$1', [job.rows[0].id])).rows[0]).toEqual({ state: 'QUEUED', auto_retries_used: 1, manual_requests: 1 });
    expect((await post(`/api/records/${id}/revisions`, { commandId: 'cmd-retry-0001', kind: 'RETRY' })).statusCode).toBe(200);
    expect((await pool.query('SELECT manual_requests FROM jobs WHERE id=$1', [job.rows[0].id])).rows[0].manual_requests).toBe(1);
    // 작업이 이미 대기열에 있으면 다시 시도할 것이 없다.
    expect((await rev(id, { kind: 'RETRY' })).statusCode).toBe(409);
  });
});
