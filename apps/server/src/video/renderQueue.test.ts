import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue, type StageHandler } from '../jobs/queue.js';
import { RenderGate } from './renderGate.js';

const url = process.env.DATABASE_URL;

/** 실제 PostgreSQL 임시 스키마가 필요하다(DATABASE_URL 없으면 건너뜀). */
describe.skipIf(!url)('렌더 단계와 작업 큐 (실제 PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  beforeAll(async () => { t = await createTempSchema(url!); pool = t.pool(); });
  afterAll(async () => { await pool.end(); await t.drop(); });

  const mk = (kind: string, handler: StageHandler, leaseMs: number) =>
    new JobQueue({ pool, ledger: new MonthlyLedger(pool, { clock: () => new Date('2032-03-15T12:00:00+09:00') }), handlers: { [kind]: { render: handler } }, leaseMs });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('임대(300ms)보다 긴 렌더(1.5초)도 heartbeat 로 임대를 연장하면 recover 가 가로채지 않아 한 번만 실행된다', async () => {
    let runs = 0;
    const handler: StageHandler = {
      async execute(ctx) {
        runs++;
        for (let i = 0; i < 15; i++) { await sleep(100); await ctx.heartbeat(); }
        return { result: { ok: true } };
      },
    };
    const q = mk('lease-on', handler, 300);
    const j = await q.enqueue({ kind: 'lease-on', subjectId: 'iv', stages: ['render'], idempotencyKey: 'lease-on-1' });
    const worker = q.tick();
    // 다른 워커가 시작 시 recover()·tick() 을 반복한다.
    const other = mk('lease-on', handler, 300);
    let recovered = 0;
    for (let i = 0; i < 12; i++) { await sleep(120); recovered += await other.recover(); await other.tick(); }
    await worker;
    expect(recovered).toBe(0);
    expect(runs).toBe(1);
    expect((await q.get(j.id))!.state).toBe('SUCCEEDED');
  }, 30_000);

  it('대조: heartbeat 없이 임대보다 오래 걸리면 recover 가 이어받아 중복 실행된다(문제 재현)', async () => {
    let runs = 0;
    const handler: StageHandler = { async execute() { runs++; await sleep(900); return { result: 1 }; } };
    const q = mk('lease-off', handler, 200);
    await q.enqueue({ kind: 'lease-off', subjectId: 'iv', stages: ['render'], idempotencyKey: 'lease-off-1' });
    const worker = q.tick();
    const other = mk('lease-off', handler, 200);
    let recovered = 0;
    for (let i = 0; i < 6; i++) { await sleep(150); recovered += await other.recover(); await other.tick(); }
    await worker;
    expect(recovered).toBeGreaterThan(0);
    expect(runs).toBeGreaterThan(1);
  }, 30_000);

  it('AC-2 advisory lock: 서로 다른 RenderGate(=다른 프로세스 대용)도 한 번에 하나만 실행한다', async () => {
    const gates = [new RenderGate(pool), new RenderGate(pool), new RenderGate(pool)];
    let running = 0, peak = 0;
    await Promise.all(gates.map((g) => g.run(async () => { running++; peak = Math.max(peak, running); await sleep(120); running--; })));
    expect(peak).toBe(1);
  }, 30_000);
});
