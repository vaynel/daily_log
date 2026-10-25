import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue, NonRetryableError, PermissionDeniedError, type StageHandler } from './queue.js';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('작업 큐 (실제 PostgreSQL 임시 스키마)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let seq = 0;
  beforeAll(async () => { t = await createTempSchema(url!); pool = t.pool(); });
  afterAll(async () => { await pool.end(); await t.drop(); });

  /** 시험마다 다른 달·다른 종류로 격리. calls 는 단계별 execute 호출 횟수. */
  function setup(plan: Record<string, (n: number) => unknown>, paid: string[] = [], lookup?: StageHandler['lookup'], permissionRestored?: () => Promise<boolean>) {
    const n = ++seq; const month = `${2031 + Math.floor((n - 1) / 12)}-${String(((n - 1) % 12) + 1).padStart(2, "0")}`;
    const ledger = new MonthlyLedger(pool, { clock: () => new Date(`${month}-15T12:00:00+09:00`) });
    const kind = `k${seq}`;
    const calls: Record<string, number> = {};
    const handlers: Record<string, StageHandler> = {};
    for (const [stage, fn] of Object.entries(plan)) {
      handlers[stage] = {
        paid: paid.includes(stage) ? { provider: 'mock', operation: stage, estimateKrw: 100 } : undefined,
        lookup: paid.includes(stage) ? lookup : undefined,
        async execute() {
          const n = (calls[stage] = (calls[stage] ?? 0) + 1);
          return { result: await fn(n), actualKrw: 80 };
        },
      };
    }
    const mk = () => new JobQueue({ pool, ledger, handlers: { [kind]: handlers }, leaseMs: 60000, permissionRestored });
    return { q: mk(), mk, ledger, kind, calls, stages: Object.keys(plan) };
  }
  const job = (s: ReturnType<typeof setup>, key = `j${Math.random()}`) => s.q.enqueue({ kind: s.kind, subjectId: 'iv1', stages: s.stages, idempotencyKey: key });
  const drain = async (q: JobQueue) => { for (let i = 0; i < 10 && (await q.tick()); i++); };
  const boom = () => { throw new Error('ECONNRESET'); };

  it('AC-1 어느 단계든 일시 오류는 작업 전체에서 1회만 자동 재시도하고 완료 단계는 다시 실행하지 않는다', async () => {
    for (const failAt of ['a', 'b', 'c']) {
      const s = setup({ a: (n) => (failAt === 'a' && n === 1 ? boom() : 'A'), b: (n) => (failAt === 'b' && n === 1 ? boom() : 'B'), c: (n) => (failAt === 'c' && n === 1 ? boom() : 'C') });
      const j = await job(s);
      await drain(s.q);
      const after = await s.q.get(j.id);
      expect(after).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1 });
      const expected = { a: 1, b: 1, c: 1, [failAt]: 2 };
      expect(s.calls).toEqual(expected);
    }
    // 서로 다른 단계에서 두 번 실패해도 자동 재시도는 합쳐서 1회뿐: 총 실행 4번이 아니라 3번에서 FAILED.
    const s = setup({ a: (n) => (n === 1 ? boom() : 'A'), b: () => boom(), c: () => 'C' });
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1, errorCode: 'TRANSIENT_ERROR' });
    expect(s.calls).toEqual({ a: 2, b: 1 });
    expect(await s.q.tick()).toBeNull();
  });

  it('AC-1 재시도 불가 오류는 자동 재시도 없이 실패', async () => {
    const s = setup({ a: () => { throw new NonRetryableError('BAD_INPUT'); } });
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'FAILED', autoRetriesUsed: 0, errorCode: 'BAD_INPUT' });
    expect(s.calls).toEqual({ a: 1 });
  });

  it('AC-2 재시작 후에도 완료 단계와 사용한 재시도 횟수가 유지된다', async () => {
    const s = setup({ a: (n) => (n === 1 ? boom() : 'A'), b: () => 'B', c: () => 'C' });
    const j = await job(s);
    await s.q.tick(); // a 실패 → 자동 재시도 소진
    await s.q.tick(); // a 성공, b 성공, c 성공...
    // 서버가 b 진행 중 죽은 상황을 만든다: c 를 되돌려 RUNNING+임대 만료로 둔다.
    await pool.query(`UPDATE jobs SET state='RUNNING', lease_until=now() - interval '1 second' WHERE id=$1`, [j.id]);
    await pool.query(`UPDATE job_stages SET state='RUNNING', result=NULL WHERE job_id=$1 AND stage='c'`, [j.id]);
    const restarted = s.mk(); // 새 인스턴스 = 재시작
    expect(await restarted.recover()).toBe(1);
    const st = await restarted.stages(j.id);
    expect(st.filter((x) => x.state === 'DONE').map((x) => x.stage)).toEqual(['a', 'b']);
    expect(await restarted.get(j.id)).toMatchObject({ autoRetriesUsed: 1 });
    await drain(restarted);
    // 이미 1회를 썼으므로 중단된 단계를 다시 돌리지 않고 FAILED 로 남는다. a,b 는 재실행 없음.
    expect(await restarted.get(j.id)).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1, errorCode: 'INTERRUPTED' });
    expect(s.calls).toEqual({ a: 2, b: 1, c: 1 });
  });

  it('AC-2 재시도를 쓰지 않은 작업이 중단되면 남은 1회로 이어서 완료', async () => {
    const s = setup({ a: () => 'A', b: () => 'B' });
    const j = await job(s);
    await pool.query(`UPDATE jobs SET state='RUNNING', lease_until=now() - interval '1 second' WHERE id=$1`, [j.id]);
    await pool.query(`INSERT INTO job_stages (job_id, stage, state, attempts, result) VALUES ($1,'a','DONE',1,'"A"'::jsonb), ($1,'b','RUNNING',1,NULL)`, [j.id]);
    const r = s.mk();
    await r.recover();
    await drain(r);
    expect(await r.get(j.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1 });
    expect(s.calls).toEqual({ b: 1 }); // a 는 재실행하지 않음
  });

  it('AC-3 응답 유실: 조회 수단이 없으면 재전송하지 않고 확인 대기, 수동 재시도도 거부', async () => {
    const s = setup({ a: () => 'A', b: () => boom() }, ['b']);
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'WAITING', waitReason: 'EXTERNAL_RESULT_UNKNOWN', autoRetriesUsed: 0 });
    expect(await s.q.tick()).toBeNull();
    expect(s.calls.b).toBe(1);
    expect((await s.ledger.snapshot()).unknownKrw).toBe(100);
    expect(await s.q.requestManualRetry(j.id, { commandId: 'cmd-x', actor: 'owner' })).toEqual({ ok: false, code: 'UNRESOLVED_EXTERNAL' });
    expect(s.calls.b).toBe(1);
  });

  it('AC-3 요청 후 서버가 죽으면 재전송 없이 조회: 완료 확인 시 이어서 진행·확정', async () => {
    let looked: string | null = null;
    const s = setup({ a: () => 'A', b: () => new Promise(() => {}) }, ['b'], async (id) => {
      looked = id;
      return { status: 'COMPLETED', result: 'B', actualKrw: 90, evidence: 'provider-usage' };
    });
    const j = await job(s);
    void s.q.tick(); // b 가 응답 없이 매달린 채 프로세스가 죽는다
    for (let i = 0; i < 50 && !s.calls.b; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.calls.b).toBe(1);
    await pool.query(`UPDATE jobs SET lease_until=now() - interval '1 second' WHERE id=$1`, [j.id]);
    const r = s.mk();
    await r.recover();
    await drain(r);
    expect(s.calls.b).toBe(1); // 중복 요청 없음
    expect(looked).toBe(`${j.id}:b:1`);
    expect(await r.get(j.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0 });
    expect((await s.ledger.snapshot()).confirmedKrw).toBe(90);
  });

  it('AC-3 조회 결과 미처리면 환급 후 자동 재시도 1회로 새 요청 식별자 사용', async () => {
    const s = setup({ b: (n) => (n === 1 ? boom() : 'B') }, ['b'], async () => ({ status: 'NOT_FOUND', evidence: 'no-record' }));
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1 });
    expect(s.calls.b).toBe(2);
    const snap = await s.ledger.snapshot();
    expect(snap).toMatchObject({ unknownKrw: 0, confirmedKrw: 80 });
    expect(snap.byPurpose.RETRY).toBe(80); // 재시도는 같은 원장에 RETRY 로 기록
  });

  it('AC-3 조회 자체가 실패하면 확인 대기, 사람이 근거와 함께 정산하면 이어서 진행', async () => {
    const s = setup({ b: () => boom(), c: () => 'C' }, ['b'], async () => { throw new Error('lookup down'); });
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'WAITING', waitReason: 'EXTERNAL_RESULT_UNKNOWN' });
    await expect(s.q.resolveExternal(j.id, 'b', { charged: false, evidence: ' ' }, { commandId: 'c1', actor: 'owner' })).rejects.toThrow();
    expect(await s.q.resolveExternal(j.id, 'b', { charged: true, actualKrw: 70, result: 'B', evidence: 'dashboard' }, { commandId: 'c2', actor: 'owner' })).toBe(true);
    expect(await s.q.resolveExternal(j.id, 'b', { charged: false, evidence: 'x' }, { commandId: 'c2', actor: 'owner' })).toBe(false);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'SUCCEEDED' });
    expect(s.calls).toEqual({ b: 1, c: 1 });
    expect((await s.ledger.snapshot()).confirmedKrw).toBe(70);
  });

  it('AC-4 예산 부족은 재시도 대신 대기 사유를 남기고 호출하지 않으며, 여유가 생기면 재개', async () => {
    const s = setup({ a: (n) => (n === 1 ? boom() : 'A'), b: () => 'B' }, ['b']);
    const filler = await s.ledger.reserve({ provider: 'x', operation: 'x', purpose: 'TEST', estimateKrw: 49950 });
    if (!filler.ok) throw new Error('x');
    const j = await job(s);
    await drain(s.q); // a 일시 오류(자동 재시도 소진) → a 성공 → b 예산 부족
    expect(await s.q.get(j.id)).toMatchObject({ state: 'WAITING', waitReason: 'BUDGET', autoRetriesUsed: 1, errorCode: 'BUDGET_EXCEEDED' });
    expect(s.calls.b).toBeUndefined();
    expect(await s.q.wakeWaiting()).toBe(0);
    await s.ledger.releaseUnsent(filler.id);
    expect(await s.q.wakeWaiting()).toBe(1);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1 });
    expect(s.calls).toEqual({ a: 2, b: 1 });
  });

  it('AC-4 권한 부족은 재시도 없이 권한 대기, 환급, 복구 확인 뒤에만 재개', async () => {
    let granted = false;
    const s = setup({ a: () => { if (!granted) throw new PermissionDeniedError('NO_YOUTUBE_SCOPE'); return 'A'; } }, ['a'], undefined, async () => granted);
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'WAITING', waitReason: 'PERMISSION', autoRetriesUsed: 0, errorCode: 'NO_YOUTUBE_SCOPE' });
    expect(await s.ledger.snapshot()).toMatchObject({ committedKrw: 0 });
    expect(await s.q.wakeWaiting()).toBe(0);
    granted = true;
    expect(await s.q.wakeWaiting()).toBe(1);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0 });
  });

  it('AC-5 수동 재시도는 명령과 연결된 요청 기록을 남기고, 완료 결과·카운터를 계승하며, 같은 명령은 한 번만', async () => {
    let fail = true;
    const s = setup({ a: () => 'A', b: () => { if (fail) boom(); return 'B'; } }, ['b'], async () => ({ status: 'NOT_FOUND', evidence: 'none' }));
    const j = await job(s);
    await drain(s.q); // b: 실패→조회 미처리→자동 재시도 1회→또 실패→조회 미처리→FAILED
    expect(await s.q.get(j.id)).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1 });
    expect(await s.q.requestManualRetry(j.id, { commandId: '', actor: 'owner' })).toEqual({ ok: false, code: 'INVALID_COMMAND' });
    fail = false;
    expect(await s.q.requestManualRetry(j.id, { commandId: 'user-cmd-1', actor: 'owner@x' })).toEqual({ ok: true, duplicate: false });
    expect(await s.q.requestManualRetry(j.id, { commandId: 'user-cmd-1', actor: 'owner@x' })).toEqual({ ok: true, duplicate: true });
    const reqs = (await pool.query('SELECT command_id, actor, kind, prior_state, inherited_auto_retries FROM job_requests WHERE job_id=$1', [j.id])).rows;
    expect(reqs).toEqual([{ command_id: 'user-cmd-1', actor: 'owner@x', kind: 'MANUAL_RETRY', prior_state: 'FAILED', inherited_auto_retries: 1 }]);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1, manualRequests: 1 });
    expect(s.calls.a).toBe(1); // 기존 결과 보존, 재실행 없음
    expect((await s.q.stages(j.id)).find((x) => x.stage === 'a')).toMatchObject({ state: 'DONE', result: 'A' });
    expect((await s.q.events(j.id)).map((e) => e.event)).toContain('MANUAL_RETRY');
  });

  it('AC-5 수동 재시도 후 다시 실패해도 자동 재시도 횟수는 초기화되지 않는다', async () => {
    const s = setup({ a: () => boom() });
    const j = await job(s);
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1 });
    await s.q.requestManualRetry(j.id, { commandId: 'cmd-2', actor: 'o' });
    await drain(s.q);
    expect(await s.q.get(j.id)).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1, manualRequests: 1 });
    expect(s.calls.a).toBe(3); // 최초 + 자동 1 + 수동 1, 추가 자동 재시도 없음
    expect(await s.q.requestManualRetry(j.id, { commandId: 'cmd-3', actor: 'o' })).toMatchObject({ ok: true });
  });

  it('같은 idempotencyKey 는 같은 작업', async () => {
    const s = setup({ a: () => 'A' });
    const a = await job(s, 'same');
    const b = await job(s, 'same');
    expect(b.id).toBe(a.id);
  });
});
