import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { buildItems, planOf } from '../briefing/briefing.js';
import { briefingContent } from '../briefing/routes.js';
import { createTempSchema } from './db.testutil.js';
import { registerRevisionRoutes } from './revision.js';
import { RecordStore, type PipelineState } from './store.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const cookie = (sub: string, email: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 }, SECRET, 'session')}`;
};
const A = cookie('owner-a', 'a@example.test');
const B = cookie('owner-b', 'b@example.test');
const NOW = new Date('2026-10-25T10:00:00+09:00');
const FUTURE = new Date('2027-03-01T10:00:00+09:00');
const VIDEO = Buffer.from('0123456789abcdefghij');

const ITEMS = buildItems([
  { kind: 'FACT', source: 'USER', text: '에코 버그를 고쳤다', emphasis: true },
  { kind: 'FACT', source: 'USER', text: '점심에 김치찌개를 먹었다' },
  { kind: 'OPINION', source: 'USER', text: '뿌듯했다' },
] as never);

type Pipe = Partial<PipelineState>;

describe.skipIf(!url)('결과 확인·수정·버전 (실제 PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let app: FastifyInstance;
  let lateApp: FastifyInstance;
  let dir: string;
  let seq = 0;

  const make = (now: Date) => {
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test,b@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    const a = buildApp({ auth, sessionSecret: SECRET, fileStorageDir: dir, records: store, now: () => now });
    registerRevisionRoutes(a, { store, now: () => now });
    return a;
  };
  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-rev-'));
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    app = make(NOW);
    lateApp = make(FUTURE);
  });
  afterAll(async () => {
    await app.close();
    await lateApp.close();
    await pool.end();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (u: string, c = A, headers: Record<string, string> = {}, a = app) => a.inject({ method: 'GET', url: u, headers: { cookie: c, ...headers } });
  const post = (u: string, body: object, c = A) => app.inject({ method: 'POST', url: u, headers: { cookie: c }, payload: body });
  const writeVideo = (name: string) => writeFile(path.join(dir, 'videos', name), VIDEO);

  /** 확정된 기록 + 브리핑 + 결과 v1 (+ 파이프라인 상태). */
  async function seed(pipe: Pipe, opts: { confirmed?: boolean; result?: boolean } = {}) {
    const date = `2026-09-${String(++seq).padStart(2, '0')}`;
    const id = (await store.startInterview('owner-a', new Date(`${date}T10:00:00+09:00`), date)).interview.id;
    await store.appendVersion('owner-a', id, 'SUMMARY', briefingContent(ITEMS), NOW);
    if (opts.confirmed !== false) {
      await store.confirmBriefing('owner-a', id, { briefingVersion: 1, plan: planOf(ITEMS, 1), job: { kind: 'VIDEO_PRODUCTION', stages: ['PRODUCE'], idempotencyKey: `seed:${id}` } }, NOW);
    }
    await store.setPipeline('owner-a', id, { production: 'DONE', review: 'PASSED', ...pipe }, NOW);
    if (opts.result !== false) {
      await writeVideo(`${id}-1.mp4`);
      await store.appendVersion('owner-a', id, 'RESULT', { file: `${id}-1.mp4` }, NOW);
    }
    return id;
  }
  const results = async (id: string) => ((await get(`/api/records/${id}/results`)).json() as { results: { version: number; state: string; downloadable: boolean }[] }).results;

  it('AC-1 로그인 사용자는 재생(Range)·다운로드 200, 비로그인 401, 타인 404', async () => {
    const id = await seed({});
    const play = await get(`/api/records/${id}/results/1/file`);
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toBe('video/mp4');
    expect(String(play.headers['content-disposition'])).toMatch(/^inline/);
    expect(play.headers['accept-ranges']).toBe('bytes');
    expect(play.rawPayload.equals(VIDEO)).toBe(true);
    const part = await get(`/api/records/${id}/results/1/file`, A, { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 2-5/${VIDEO.length}`);
    expect(part.rawPayload.toString()).toBe('2345');
    expect((await get(`/api/records/${id}/results/1/file`, A, { range: 'bytes=999-' })).statusCode).toBe(416);
    const dl = await get(`/api/records/${id}/results/1/file?download=1`);
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment/);
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(200); // 기존 경로 유지
    expect((await app.inject({ method: 'GET', url: `/api/records/${id}/results/1/file` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/records/${id}/results` })).statusCode).toBe(401);
    expect((await get(`/api/records/${id}/results/1/file`, B)).statusCode).toBe(404);
    expect((await get(`/api/records/${id}/results`, B)).statusCode).toBe(404);
    expect((await get(`/api/records/${id}/results/9/file`)).statusCode).toBe(404);
    expect(await results(id)).toEqual([{ version: 1, state: 'CURRENT', downloadable: true, playable: true, fileAvailable: true, createdAt: expect.any(String) }]);
  });

  it('AC-1 미통과·검수 대기 결과는 409 NOT_DOWNLOADABLE, 파일이 없으면 404 FILE_MISSING', async () => {
    for (const review of ['REJECTED', 'PENDING'] as const) {
      const id = await seed({ review });
      const r = await get(`/api/records/${id}/results/1/file`);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'NOT_DOWNLOADABLE' });
      expect((await results(id))[0]).toMatchObject({ state: 'NOT_PASSED', downloadable: false });
    }
    const id = await seed({});
    await rm(path.join(dir, 'videos', `${id}-1.mp4`));
    const miss = await get(`/api/records/${id}/results/1/file`);
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toMatchObject({ error: 'FILE_MISSING' });
    expect((await results(id))[0]).toMatchObject({ fileAvailable: false, downloadable: false });
  });

  it('AC-4 확인하지 않은 결과는 기한이 지나도 공개·다운로드되지 않는다', async () => {
    const id = await seed({}, { confirmed: false });
    expect((await store.loadById('owner-a', id, FUTURE))!.interview.status).toBe('IN_PROGRESS');
    const late = await get(`/api/records/${id}/results/1/file`, A, {}, lateApp);
    expect(late.statusCode).toBe(409);
    expect(((await get(`/api/records/${id}`, A, {}, lateApp)).json() as { status: string }).status).toBe('WRITING');
    expect((await get(`/api/records/${id}/result/file`, A, {}, lateApp)).statusCode).toBe(409);
    const rev = await lateApp.inject({ method: 'POST', url: `/api/records/${id}/revisions`, headers: { cookie: A }, payload: { type: 'RETRY', commandId: 'late-1' } });
    expect(rev.statusCode).toBe(409);
    // 검수 대기(사용자 확인 전 품질 검수)도 시간이 지나 자동 통과하지 않는다.
    const pending = await seed({ review: 'PENDING' });
    expect((await get(`/api/records/${pending}/results/1/file`, A, {}, lateApp)).statusCode).toBe(409);
    expect((await store.loadById('owner-a', pending, FUTURE))!.pipeline.review).toBe('PENDING');
  });

  it('AC-2 제외 수정은 장면·내레이션·자막 재제작 범위와 새 제작 계획에 함께 반영되고 이전 계획은 보존', async () => {
    const id = await seed({});
    const target = ITEMS.find((i) => i.text.includes('김치찌개'))!;
    const before = planOf(ITEMS, 1).lines;
    const r = await post(`/api/records/${id}/revisions`, { type: 'EXCLUDE', itemId: target.id, commandId: 'c-ex-1' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { executed: boolean; remakeScope: string[]; lines: string[]; planVersion: number; jobId: string; originalDeleted: boolean };
    expect(body).toMatchObject({ executed: true, originalDeleted: false, remakeScope: ['SCENE', 'NARRATION', 'SUBTITLE'] });
    expect(before).toContain(target.text);
    expect(body.lines).not.toContain(target.text);
    const snap = (await store.loadById('owner-a', id, NOW))!;
    const plans = snap.versions.filter((v) => v.kind === 'PRODUCTION_PLAN').sort((a, b) => a.version - b.version);
    expect(JSON.stringify(plans[0]!.content)).toContain(target.text); // 이전 계획은 그대로
    const latest = plans[plans.length - 1]!.content as { lines: string[]; items: { id: string }[]; remake: { scope: string[] } };
    expect(latest.lines).toEqual(body.lines);
    expect(latest.items.map((i) => i.id)).not.toContain(target.id);
    expect(latest.remake.scope).toEqual(['SCENE', 'NARRATION', 'SUBTITLE']);
    expect(snap.pipeline).toMatchObject({ production: 'QUEUED', review: 'NONE' });
    const j = await pool.query('SELECT kind, subject_id FROM jobs WHERE id = $1', [body.jobId]);
    expect(j.rows[0]).toMatchObject({ kind: 'VIDEO_PRODUCTION', subject_id: id });
    // 같은 명령 재전송은 중복 작업을 만들지 않는다.
    const again = await post(`/api/records/${id}/revisions`, { type: 'EXCLUDE', itemId: target.id, commandId: 'c-ex-1' });
    expect(again.json()).toMatchObject({ duplicate: true, jobId: body.jobId });
    expect((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE subject_id = $1', [id])).rows[0].n).toBe(2); // 최초 제작 1 + 수정 1
  });

  it('D26-02 상세 글 수정은 정책 제외 문장을 영상에 넣지 못하고, 정상 문장은 계획에 반영', async () => {
    const id = await seed({});
    const t0 = ITEMS.find((i) => i.text.includes('뿌듯'))!;
    const ok = await post(`/api/records/${id}/revisions`, { type: 'EDIT_TEXT', itemId: t0.id, text: '배포가 끝나서 뿌듯했다', commandId: 'c-ed-1' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { lines: string[] }).lines).toContain('배포가 끝나서 뿌듯했다');
    await store.setPipeline('owner-a', id, { production: 'DONE', review: 'PASSED' }, NOW);
    const bad = await post(`/api/records/${id}/revisions`, { type: 'EDIT_TEXT', itemId: t0.id, text: '팀장은 무능해서 회의가 길었다', commandId: 'c-ed-2' });
    expect(bad.statusCode).toBe(200);
    expect((bad.json() as { lines: string[] }).lines.join(' ')).not.toContain('무능');
    expect((await post(`/api/records/${id}/revisions`, { type: 'EDIT_TEXT', itemId: t0.id, commandId: 'c-ed-3' })).statusCode).toBe(400);
    expect((await post(`/api/records/${id}/revisions`, { type: 'EDIT_TEXT', itemId: t0.id, text: 'x' })).statusCode).toBe(400); // commandId 없음
  });

  it('D26-02 음성 명령: 삭제·불명확·대상 불명은 아무것도 바꾸지 않고, 지정한 한 항목만 제외', async () => {
    const id = await seed({});
    const count = async () => ({
      jobs: (await pool.query('SELECT count(*)::int AS n FROM jobs WHERE subject_id = $1', [id])).rows[0].n as number,
      versions: (await store.loadById('owner-a', id, NOW))!.versions.length,
    });
    const base = await count();
    const del = await post(`/api/records/${id}/revisions`, { type: 'VOICE', text: '"김치찌개" 기록 삭제해 줘', commandId: 'v-1' });
    expect(del.json()).toMatchObject({ scope: 'DELETE_ORIGINAL', executed: false, originalDeleted: false });
    expect((await post(`/api/records/${id}/revisions`, { type: 'VOICE', text: '음 그러니까', commandId: 'v-2' })).json()).toMatchObject({ scope: 'UNCLEAR', executed: false });
    expect((await post(`/api/records/${id}/revisions`, { type: 'VOICE', text: '"없는말" 부분은 빼 줘', commandId: 'v-3' })).json()).toMatchObject({ executed: false, needsTarget: true });
    expect(await count()).toEqual(base);
    expect((await store.loadById('owner-a', id, NOW))!.pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });
    const ok = await post(`/api/records/${id}/revisions`, { type: 'VOICE', text: '"김치찌개" 부분은 영상에서 빼 줘', commandId: 'v-4' });
    expect(ok.json()).toMatchObject({ executed: true });
    expect((ok.json() as { lines: string[] }).lines.join(' ')).not.toContain('김치찌개');
    expect((ok.json() as { lines: string[] }).lines).toHaveLength(2);
  });

  it('AC-5 수정 중에는 이전 결과가 정상 완성본으로 표시·다운로드되지 않고 이전 버전으로만 남는다', async () => {
    const id = await seed({});
    const target = ITEMS[1]!;
    expect((await post(`/api/records/${id}/revisions`, { type: 'EXCLUDE', itemId: target.id, commandId: 'a5-1' })).statusCode).toBe(200);
    // 수정 제작 중: 최신 결과 v1 은 대체됨. 정상 완료로 보이지 않는다.
    expect(((await get(`/api/records/${id}`)).json() as { status: string }).status).toBe('PRODUCING');
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(409);
    expect(await results(id)).toMatchObject([{ version: 1, state: 'PREVIOUS', downloadable: true }]);
    // 제작·검수가 진행 중이면 겹쳐 수정할 수 없다.
    expect((await post(`/api/records/${id}/revisions`, { type: 'EXCLUDE', itemId: ITEMS[2]!.id, commandId: 'a5-2' })).statusCode).toBe(409);
    // 파이프라인이 먼저 끝나고 새 결과가 아직 등록되지 않은 틈에도 옛 결과를 정상본으로 내지 않는다.
    await store.setPipeline('owner-a', id, { production: 'DONE', review: 'PASSED' }, NOW);
    expect(((await get(`/api/records/${id}`)).json() as { status: string }).status).toBe('PRODUCING');
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(409);
    expect(((await get('/api/records')).json() as { records: { id: string; status: string }[] }).records.find((r) => r.id === id)!.status).toBe('PRODUCING');
    // 새 결과(v2)가 미통과면 v1 은 이전 버전, v2 는 NOT_PASSED. 어느 쪽도 현재 정상본이 아니다.
    await writeVideo(`${id}-2.mp4`);
    await store.appendVersion('owner-a', id, 'RESULT', { file: `${id}-2.mp4` }, NOW);
    await store.setPipeline('owner-a', id, { review: 'REJECTED' }, NOW);
    expect(await results(id)).toMatchObject([{ version: 2, state: 'NOT_PASSED', downloadable: false }, { version: 1, state: 'PREVIOUS', downloadable: true }]);
    expect((await get(`/api/records/${id}/results/2/file`)).statusCode).toBe(409);
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(409);
    const prev = await get(`/api/records/${id}/results/1/file`);
    expect(prev.statusCode).toBe(200);
    expect(prev.headers['x-result-state']).toBe('PREVIOUS');
    // 통과하면 v2 만 CURRENT.
    await store.setPipeline('owner-a', id, { review: 'PASSED' }, NOW);
    expect(await results(id)).toMatchObject([{ version: 2, state: 'CURRENT', downloadable: true }, { version: 1, state: 'PREVIOUS', downloadable: true }]);
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(200);
  });

  it('AC-5 미통과 버전은 수정·재시도를 거쳐도 정상본이 되지 않는다(SUPERSEDED_NOT_PASSED)', async () => {
    const id = await seed({ review: 'REJECTED' });
    expect((await post(`/api/records/${id}/revisions`, { type: 'RETRY', commandId: 'r-1' })).statusCode).toBe(200);
    expect(await results(id)).toMatchObject([{ version: 1, state: 'SUPERSEDED_NOT_PASSED', downloadable: false }]);
    expect((await get(`/api/records/${id}/results/1/file`)).statusCode).toBe(409);
    // 정상 완료된 결과는 RETRY 로 다시 만들 수 없다.
    const ok = await seed({});
    const r = await post(`/api/records/${ok}/revisions`, { type: 'RETRY', commandId: 'r-2' });
    expect(r.statusCode).toBe(409);
    expect(await results(ok)).toMatchObject([{ version: 1, state: 'CURRENT' }]);
  });

  it('D26-02 RETRY 는 실패한 제작만 같은 계획으로 새 작업을 만들고, 미확인·타인 기록은 거부', async () => {
    const id = await seed({ production: 'FAILED', review: 'NONE' }, { result: false });
    const before = (await store.loadById('owner-a', id, NOW))!.versions.filter((v) => v.kind === 'PRODUCTION_PLAN').length;
    const r = await post(`/api/records/${id}/revisions`, { type: 'RETRY', commandId: 'rt-1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ executed: true, previousVersionKept: null });
    const snap = (await store.loadById('owner-a', id, NOW))!;
    expect(snap.versions.filter((v) => v.kind === 'PRODUCTION_PLAN')).toHaveLength(before + 1);
    expect(snap.pipeline.production).toBe('QUEUED');
    expect((await post(`/api/records/${id}/revisions`, { type: 'RETRY', commandId: 'rt-1' }, B)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/records/${id}/revisions`, payload: { type: 'RETRY', commandId: 'x' } })).statusCode).toBe(401);
  });
});
