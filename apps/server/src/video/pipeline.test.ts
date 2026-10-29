import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_JOB_STAGES } from '../briefing/briefing.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue } from '../jobs/queue.js';
import { createTempSchema } from '../records/db.testutil.js';
import { displayStatus } from '../records/view.js';
import { createHarness, reviseBriefing, sampleItems, seedConfirmed, type Harness } from './pipeline-harness.js';
import { RecordStore } from '../records/store.js';
import { requestRemake, syncPipelineState, VIDEO_STAGES, videoHandlers } from './pipeline.js';
import { probeVideo } from './render.js';

const url = process.env.DATABASE_URL;
const owners = new Map<string, string>();
let seq = 0;

describe.skipIf(!url)('TASK-117 영상 제작 파이프라인 연결 (실제 PostgreSQL·모의 제공자)', { timeout: 180_000 }, () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>, pool: pg.Pool, root: string, assetsDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    t = await createTempSchema(url!); pool = t.pool();
    root = mkdtempSync(path.join(os.tmpdir(), 'pipeline117-'));
    assetsDir = path.join(root, 'assets-shared');
    fetchSpy = vi.spyOn(globalThis, 'fetch'); // 실제 네트워크 호출이 있으면 기록된다
  });
  afterAll(async () => { fetchSpy.mockRestore(); await pool.end(); await t.drop(); rmSync(root, { recursive: true, force: true }); });

  /** 시험마다 다른 소유자로 확정 기록을 만든다(같은 날짜 기록 충돌 방지). */
  const seed = async (h: Harness, texts: string[]) => {
    const owner = `owner-117-${++seq}`;
    const r = await seedConfirmed(h.store, owner, sampleItems(texts));
    owners.set(r.interviewId, owner);
    return { ...r, owner };
  };
  const queueOf = (h: Harness) => new JobQueue({ pool, ledger: h.ledger, handlers: videoHandlers(h.deps), leaseMs: 60_000 });
  /** worker.ts 의 처리 루프와 같은 순서: tick → 상태 반영. */
  const drain = async (q: JobQueue) => { for (let n = 0; n < 40; n++) { await q.wakeWaiting(); const j = await q.tick(); if (!j) return; await syncPipelineState(pool, j); } throw new Error('too many ticks'); };
  const snap = async (id: string) => (await new RecordStore(pool).loadById(owners.get(id)!, id, new Date()))!;
  const results = async (id: string) => (await snap(id)).versions.filter((v) => v.kind === 'RESULT');
  const ledgerRows = async () => (await pool.query("SELECT idempotency_key, state, operation FROM budget_entries WHERE idempotency_key IS NOT NULL")).rows as { idempotency_key: string; state: string; operation: string }[];
  const providerLines = (h: Harness) => (existsSync(h.providerCallsLog) ? readFileSync(h.providerCallsLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  it('작업 종류의 단계 목록은 확정 경로(VIDEO_JOB_STAGES)와 같다', () => {
    expect([...VIDEO_STAGES]).toEqual(VIDEO_JOB_STAGES);
    expect(Object.keys(videoHandlers(createHarness({ pool, dir: path.join(root, 'shape') }).deps).VIDEO_PRODUCTION!)).toEqual(VIDEO_JOB_STAGES);
  });

  describe('AC-1/AC-2/AC-5: 확정 → COMPLETED·MP4, 제외·음성 수정 재제작', () => {
    let h: Harness, q: JobQueue, interviewId: string, firstJobId: string;
    const TEXTS = ['아침에 에코 버그를 고쳤다', '점심은 김밥을 먹었다', '저녁에 친구와 통화했다'];

    it('AC-1: 확정된 브리핑이 5개 단계를 거쳐 COMPLETED 결과와 9:16 MP4 까지 도달한다', async () => {
      h = createHarness({ pool, dir: path.join(root, 'main'), assetsDir });
      q = queueOf(h);
      const seeded = await seed(h, TEXTS);
      interviewId = seeded.interviewId; firstJobId = seeded.jobId;
      await drain(q);

      const job = (await q.get(firstJobId))!;
      expect(job).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0, qualityRegenerationsUsed: 0 });
      expect((await q.stages(firstJobId)).map((s) => [s.stage, s.state]).sort()).toEqual([...VIDEO_STAGES].map((s) => [s, 'DONE']).sort());
      const s = await snap(interviewId);
      expect(s.pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });
      expect(displayStatus(s.interview.status, s.pipeline, true)).toBe('COMPLETED');
      const [res] = await results(interviewId);
      const file = (res!.content as { file: string }).file;
      const probe = await probeVideo(path.join(h.videoDir, file));
      const v = probe.streams.find((x) => x.codec_type === 'video')!;
      expect(v.width! * 16).toBe(v.height! * 9);
      expect(Number(probe.format.duration)).toBeGreaterThan(0);
      expect(Number(probe.format.duration)).toBeLessThanOrEqual(180);
      expect(probe.streams.map((x) => x.codec_type).sort()).toEqual(['audio', 'video']);
    });

    it('AC-5: 모든 유료 호출이 원장을 거치고 실제 네트워크 호출이 없다', async () => {
      const rows = await ledgerRows();
      const lines = providerLines(h);
      // 제공자 청구 기록 == 원장 확정 항목 (TTS 3 + 이미지 포즈 1(모든 장면이 같은 포즈) + STT 3)
      expect(lines.filter((l) => l.startsWith('TTS'))).toHaveLength(3);
      expect(lines.filter((l) => l.startsWith('IMAGE'))).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('STT'))).toHaveLength(3);
      expect(rows.filter((r) => r.state === 'CONFIRMED')).toHaveLength(lines.length);
      expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(rows.length);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('AC-2(제외): 제외 요청 후 scenePlan 부터 다시 만들면 새 RESULT 버전이 생기고 제외 항목이 장면·내레이션·자막·전사에서 빠진다', async () => {
      const excluded = TEXTS[1]!;
      const before = (await q.stages(firstJobId)).find((x) => x.stage === 'narration')!.result as { subtitles: { text: string }[]; segments: unknown[] };
      expect(before.subtitles.map((c) => c.text).join(' ')).toContain('김밥');
      const ttsBefore = h.calls.tts.length;

      const items = sampleItems(TEXTS).map((i) => (i.text === excluded ? { ...i, inVideo: false, excludedReason: 'USER' as const } : i));
      await reviseBriefing(h.store, owners.get(interviewId)!, interviewId, items, 2);
      const busy = await requestRemake(pool, { interviewId, fromStage: 'scenePlan', commandId: 'cmd-exclude' });
      expect(busy).toMatchObject({ ok: true, duplicate: false, reusedStages: [], restartedStages: [...VIDEO_STAGES] });
      expect(await requestRemake(pool, { interviewId, fromStage: 'scenePlan', commandId: 'cmd-exclude' })).toMatchObject({ ok: true, duplicate: true });
      expect(await requestRemake(pool, { interviewId, fromStage: 'scenePlan', commandId: 'cmd-other' })).toMatchObject({ ok: false, code: 'BUSY' });
      await drain(q);

      const jobId = (busy as { jobId: string }).jobId;
      expect(await q.get(jobId)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0, qualityRegenerationsUsed: 0 });
      const rs = await results(interviewId);
      expect(rs.map((r) => r.version)).toEqual([1, 2]);
      expect((rs[1]!.content as { file: string }).file).not.toBe((rs[0]!.content as { file: string }).file);
      expect(existsSync(path.join(h.videoDir, (rs[0]!.content as { file: string }).file))).toBe(true); // 이전 결과 파일 보존
      const stages = await q.stages(jobId);
      const nar = stages.find((x) => x.stage === 'narration')!.result as { subtitles: { text: string }[]; segments: { sceneKey: string }[] };
      const plan = (stages.find((x) => x.stage === 'scenePlan')!.result as { scenes: number });
      expect(plan.scenes).toBe(2);
      expect(nar.segments).toHaveLength(2);
      expect(nar.subtitles.map((c) => c.text).join(' ')).not.toContain('김밥');
      // 새로 합성한 내레이션에 제외 문장이 없다. 남은 두 장면은 문장이 같아 음성 캐시를 재사용했으므로 새 TTS 호출은 0.
      expect(h.calls.tts.slice(ttsBefore).join(' ')).not.toContain('김밥');
      expect(h.calls.tts).toHaveLength(ttsBefore);
      const sp = (await snap(interviewId)).versions.filter((v) => v.kind === 'PRODUCTION_PLAN' && (v.content as { kind?: string }).kind === 'SCENE_PLAN');
      expect(JSON.stringify(sp.at(-1)!.content)).not.toContain('김밥');
      expect(JSON.stringify(sp[0]!.content)).toContain('김밥');
      expect(displayStatus((await snap(interviewId)).interview.status, (await snap(interviewId)).pipeline, true)).toBe('COMPLETED');
    });

    it('AC-2(음성 수정): 음성 설정을 바꿔 narration 부터 다시 만들면 장면 계획은 재사용하고 새 RESULT 버전이 생긴다', async () => {
      const h2 = createHarness({ pool, dir: path.join(root, 'main'), assetsDir, voice: { styleInstruction: '조금 더 천천히 읽는다' } });
      const q2 = queueOf(h2);
      const r = await requestRemake(pool, { interviewId, fromStage: 'narration', commandId: 'cmd-voice' });
      expect(r).toMatchObject({ ok: true, reusedStages: ['scenePlan'], restartedStages: ['narration', 'sceneAssets', 'render', 'quality'] });
      const jobId = (r as { jobId: string }).jobId;
      const proBefore = h2.calls.pro;
      await drain(q2);
      expect(await q2.get(jobId)).toMatchObject({ state: 'SUCCEEDED' });
      expect(h2.calls.pro).toBe(proBefore); // 장면 계획(Pro)은 다시 부르지 않음
      expect(h2.calls.tts).toHaveLength(2); // 읽기 지시가 달라 새로 합성
      expect(h2.calls.image).toBe(0); // 같은 포즈 자산 재사용
      expect((await results(interviewId)).map((x) => x.version)).toEqual([1, 2, 3]);
      const ev = await q2.events(jobId);
      expect(ev.find((e) => e.event === 'REMAKE_REQUESTED')).toMatchObject({ stage: 'narration', code: 'reused=scenePlan' });
    });
  });

  describe('AC-4: 품질 검수 실패 → 자동 재제작 정확히 1회', () => {
    it('계속 실패하면 재제작 1회 후 FAILED(QUALITY_EXHAUSTED)와 사유가 남고, 처리 재시도 횟수와 별도로 유지된다', async () => {
      // 첫 Pro 호출이 대기 상태 → 처리 오류 자동 재시도 1회. 이후 음성 인식 결과가 항상 대본과 달라 검수가 계속 실패한다.
      const h = createHarness({ pool, assetsDir, dir: path.join(root, 'quality'), proWaitFirst: true, sttText: () => '전혀 다른 말' });
      const q = queueOf(h);
      const { interviewId, jobId } = await seed(h, ['오늘은 산책을 했다']);
      await drain(q);
      const job = (await q.get(jobId))!;
      expect(job).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1, qualityRegenerationsUsed: 1, errorCode: 'QUALITY_REJECTED' });
      expect(job.qualityReasons).toContain('QUALITY_EXHAUSTED');
      const reviews = (await pool.query('SELECT generation, report FROM job_quality_reviews WHERE job_id=$1 ORDER BY id', [jobId])).rows;
      expect(reviews.map((r) => r.generation)).toEqual([0, 1]); // 최초 + 재제작 1회, 그 이상은 없음
      expect(reviews[1].report.checks.some((c: { passed: boolean; code: string }) => !c.passed && c.code === 'TRANSCRIPT_MISMATCH')).toBe(true);
      expect((await q.events(jobId)).filter((e) => e.event === 'QUALITY_REGENERATE')).toHaveLength(1);
      expect(h.calls.pro).toBe(2); // 대기 1 + 성공 1(품질 재제작은 장면 계획을 다시 부르지 않음)
      expect(await results(interviewId)).toHaveLength(0); // 통과하지 못한 결과는 RESULT 가 되지 않는다
      const s = await snap(interviewId);
      expect(displayStatus(s.interview.status, s.pipeline, true)).toBe('REVIEW_REJECTED');
      expect(s.pipeline.qualityReasons).toContain('QUALITY_EXHAUSTED');
    });
  });

  describe('예산·응답 유실', () => {
    it('예산이 모자라면 제공자를 부르지 않고 BUDGET 대기, 예산이 생기면 이어서 완료한다', async () => {
      const clock = new Date('2035-07-01T00:00:00Z');
      const h = createHarness({ pool, assetsDir, dir: path.join(root, 'budget'), clock });
      const l = new MonthlyLedger(pool, { clock: () => clock });
      const hold = await l.reserve({ provider: 'x', operation: 'hold', purpose: 'TEST', estimateKrw: 49_995, idempotencyKey: 'hold-117' });
      expect(hold.ok).toBe(true);
      const q = queueOf(h);
      const { interviewId, jobId } = await seed(h, ['오늘은 책을 읽었다']);
      await drain(q);
      expect(await q.get(jobId)).toMatchObject({ state: 'WAITING', waitReason: 'BUDGET' });
      expect(providerLines(h)).toHaveLength(0);
      expect((await snap(interviewId)).pipeline.production).toBe('WAITING_BUDGET');
      if (hold.ok) await l.releaseUnsent(hold.id);
      await drain(q);
      expect(await q.get(jobId)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0 });
      expect((await snap(interviewId)).pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });
    });

    it('TTS 응답이 유실돼도(제공자는 처리 완료) 조회로 결과를 되찾아 재전송 없이 완료한다', async () => {
      let lostOnce = true;
      const h = createHarness({
        pool, assetsDir, dir: path.join(root, 'lost'), clock: new Date('2035-08-01T00:00:00Z'),
        afterProviderAccepted: async () => { if (lostOnce) { lostOnce = false; throw new Error('ECONNRESET'); } },
      });
      const q = queueOf(h);
      const { jobId } = await seed(h, ['오늘은 비가 왔다']);
      await drain(q);
      expect(await q.get(jobId)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0 });
      expect(providerLines(h).filter((l) => l.startsWith('TTS'))).toHaveLength(1); // 제공자 청구 1건
      const rows = (await pool.query("SELECT state FROM budget_entries WHERE idempotency_key LIKE 'narr:2026-10-28%'")).rows;
      expect(rows).toEqual([{ state: 'CONFIRMED' }]);
    });

    it('조회를 지원하지 않는 제공자의 응답 유실은 재전송하지 않고 확인 대기(EXTERNAL_RESULT_UNKNOWN)로 둔다', async () => {
      const h = createHarness({
        pool, assetsDir, dir: path.join(root, 'lost2'), clock: new Date('2035-09-01T00:00:00Z'), allowLookup: false,
        afterProviderAccepted: async () => { throw new Error('ECONNRESET'); },
      });
      const q = queueOf(h);
      const { jobId } = await seed(h, ['오늘은 바람이 불었다']);
      await drain(q);
      expect(await q.get(jobId)).toMatchObject({ state: 'WAITING', waitReason: 'EXTERNAL_RESULT_UNKNOWN' });
      expect(h.calls.tts).toHaveLength(1);
      await q.wakeWaiting(); await q.tick();
      expect(h.calls.tts).toHaveLength(1); // 다시 보내지 않음
      expect(randomUUID()).toBeTruthy();
    });
  });

  it('제공자가 설정되지 않은 작업기는 유료 호출 전에 VIDEO_PROVIDERS_UNAVAILABLE 로 멈춘다', async () => {
    const h = createHarness({ pool, assetsDir, dir: path.join(root, 'noprov'), clock: new Date('2035-10-01T00:00:00Z') });
    const q = new JobQueue({ pool, ledger: h.ledger, handlers: videoHandlers({ ...h.deps, stt: null }), leaseMs: 60_000 });
    const { jobId } = await seed(h, ['오늘은 쉬었다']);
    await drain(q);
    expect(await q.get(jobId)).toMatchObject({ state: 'FAILED', errorCode: 'VIDEO_PROVIDERS_UNAVAILABLE' });
    expect(providerLines(h)).toHaveLength(0);
  });
});
