import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { RecordStore } from '../records/store.js';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue, QualityRejectedError, type StageHandler } from '../jobs/queue.js';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('품질 재제작 실제 PostgreSQL 큐', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>, pool: pg.Pool;
  beforeAll(async () => { t = await createTempSchema(url!); pool = t.pool(); });
  afterAll(async () => { await pool.end(); await t.drop(); });
  const ledger = () => new MonthlyLedger(pool, { clock: () => new Date('2035-06-01T00:00:00Z') });
  const mk = (handlers: Record<string, StageHandler>) => new JobQueue({ pool, ledger: ledger(), handlers: { video: handlers } });
  const reject = (allowed = true) => new QualityRejectedError({ passed: false, file: 'old.mp4', checks: [{ component: 'subtitles', passed: false, code: 'POLITICS', evidence: 'hash-only' }] }, ['captions', 'render', 'quality'], allowed);
  it('AC-2/3/4: 재시작·복합 오류에도 품질 1회와 처리 오류 1회를 따로 보존한다', async () => {
    let captions = 0, stable = 0;
    const handlers = {
      image: { execute: async () => { stable++; return { result: 'keep-image' }; } },
      captions: { execute: async () => { captions++; if (captions === 2) throw new Error('temporary'); return { result: `captions-${captions}` }; } },
      render: { execute: async () => ({ result: { file: `v${captions}.mp4` } }) },
      quality: { execute: async () => { throw reject(); } },
    };
    let q = mk(handlers);
    const j = await q.enqueue({ kind: 'video', subjectId: 'fixture', stages: Object.keys(handlers), idempotencyKey: 'quality-mixed' });
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'QUEUED', qualityRegenerationsUsed: 1, autoRetriesUsed: 0 });
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'QUEUED', qualityRegenerationsUsed: 1, autoRetriesUsed: 1 });
    q = mk(handlers); // 新 인스턴스는 DB 카운터를 다시 읽음
    await q.tick(); await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'FAILED', qualityRegenerationsUsed: 1, autoRetriesUsed: 1, qualityReasons: ['QUALITY_EXHAUSTED'] });
    expect(stable).toBe(1); expect(captions).toBe(3);
    const history = (await pool.query('SELECT * FROM job_quality_reviews WHERE job_id=$1 ORDER BY id', [j.id])).rows;
    expect(history).toHaveLength(2);
    expect(history[0].prior_results.render).toEqual({ file: 'v1.mp4' });
    expect(history[0].report.checks[0].code).toBe('POLITICS');
  });
  it('권한 대기는 재제작 횟수를 쓰지 않고 해제 후 같은 작업에서 1회만 실행한다', async () => {
    let allowed = false;
    const h = { captions: { execute: async () => ({ result: 1 }) }, render: { execute: async () => ({ result: 2 }) }, quality: { execute: async () => { throw reject(allowed); } } };
    const q = mk(h); const j = await q.enqueue({ kind: 'video', subjectId: 'fixture', stages: Object.keys(h), idempotencyKey: 'quality-permission' });
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'WAITING', waitReason: 'PERMISSION', qualityRegenerationsUsed: 0 });
    allowed = true;
    await q.requestManualRetry(j.id, { commandId: 'allow-quality', actor: 'fixture-user' });
    await q.tick(); await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'FAILED', qualityRegenerationsUsed: 1 });
  });
  it('D25-04: 재제작 소진과 예산 부족을 동시에 보존하며 유료 호출을 보내지 않는다', async () => {
    const h = { captions: { paid: { provider: 'mock', operation: 'captions', estimateKrw: 30_000 }, execute: async () => ({ result: 1, actualKrw: 30_000 }) }, render: { execute: async () => ({ result: 2 }) }, quality: { execute: async () => { throw reject(); } } };
    const id = randomUUID();
    await pool.query("INSERT INTO interviews(id,owner_id,life_date,started_at,status) VALUES($1,'fixture','2030-02-01',now(),'CONFIRMED')", [id]);
    await pool.query('INSERT INTO pipeline_states(interview_id,updated_at) VALUES($1,now())', [id]);
    const q = mk(h); const j = await q.enqueue({ kind: 'video', subjectId: id, stages: Object.keys(h), idempotencyKey: 'quality-both' });
    await pool.query('UPDATE jobs SET quality_regenerations_used=1 WHERE id=$1', [j.id]);
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'FAILED', qualityReasons: ['QUALITY_EXHAUSTED', 'BUDGET'] });
    expect((await q.stages(j.id)).find(s => s.stage === 'captions')!.attempts).toBe(1);
    const records = new RecordStore(pool);
    expect((await records.loadById('fixture', id, new Date()))!.pipeline.qualityReasons).toEqual(['QUALITY_EXHAUSTED', 'BUDGET']);
    expect((await records.listRecords('fixture', { limit: 50 })).rows[0]!.pipeline.qualityReasons).toEqual(['QUALITY_EXHAUSTED', 'BUDGET']);
  });
  it('예산 부족 대기는 필요한 재제작 전체 비용이 확보되기 전에는 깨우지 않는다', async () => {
    const l = new MonthlyLedger(pool, { clock: () => new Date('2036-01-01T00:00:00Z') });
    const h = { captions: { paid: { provider: 'mock', operation: 'caption', estimateKrw: 30_000 }, execute: async () => ({ result: 1, actualKrw: 30_000 }) }, render: { execute: async () => ({ result: 2 }) }, quality: { execute: async () => { throw reject(); } } };
    const q = new JobQueue({ pool, ledger: l, handlers: { video: h } });
    const j = await q.enqueue({ kind: 'video', subjectId: 'fixture', stages: Object.keys(h), idempotencyKey: 'quality-budget-wait' });
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'WAITING', waitReason: 'BUDGET', qualityRegenerationsUsed: 0 });
    expect(await q.wakeWaiting()).toBe(0);
    expect(await q.tick()).toBeNull();
  });

  it('대기 후 같은 결과를 재검수하여 통과하면 이전 대기 사유를 제거한다', async () => {
    let passed = false;
    const h = { captions: { execute: async () => ({ result: 1 }) }, render: { execute: async () => ({ result: 2 }) }, quality: { execute: async () => { if (!passed) throw reject(false); return { result: { passed: true } }; } } };
    const q = mk(h); const j = await q.enqueue({ kind: 'video', subjectId: 'fixture', stages: Object.keys(h), idempotencyKey: 'quality-clear' });
    await q.tick();
    passed = true;
    await q.requestManualRetry(j.id, { commandId: 'quality-recheck', actor: 'fixture-user' });
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'SUCCEEDED', qualityReasons: [], qualityRegenerationsUsed: 0 });
  });

});
