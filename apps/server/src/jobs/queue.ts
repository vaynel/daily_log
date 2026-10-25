import type pg from 'pg';
import { classifyFailure } from '../budget/gateway.js';
import type { MonthlyLedger, Purpose } from '../budget/ledger.js';

/** 권한이 없어 진행할 수 없음. 재시도하지 않고 권한 대기 사유를 남긴다. */
export class PermissionDeniedError extends Error {
  constructor(readonly code = 'PERMISSION_DENIED') { super(code); }
}
/** 재시도해도 같은 결과일 오류(입력 오류 등). 자동 재시도 없이 실패로 남긴다. */
export class NonRetryableError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type WaitReason = 'BUDGET' | 'PERMISSION' | 'EXTERNAL_RESULT_UNKNOWN';
export type JobState = 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED';

export interface StageContext {
  jobId: string;
  subjectId: string;
  stage: string;
  /** 이 단계의 몇 번째 실행인지(1부터). */
  attempt: number;
  /** 유료 단계의 외부 요청 식별자. 제공자 멱등키·조회 키로 쓴다. */
  externalRequestId: string;
  /** 앞서 완료된 단계의 결과(보존된 값). */
  results: Record<string, unknown>;
}
export interface StageOutput { result: unknown; actualKrw?: number }

export type LookupOutcome =
  | { status: 'COMPLETED'; result: unknown; actualKrw: number; evidence: string }
  | { status: 'NOT_FOUND'; evidence: string }
  | { status: 'UNKNOWN' };

export interface StageHandler {
  execute(ctx: StageContext): Promise<StageOutput>;
  /** 있으면 유료 호출이다: 예산 예약 → 외부 요청 식별자 저장 → 실행 순으로만 진행한다. */
  paid?: { provider: string; operation: string; estimateKrw: number; purpose?: Purpose };
  /** 결과가 불명확한 외부 요청의 처리 결과를 제공자에게 조회한다. 없으면 사람 확인을 기다린다. */
  lookup?(externalRequestId: string, ctx: StageContext): Promise<LookupOutcome>;
}

export interface JobRow {
  id: string; kind: string; subjectId: string; stages: string[]; state: JobState; waitReason: WaitReason | null;
  autoRetriesUsed: number; manualRequests: number; errorCode: string | null;
}
export interface QueueDeps {
  pool: pg.Pool;
  ledger: MonthlyLedger;
  handlers: Record<string, Record<string, StageHandler>>; // kind → stage → handler
  /** 권한 대기 작업을 다시 시작해도 되는지. 기본은 false(사람이 권한을 준 뒤 수동 요청). */
  permissionRestored?: (job: JobRow) => Promise<boolean>;
  leaseMs?: number;
}

const MAX_AUTO_RETRIES = 1;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toJob = (r: Row): JobRow => ({
  id: r.id, kind: r.kind, subjectId: r.subject_id, stages: r.stages, state: r.state, waitReason: r.wait_reason,
  autoRetriesUsed: Number(r.auto_retries_used), manualRequests: Number(r.manual_requests), errorCode: r.error_code,
});

type Step = 'CONTINUE' | 'STOP';

export class JobQueue {
  constructor(private readonly d: QueueDeps) {}
  private get pool() { return this.d.pool; }

