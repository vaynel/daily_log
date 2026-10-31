import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { VIDEO_JOB_STAGES } from '../briefing/briefing.js';
import { createTempSchema } from '../records/db.testutil.js';
import { latestScenePlan } from './sceneStage.js';
import { enqueueRevision } from './pipeline.js';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { registerRevisionRoutes } from '../records/revision.js';
import { createHarness, recordExclusion, seedConfirmedBriefing, type SeedItem } from './pipeline-harness.js';

const url = process.env.DATABASE_URL;
const TEXTS: SeedItem[] = [
  { text: '아침에 카페에서 에코 서버 버그를 고쳤다.', emphasis: true },
  { text: '값을 따로 넘기면 안전하다는 걸 배웠다.' },
  { text: '저녁에는 천천히 걸으며 하루를 정리했다.' },
];

/** ffmpeg -i 출력에서 해상도·길이를 읽는다(이 이미지에 ffprobe 가 없는 환경에서도 동작). */
const mediaInfo = (file: string) => {
  let err = '';
  try { execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? ''); }
  const size = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(err);
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(err);
  return { w: Number(size?.[1]), h: Number(size?.[2]), sec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : NaN, h264: /Video: h264/.test(err), aac: /Audio: aac/.test(err) };
};

describe.skipIf(!url)('확정 브리핑 → 제작 파이프라인 (실제 PostgreSQL·모의 제공자)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>, pool: pg.Pool, dir: string;
  const fetchGuard = vi.fn(() => { throw new Error('실제 네트워크 호출 금지(모의 제공자만)'); });
  beforeAll(() => { vi.stubGlobal('fetch', fetchGuard); });
  afterAll(() => { vi.unstubAllGlobals(); });
  // 시험마다 새 스키마: 예산 원장의 멱등키(같은 장면·같은 포즈)가 다른 시험의 항목과 겹치지 않게 한다.
  beforeEach(async () => { t = await createTempSchema(url!); pool = t.pool(); dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-')); });
  afterEach(async () => { await pool.end(); await t.drop(); rmSync(dir, { recursive: true, force: true }); });

  const ledgerRows = async () => (await pool.query("SELECT provider, operation, state, idempotency_key FROM budget_entries ORDER BY created_at, id")).rows;

  it('AC-1/AC-5: 확정 브리핑이 5단계를 거쳐 COMPLETED 와 9:16 MP4 까지 가고, 모든 유료 호출이 원장을 거친다', async () => {
    const h = createHarness({ pool, dir });
    const s = await seedConfirmedBriefing(h, pool, TEXTS, { withPhoto: true });
    const before = (await ledgerRows()).length;
    await h.drain();
    const job = (await h.queue.get(s.jobId))!;
    expect(job).toMatchObject({ state: 'SUCCEEDED', stages: VIDEO_JOB_STAGES, qualityRegenerationsUsed: 0, autoRetriesUsed: 0 });
    expect((await h.queue.stages(s.jobId)).map((x) => [x.stage, x.state]).sort()).toEqual(VIDEO_JOB_STAGES.map((x) => [x, 'DONE']).sort());
    const snap = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    expect(snap.pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });
    const result = snap.versions.filter((v) => v.kind === 'RESULT');
    expect(result).toHaveLength(1);
    const file = path.join(dir, 'videos', (result[0]!.content as { file: string }).file);
    expect(statSync(file).size).toBeGreaterThan(1000);
    const info = mediaInfo(file);
    expect(info).toMatchObject({ w: 720, h: 1280, h264: true, aac: true });
    expect(info.sec).toBeGreaterThan(1);
    expect(info.sec).toBeLessThanOrEqual(180);
    // 다운로드 허용 판정(records/view.ts)과 같은 상태 규칙: COMPLETED.
    const { displayStatus } = await import('../records/view.js');
    expect(displayStatus(snap.interview.status, snap.pipeline, true)).toBe('COMPLETED');
    // AC-5: 모의 호출 수 = 원장 항목 수(Pro 구독 경로 제외), 실제 fetch 0.
    const rows = (await ledgerRows()).slice(before);
    expect(rows.filter((r) => r.operation === 'tts')).toHaveLength(h.calls.tts.length);
    expect(rows.filter((r) => r.operation.startsWith('image:'))).toHaveLength(h.calls.image);
    expect(rows.every((r) => r.state === 'CONFIRMED')).toBe(true);
    expect(h.calls.tts).toHaveLength(3);
    expect(h.calls.image).toBeGreaterThanOrEqual(2); // 배경(사진 장면) + 캐릭터 포즈
    expect(fetchGuard).not.toHaveBeenCalled();
  }, 120_000);

  it('AC-2(내용 제외): 제외 요청은 장면 계획부터 다시 돌아 새 RESULT 버전을 만들고 제외 문장이 장면·내레이션·자막에서 빠진다', async () => {
    const h = createHarness({ pool, dir });
    const s = await seedConfirmedBriefing(h, pool, TEXTS);
    await h.drain();
    const snap1 = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    const excluded = s.texts[2]!.text;
    const plan1 = latestScenePlan(snap1)!;
    expect(plan1.plan.scenes.map((x) => x.narration)).toContain(excluded);
    const r1 = snap1.versions.filter((v) => v.kind === 'RESULT');
    const inferBefore = h.calls.infer, ttsBefore = h.calls.tts.length;
    const sub1 = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'work/interviews', s.interviewId, 'narration.json'), 'utf8')).subtitles.map((c: { text: string }) => c.text).join(' ');
    expect(sub1.replace(/\s+/g, '')).toContain(excluded.replace(/\s+/g, '').slice(0, 8));
    // TASK-28 의 /revisions 가 하는 기록 쪽 일: 항목을 뺀 새 브리핑·제작 계획 저장 → 큐 진입 함수 호출.
    await recordExclusion(h, s.owner, s.interviewId, s.texts, 2);
    const job2 = await enqueueRevision(h.queue, pool, { interviewId: s.interviewId, kind: 'EXCLUDE', revisionId: 'cmd-1' });
    const dup = await enqueueRevision(h.queue, pool, { interviewId: s.interviewId, kind: 'EXCLUDE', revisionId: 'cmd-1' });
    expect(dup.id).toBe(job2.id); // 같은 명령은 중복 작업을 만들지 않는다
    await h.drain();
    expect((await h.queue.get(job2.id))!).toMatchObject({ state: 'SUCCEEDED' });
    const snap2 = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    const r2 = snap2.versions.filter((v) => v.kind === 'RESULT');
    expect(r2).toHaveLength(r1.length + 1);
    expect((r2.at(-1)!.content as { file: string }).file).not.toBe((r1[0]!.content as { file: string }).file);
    const plan2 = latestScenePlan(snap2)!;
    expect(plan2.plan.scenes.map((x) => x.narration)).not.toContain(excluded);
    expect(plan2.plan.scenes).toHaveLength(2);
    const nar2 = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'work/interviews', s.interviewId, 'narration.json'), 'utf8'));
    expect(nar2.segments).toHaveLength(2);
    expect(nar2.subtitles.map((c: { text: string }) => c.text).join('').replace(/\s+/g, '')).not.toContain(excluded.replace(/\s+/g, '').slice(0, 8));
    // 재실행 범위 기록: 브리핑 버전이 바뀌었으므로 장면 계획(Pro 1회)부터 새로 돌고, 음성은 남은 2장면만 새로 합성한다(제외 문장은 TTS 로 나가지 않음).
    expect(h.calls.infer).toBe(inferBefore + 1);
    expect(h.calls.tts.length).toBe(ttsBefore + 2);
    expect(h.calls.tts.slice(ttsBefore).some((c) => c.text.includes(excluded))).toBe(false);
    const res = Object.fromEntries((await h.queue.stages(job2.id)).map((x) => [x.stage, x.result]));
    expect(res.scene_plan.reused).toBe(false);
    expect(res.narration.reused).toBe(false);
    expect((snap2.pipeline)).toMatchObject({ production: 'DONE', review: 'PASSED' });
  }, 180_000);

  it('AC-2(라우트 연결): POST /revisions 의 제외 요청이 실제 재제작 작업을 만들어 새 RESULT 버전을 만들고, 제외 문장이 장면·내레이션·자막에서 빠지며 같은 commandId 는 1회만 실행된다', async () => {
    const SECRET = 'unit-test-session-secret-0123456789';
    const h = createHarness({ pool, dir });
    const s = await seedConfirmedBriefing(h, pool, TEXTS);
    await h.drain();
    const snap1 = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    const excluded = s.texts[2]!.text;
    expect(latestScenePlan(snap1)!.plan.scenes.map((x) => x.narration)).toContain(excluded);
    const r1 = snap1.versions.filter((v) => v.kind === 'RESULT');
    const inferBefore = h.calls.infer, ttsBefore = h.calls.tts.length;

    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    const app = buildApp({ auth, sessionSecret: SECRET, fileStorageDir: dir, records: h.records });
    registerRevisionRoutes(app, { store: h.records });
    try {
      const iat = Math.floor(Date.now() / 1000);
      const cookie = `dl_session=${sign({ sub: s.owner, email: 'a@example.test', iat, exp: iat + 3600 }, SECRET, 'session')}`;
      const post = () => app.inject({ method: 'POST', url: `/api/records/${s.interviewId}/revisions`, headers: { cookie }, payload: { type: 'EXCLUDE', commandId: 'route-cmd-1', itemId: 's3' } });
      const res = await post();
      expect(res.statusCode).toBe(200);
      const body = res.json() as { executed: boolean; jobId: string; duplicate: boolean; previousVersionKept: number | null };
      expect(body).toMatchObject({ executed: true, duplicate: false, previousVersionKept: r1.at(-1)!.version });
      const dup = (await post()).json() as { jobId: string; duplicate: boolean };
      expect(dup).toMatchObject({ jobId: body.jobId, duplicate: true });
      // 제작 대기 중에는 이전 결과가 정상 완성본으로 보이지 않는다.
      const mid = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
      expect(mid.pipeline).toMatchObject({ production: 'QUEUED', review: 'NONE' });

      await h.drain();
      expect((await h.queue.get(body.jobId))!).toMatchObject({ state: 'SUCCEEDED' });
      expect(await pool.query("SELECT 1 FROM jobs WHERE kind = 'VIDEO_PRODUCTION' AND idempotency_key LIKE 'revise:%'")).toHaveProperty('rowCount', 1);
      const snap2 = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
      const r2 = snap2.versions.filter((v) => v.kind === 'RESULT');
      expect(r2).toHaveLength(r1.length + 1);
      expect((r2.at(-1)!.content as { file: string }).file).not.toBe((r1[0]!.content as { file: string }).file);
      expect(latestScenePlan(snap2)!.plan.scenes.map((x) => x.narration)).not.toContain(excluded);
      const nar = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'work/interviews', s.interviewId, 'narration.json'), 'utf8'));
      expect(nar.segments).toHaveLength(2);
      expect(nar.subtitles.map((c: { text: string }) => c.text).join('').replace(/\s+/g, '')).not.toContain(excluded.replace(/\s+/g, '').slice(0, 8));
      expect(h.calls.infer).toBe(inferBefore + 1);
      expect(h.calls.tts.length).toBe(ttsBefore + 2);
      expect(snap2.pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });
    } finally {
      await app.close();
    }
  }, 180_000);

  it('AC-2(음성 수정): 내레이션부터 다시 합성하고 장면 계획·자산은 재사용하며 새 RESULT 버전을 만든다', async () => {
    const h = createHarness({ pool, dir });
    const s = await seedConfirmedBriefing(h, pool, TEXTS, { withPhoto: true });
    await h.drain();
    const imagesBefore = h.calls.image, inferBefore = h.calls.infer, ttsBefore = h.calls.tts.length;
    h.setVoice({ version: 'mock-2', provider: 'mock', voiceName: 'Puck', styleInstruction: '밝은 말투.' });
    const j = await enqueueRevision(h.queue, pool, { interviewId: s.interviewId, kind: 'VOICE', revisionId: 'voice-1' });
    await h.drain();
    expect((await h.queue.get(j.id))!.state).toBe('SUCCEEDED');
    expect(h.calls.infer).toBe(inferBefore);
    expect(h.calls.image).toBe(imagesBefore);
    expect(h.calls.tts.length).toBe(ttsBefore + 3);
    expect(new Set(h.calls.tts.slice(ttsBefore).map((c) => c.voice))).toEqual(new Set(['Puck']));
    const res = Object.fromEntries((await h.queue.stages(j.id)).map((x) => [x.stage, x.result]));
    expect(res.scene_plan.reused).toBe(true);
    expect(res.assets.reused).toBe(true);
    expect(res.narration.reused).toBe(false);
    const snap = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    expect(snap.versions.filter((v) => v.kind === 'RESULT')).toHaveLength(2);
  }, 180_000);

  it('AC-4: 검수가 계속 실패하면 자동 재제작은 정확히 1회, 이후 사유와 함께 FAILED, 처리 재시도 횟수와 별도다', async () => {
    // 첫 렌더 오버레이 일시 오류 1회(처리 오류 자동 재시도 소모) + 사실 검수 항상 실패(품질 재제작 소모)
    const h = createHarness({ pool, dir, factsPass: () => false, overlayFault: (n) => (n === 1 ? new Error('ECONNRESET') : null) });
    const s = await seedConfirmedBriefing(h, pool, TEXTS);
    await h.drain();
    const job = (await h.queue.get(s.jobId))!;
    expect(job).toMatchObject({ state: 'FAILED', qualityRegenerationsUsed: 1, qualityReasons: ['QUALITY_EXHAUSTED'], errorCode: 'QUALITY_REJECTED' });
    expect(job.autoRetriesUsed).toBe(1); // 처리 오류 재시도 1회는 품질 재제작 횟수와 따로 센다
    const reviews = (await pool.query('SELECT generation, report FROM job_quality_reviews WHERE job_id=$1 ORDER BY id', [s.jobId])).rows;
    expect(reviews.map((r) => r.generation)).toEqual([0, 1]);
    expect(JSON.stringify(reviews[1].report.checks.filter((c: { passed: boolean }) => !c.passed).map((c: { code: string }) => c.code))).toContain('FACTS');
    const snap = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    expect(snap.pipeline.review).toBe('REJECTED');
    expect(snap.versions.filter((v) => v.kind === 'RESULT')).toHaveLength(0); // 반려된 영상은 결과 버전이 되지 않는다
    // 재제작 회차의 유료 호출은 RETRY 로 원장에 구분된다.
    const purposes = (await pool.query("SELECT purpose, count(*)::int AS n FROM budget_entries GROUP BY purpose")).rows;
    expect(purposes.find((p) => p.purpose === 'RETRY')?.n).toBeGreaterThan(0);
  }, 180_000);

  it('AC-5: 예산이 부족하면 외부 호출 없이 예산 대기(WAITING_BUDGET)가 되고 재시도 횟수를 쓰지 않는다', async () => {
    const h = createHarness({ pool, dir, ledgerLimitKrw: 1 });
    const s = await seedConfirmedBriefing(h, pool, TEXTS);
    await h.drain();
    expect(await h.queue.get(s.jobId)).toMatchObject({ state: 'WAITING', waitReason: 'BUDGET', autoRetriesUsed: 0, errorCode: 'BUDGET_EXCEEDED' });
    expect(h.calls.tts).toHaveLength(0);
    expect(h.calls.image).toBe(0);
    const snap = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    expect(snap.pipeline.production).toBe('WAITING_BUDGET');
    expect(fetchGuard).not.toHaveBeenCalled();
  }, 60_000);
});