  /** 같은 idempotencyKey 는 같은 작업을 돌려준다. */
  async enqueue(i: { kind: string; subjectId: string; stages: string[]; idempotencyKey: string }): Promise<JobRow> {
    const r = await this.pool.query(
      `INSERT INTO jobs (kind, subject_id, stages, idempotency_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [i.kind, i.subjectId, i.stages, i.idempotencyKey]);
    if (r.rows[0]) { await this.event(r.rows[0].id, 'ENQUEUED'); return toJob(r.rows[0]); }
    return (await this.get((await this.pool.query('SELECT id FROM jobs WHERE idempotency_key=$1', [i.idempotencyKey])).rows[0].id))!;
  }

  async get(id: string): Promise<JobRow | null> {
    const r = await this.pool.query('SELECT * FROM jobs WHERE id=$1', [id]);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }
  async stages(id: string) {
    const r = await this.pool.query('SELECT stage, state, attempts, external_request_id, result, error_code FROM job_stages WHERE job_id=$1 ORDER BY stage', [id]);
    return r.rows as Row[];
  }
  async events(id: string) {
    return (await this.pool.query('SELECT event, stage, code FROM job_events WHERE job_id=$1 ORDER BY id', [id])).rows as Row[];
  }

  private async event(jobId: string, event: string, stage?: string, code?: string) {
    await this.pool.query('INSERT INTO job_events (job_id, event, stage, code) VALUES ($1,$2,$3,$4)', [jobId, event, stage ?? null, code ?? null]);
  }
  private async setState(jobId: string, state: JobState, wait: WaitReason | null, code: string | null, from?: JobState) {
    await this.pool.query(
      `UPDATE jobs SET state=$2, wait_reason=$3, error_code=$4, lease_until=NULL, updated_at=now() WHERE id=$1 AND ($5::text IS NULL OR state=$5)`,
      [jobId, state, wait, code, from ?? null]);
  }

  /**
   * 서버 시작 시 호출. 임대가 끊긴 RUNNING 작업을 이어받는다.
   * 외부 요청이 나간 단계는 재전송하지 않고 결과 조회로 넘기고, 그 외 중단은 일시 오류로 취급한다.
   */
  async recover(): Promise<number> {
    const r = await this.pool.query(`SELECT id FROM jobs WHERE state='RUNNING' AND (lease_until IS NULL OR lease_until < now()) FOR UPDATE SKIP LOCKED`);
    for (const row of r.rows) {
      await this.pool.query(`UPDATE jobs SET state='QUEUED', lease_until=NULL, updated_at=now() WHERE id=$1 AND state='RUNNING'`, [row.id]);
      await this.event(row.id, 'RECOVERED');
    }
    return r.rowCount ?? 0;
  }

  /** 예산·권한 대기 작업 중 조건이 풀린 것을 다시 대기열로(재시도 횟수는 쓰지 않는다). */
  async wakeWaiting(): Promise<number> {
    let n = 0;
    const r = await this.pool.query(`SELECT * FROM jobs WHERE state='WAITING' AND wait_reason IN ('BUDGET','PERMISSION')`);
    for (const row of r.rows) {
      const job = toJob(row);
      let ok = false;
      if (job.waitReason === 'PERMISSION') ok = (await this.d.permissionRestored?.(job)) ?? false;
      else {
        const est = await this.nextPaidEstimate(job);
        ok = (await this.d.ledger.snapshot()).remainingKrw >= est;
      }
      if (ok) { await this.setState(job.id, 'QUEUED', null, null, 'WAITING'); await this.event(job.id, 'WOKEN', undefined, job.waitReason!); n++; }
    }
    return n;
  }

  private async nextPaidEstimate(job: JobRow): Promise<number> {
    const done = new Set((await this.stages(job.id)).filter((s) => s.state === 'DONE').map((s) => s.stage));
    const next = job.stages.find((s) => !done.has(s));
    return (next && this.d.handlers[job.kind]?.[next]?.paid?.estimateKrw) || 0;
  }

  /** 대기 중인 작업 하나를 가져와 처리한다. 처리한 작업이 없으면 null. */
  async tick(): Promise<JobRow | null> {
    const c = await this.pool.query(
      `UPDATE jobs SET state='RUNNING', lease_until = now() + ($1 || ' milliseconds')::interval, updated_at=now()
       WHERE id = (SELECT id FROM jobs WHERE state='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [String(this.d.leaseMs ?? 60000)]);
    if (!c.rows[0]) return null;
    const job = toJob(c.rows[0]);
    try {
      await this.process(job);
    } catch (e) {
      // 처리기 밖의 예기치 못한 오류(DB 등): 상태를 바꾸지 않고 임대 만료 후 recover 가 이어받게 한다.
      await this.event(job.id, 'INTERNAL_ERROR', undefined, e instanceof Error ? e.name : 'ERROR').catch(() => {});
      throw e;
    }
    return (await this.get(job.id))!;
  }

  private async process(job: JobRow) {
    const handlers = this.d.handlers[job.kind];
    if (!handlers) return this.fail(job, 'NO_HANDLER');
    for (const stage of job.stages) {
      const h = handlers[stage];
      if (!h) return this.fail(job, 'NO_HANDLER', stage);
      const row = (await this.pool.query('SELECT * FROM job_stages WHERE job_id=$1 AND stage=$2', [job.id, stage])).rows[0] as Row | undefined;
      if (row?.state === 'DONE') continue;
      const cur = (await this.get(job.id))!; // 재시도 횟수 최신값
      const step = await this.runStage(cur, stage, h, row);
      if (step === 'STOP') return;
    }
    await this.setState(job.id, 'SUCCEEDED', null, null, 'RUNNING');
    await this.event(job.id, 'SUCCEEDED');
  }

  private async results(jobId: string): Promise<Record<string, unknown>> {
    const r = await this.pool.query(`SELECT stage, result FROM job_stages WHERE job_id=$1 AND state='DONE'`, [jobId]);
    return Object.fromEntries(r.rows.map((x) => [x.stage, x.result]));
  }

  private async runStage(job: JobRow, stage: string, h: StageHandler, row: Row | undefined): Promise<Step> {
    const ctxBase = { jobId: job.id, subjectId: job.subjectId, stage, results: await this.results(job.id) };
    // 외부 요청이 나갔고 결과가 확정되지 않은 단계는 다시 보내지 않고 조회로 넘긴다.
    if (row && (row.state === 'SENT' || row.state === 'UNKNOWN')) {
      return this.resolveUnsettled(job, stage, h, row, { ...ctxBase, attempt: Number(row.attempts), externalRequestId: row.external_request_id });
    }
    // 유료가 아닌 단계가 실행 중 끊겼다면(서버 중단) 일시 오류와 같이 취급한다: 자동 재시도 1회 한도 안에서만 다시 실행.
    if (row?.state === 'RUNNING' && !h.paid) {
      await this.upsertStage(job.id, stage, 'FAILED', Number(row.attempts), null, null, 'INTERRUPTED');
      return this.transient(job, stage, 'INTERRUPTED');
    }
    const attempt = Number(row?.attempts ?? 0) + 1;
    const externalRequestId = `${job.id}:${stage}:${attempt}`;
    const ctx: StageContext = { ...ctxBase, attempt, externalRequestId };

    if (!h.paid) {
      await this.upsertStage(job.id, stage, 'RUNNING', attempt, null, null);
      try {
        const out = await h.execute(ctx);
        await this.markDone(job.id, stage, out.result);
        return 'CONTINUE';
      } catch (e) {
        return this.onError(job, stage, e);
      }
    }

    // 유료: 예약 → 요청 식별자 저장 → 실행.
    const purpose: Purpose = job.autoRetriesUsed > 0 || job.manualRequests > 0 || attempt > 1 ? 'RETRY' : (h.paid.purpose ?? 'PRODUCT');
    const res = await this.d.ledger.reserve({
      provider: h.paid.provider, operation: h.paid.operation, purpose, estimateKrw: h.paid.estimateKrw, idempotencyKey: externalRequestId,
    });
    if (!res.ok) return this.wait(job, 'BUDGET', stage, 'BUDGET_EXCEEDED');
    if (res.duplicate) { // 같은 요청 식별자가 이미 있으면 보낸 것으로 간주(재전송 금지).
      await this.upsertStage(job.id, stage, 'UNKNOWN', attempt, externalRequestId, res.id);
      return this.resolveUnsettled(job, stage, h, { state: 'UNKNOWN', budget_entry_id: res.id }, ctx);
    }
    await this.upsertStage(job.id, stage, 'SENT', attempt, externalRequestId, res.id);
    let out: StageOutput;
    try {
      out = await h.execute(ctx);
    } catch (e) {
      if (e instanceof PermissionDeniedError) { // 호출 전 거절: 나가지 않았음이 확실
        await this.d.ledger.releaseUnsent(res.id);
        await this.upsertStage(job.id, stage, 'FAILED', attempt, externalRequestId, res.id, e.code);
        return this.wait(job, 'PERMISSION', stage, e.code);
      }
      if (e instanceof NonRetryableError || classifyFailure(e) === 'REJECTED') {
        await this.d.ledger.releaseUnsent(res.id);
        const code = e instanceof NonRetryableError ? e.code : 'CALL_REJECTED';
        await this.upsertStage(job.id, stage, 'FAILED', attempt, externalRequestId, res.id, code);
        return this.fail(job, code, stage);
      }
      // 성공 여부 불명: 예약액 유지, 자동 재전송 금지.
      await this.d.ledger.markUnknown(res.id, 'CALL_UNKNOWN');
      await this.upsertStage(job.id, stage, 'UNKNOWN', attempt, externalRequestId, res.id, 'CALL_UNKNOWN');
      return this.resolveUnsettled(job, stage, h, { state: 'UNKNOWN', budget_entry_id: res.id }, ctx);
    }
    await this.d.ledger.confirm(res.id, out.actualKrw ?? h.paid.estimateKrw);
    await this.markDone(job.id, stage, out.result);
    return 'CONTINUE';
  }

  /** 결과가 확정되지 않은 외부 요청: 원장 불명 보존 → 조회 → 정산. 조회 불가면 확인 대기. */
  private async resolveUnsettled(job: JobRow, stage: string, h: StageHandler, row: Row, ctx: StageContext): Promise<Step> {
    const entryId = row.budget_entry_id as string | null;
    if (entryId) await this.d.ledger.markUnknown(entryId, 'RESTART_OR_LOST'); // RESERVED 일 때만 적용
    await this.pool.query(`UPDATE job_stages SET state='UNKNOWN', updated_at=now() WHERE job_id=$1 AND stage=$2 AND state<>'DONE'`, [job.id, stage]);
    let out: LookupOutcome = { status: 'UNKNOWN' };
    if (h.lookup) {
      try { out = await h.lookup(ctx.externalRequestId, ctx); } catch { out = { status: 'UNKNOWN' }; }
    }
    if (out.status === 'COMPLETED') {
      if (entryId) await this.d.ledger.resolveUnknown(entryId, { charged: true, actualKrw: out.actualKrw, evidence: out.evidence });
      await this.markDone(job.id, stage, out.result);
      await this.event(job.id, 'EXTERNAL_RESOLVED', stage, 'COMPLETED');
      return 'CONTINUE';
    }
    if (out.status === 'NOT_FOUND') {
      if (entryId) await this.d.ledger.resolveUnknown(entryId, { charged: false, evidence: out.evidence });
      await this.upsertStage(job.id, stage, 'FAILED', Number(row.attempts ?? ctx.attempt), ctx.externalRequestId, entryId, 'NOT_PROCESSED');
      await this.event(job.id, 'EXTERNAL_RESOLVED', stage, 'NOT_FOUND');
      return this.transient(job, stage, 'EXTERNAL_NOT_PROCESSED');
    }
    return this.wait(job, 'EXTERNAL_RESULT_UNKNOWN', stage, 'EXTERNAL_RESULT_UNKNOWN');
  }

  private async onError(job: JobRow, stage: string, e: unknown): Promise<Step> {
    if (e instanceof PermissionDeniedError) {
      await this.upsertStage(job.id, stage, 'FAILED', 0, null, null, e.code);
      return this.wait(job, 'PERMISSION', stage, e.code);
    }
    if (e instanceof NonRetryableError) {
      await this.upsertStage(job.id, stage, 'FAILED', 0, null, null, e.code);
      return this.fail(job, e.code, stage);
    }
    await this.upsertStage(job.id, stage, 'FAILED', 0, null, null, 'TRANSIENT_ERROR');
    return this.transient(job, stage, 'TRANSIENT_ERROR');
  }

  /** 일시 오류: 작업 전체에서 한 번만 자동 재시도. 이미 썼으면 실패로 남겨 수동 요청을 기다린다. */
  private async transient(job: JobRow, stage: string, code: string): Promise<Step> {
    const r = await this.pool.query(
      `UPDATE jobs SET state='QUEUED', auto_retries_used=auto_retries_used+1, error_code=NULL, lease_until=NULL, updated_at=now()
       WHERE id=$1 AND state='RUNNING' AND auto_retries_used < $2 RETURNING id`, [job.id, MAX_AUTO_RETRIES]);
    if (r.rows[0]) { await this.event(job.id, 'AUTO_RETRY', stage, code); return 'STOP'; }
    return this.fail(job, code, stage);
  }

  private async wait(job: JobRow, reason: WaitReason, stage: string, code: string): Promise<Step> {
    await this.setState(job.id, 'WAITING', reason, code, 'RUNNING');
    await this.event(job.id, 'WAITING', stage, reason);
    return 'STOP';
  }
  private async fail(job: JobRow, code: string, stage?: string): Promise<Step> {
    await this.setState(job.id, 'FAILED', null, code, 'RUNNING');
    await this.event(job.id, 'FAILED', stage, code);
    return 'STOP';
  }

  private async upsertStage(jobId: string, stage: string, state: string, attempts: number, ext: string | null, entry: string | null, code?: string) {
    await this.pool.query(
      `INSERT INTO job_stages (job_id, stage, state, attempts, external_request_id, budget_entry_id, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (job_id, stage) DO UPDATE SET state=EXCLUDED.state,
         attempts=GREATEST(job_stages.attempts, EXCLUDED.attempts),
         external_request_id=COALESCE(EXCLUDED.external_request_id, job_stages.external_request_id),
         budget_entry_id=COALESCE(EXCLUDED.budget_entry_id, job_stages.budget_entry_id),
         error_code=EXCLUDED.error_code, updated_at=now()
       WHERE job_stages.state <> 'DONE'`, [jobId, stage, state, attempts, ext, entry, code ?? null]);
  }
  private async markDone(jobId: string, stage: string, result: unknown) {
    await this.pool.query(
      `UPDATE job_stages SET state='DONE', result=$3::jsonb, error_code=NULL, updated_at=now() WHERE job_id=$1 AND stage=$2 AND state<>'DONE'`,
      [jobId, stage, JSON.stringify(result ?? null)]);
    await this.event(jobId, 'STAGE_DONE', stage);
  }

  /**
   * 사용자 수동 재시도. 실제 사용자 명령 식별자(commandId)와 연결된 요청 기록을 남긴다.
   * 완료된 단계 결과와 자동 재시도 사용 횟수는 그대로 계승한다(0으로 되돌리지 않음).
   * 결과 불명 외부 요청이 남은 작업은 먼저 결과를 확인해야 하므로 거부한다(중복 과금 방지).
   */
  async requestManualRetry(jobId: string, req: { commandId: string; actor: string }):
    Promise<{ ok: true; duplicate: boolean } | { ok: false; code: 'NOT_FOUND' | 'NOT_RETRYABLE' | 'UNRESOLVED_EXTERNAL' | 'INVALID_COMMAND' }> {
    if (!req.commandId?.trim() || !req.actor?.trim()) return { ok: false, code: 'INVALID_COMMAND' };
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const dup = await c.query('SELECT job_id FROM job_requests WHERE command_id=$1', [req.commandId]);
      if (dup.rows[0]) { await c.query('COMMIT'); return dup.rows[0].job_id === jobId ? { ok: true, duplicate: true } : { ok: false, code: 'INVALID_COMMAND' }; }
      const r = await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const j = r.rows[0] as Row | undefined;
      if (!j) { await c.query('ROLLBACK'); return { ok: false, code: 'NOT_FOUND' }; }
      if (j.state === 'WAITING' && j.wait_reason === 'EXTERNAL_RESULT_UNKNOWN') { await c.query('ROLLBACK'); return { ok: false, code: 'UNRESOLVED_EXTERNAL' }; }
      const unsettled = await c.query(`SELECT 1 FROM job_stages WHERE job_id=$1 AND state IN ('SENT','UNKNOWN')`, [jobId]);
      if (unsettled.rows[0]) { await c.query('ROLLBACK'); return { ok: false, code: 'UNRESOLVED_EXTERNAL' }; }
      if (!(j.state === 'FAILED' || (j.state === 'WAITING' && (j.wait_reason === 'BUDGET' || j.wait_reason === 'PERMISSION')))) {
        await c.query('ROLLBACK'); return { ok: false, code: 'NOT_RETRYABLE' };
      }
      await c.query(
        `INSERT INTO job_requests (job_id, command_id, actor, kind, prior_state, prior_wait_reason, inherited_auto_retries) VALUES ($1,$2,$3,'MANUAL_RETRY',$4,$5,$6)`,
        [jobId, req.commandId, req.actor, j.state, j.wait_reason, j.auto_retries_used]);
      await c.query(`UPDATE jobs SET state='QUEUED', wait_reason=NULL, error_code=NULL, manual_requests=manual_requests+1, updated_at=now() WHERE id=$1`, [jobId]);
      await c.query('INSERT INTO job_events (job_id, event, code) VALUES ($1,$2,$3)', [jobId, 'MANUAL_RETRY', req.commandId]);
      await c.query('COMMIT');
      return { ok: true, duplicate: false };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * 사람이 제공자 사용량을 확인한 뒤 결과 불명 단계를 정산한다(근거 필수, 명령 식별자 기록).
   * COMPLETED 면 단계 결과를 보존하고 이어서 진행, NOT_CHARGED 면 환급 후 재요청 가능 상태(실패)로 둔다.
   */
  async resolveExternal(jobId: string, stage: string, outcome:
    { charged: true; actualKrw: number; result: unknown; evidence: string } | { charged: false; evidence: string },
    req: { commandId: string; actor: string }): Promise<boolean> {
    if (!req.commandId?.trim() || !req.actor?.trim() || !outcome.evidence.trim()) throw new Error('명령 식별자·담당자·확인 근거가 필요함');
    const j = await this.get(jobId);
    const st = (await this.pool.query('SELECT * FROM job_stages WHERE job_id=$1 AND stage=$2', [jobId, stage])).rows[0] as Row | undefined;
    if (!j || !st || j.state !== 'WAITING' || j.waitReason !== 'EXTERNAL_RESULT_UNKNOWN' || st.state !== 'UNKNOWN') return false;
    const ins = await this.pool.query(
      `INSERT INTO job_requests (job_id, command_id, actor, kind, prior_state, prior_wait_reason, inherited_auto_retries) VALUES ($1,$2,$3,'EXTERNAL_RESOLVE',$4,$5,$6)
       ON CONFLICT (command_id) DO NOTHING`, [jobId, req.commandId, req.actor, j.state, j.waitReason, j.autoRetriesUsed]);
    if (ins.rowCount !== 1) return false;
    if (outcome.charged) {
      if (st.budget_entry_id) await this.d.ledger.resolveUnknown(st.budget_entry_id, { charged: true, actualKrw: outcome.actualKrw, evidence: outcome.evidence });
      await this.markDone(jobId, stage, outcome.result);
    } else {
      if (st.budget_entry_id) await this.d.ledger.resolveUnknown(st.budget_entry_id, { charged: false, evidence: outcome.evidence });
      await this.upsertStage(jobId, stage, 'FAILED', Number(st.attempts), st.external_request_id, st.budget_entry_id, 'NOT_PROCESSED');
    }
    // 확인된 결과에 따라 이어서 진행. 자동 재시도 횟수는 소모하지 않는다(수동 확인 후 재개).
    await this.setState(jobId, 'QUEUED', null, null, 'WAITING');
    await this.event(jobId, 'EXTERNAL_RESOLVED_MANUAL', stage, req.commandId);
    return true;
  }
}
