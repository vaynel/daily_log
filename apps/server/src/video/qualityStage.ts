import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { NonRetryableError, QualityRejectedError, type StageContext, type StageHandler } from '../jobs/queue.js';
import { inspectQuality, type QualityComponent, type QualityInput } from './quality.js';
import { probeVideo } from './render.js';

export interface QualityStageDeps {
  pool: pg.Pool;
  /** Must resolve only the renderer's trusted artifact directory, never a user supplied path. */
  resolveFile(file: string): string;
  /** Current rules, actual/mock STT and assessment evidence for this rendered script version. */
  loadInput(ctx: StageContext): Promise<QualityInput>;
  /** Recheck current authorization at every failed review, including budget/permission wake-up. */
  permissionGranted(ctx: StageContext): Promise<boolean>;
  /** Component → affected generation stages. Include dependent stages, e.g. script → voice+captions. */
  repairStages: Record<QualityComponent, string[]>;
  renderStage?: string;
  heartbeatMs: number;
}

/** A final queue stage after render. No successful stage output exists for a rejected video. */
export function createQualityHandler(d: QualityStageDeps): StageHandler {
  return {
    async execute(ctx) {
      const timer = setInterval(() => { void ctx.heartbeat().catch(() => {}); }, d.heartbeatMs);
      try {
        await d.pool.query("UPDATE pipeline_states SET production='RUNNING', review='PENDING', updated_at=now() WHERE interview_id::text=$1", [ctx.subjectId]);
        const i = await d.loadInput(ctx);
        const rendered = ctx.results[d.renderStage ?? 'render'] as { file?: string; sha256?: string; scriptVersion?: number } | undefined;
        if (!rendered || rendered.file !== i.file || rendered.sha256 !== i.sha256 || rendered.scriptVersion !== i.scriptVersion) throw new NonRetryableError('QUALITY_ARTIFACT_MISMATCH');
        const file = d.resolveFile(i.file);
        const actualHash = createHash('sha256').update(await readFile(file)).digest('hex');
        if (actualHash !== i.sha256) throw new NonRetryableError('QUALITY_ARTIFACT_CHANGED');
        // Do not trust caller-provided duration/format: inspect the actual rendered bytes.
        const report = inspectQuality({ ...i, probe: await probeVideo(file) });
        if (!report.passed) {
          const failed = [...new Set(report.checks.filter(c => !c.passed).map(c => c.component))];
          const repair = [...new Set([...failed.flatMap(p => d.repairStages[p]), d.renderStage ?? 'render', ctx.stage])];
          throw new QualityRejectedError(report, repair, await d.permissionGranted(ctx));
        }
        const c = await d.pool.connect();
        try {
          await c.query('BEGIN');
          const j = (await c.query('SELECT state, quality_regenerations_used FROM jobs WHERE id=$1 FOR UPDATE', [ctx.jobId])).rows[0];
          if (!j || j.state !== 'RUNNING' || Number(j.quality_regenerations_used) !== (ctx.qualityGeneration ?? 0)) throw new NonRetryableError('QUALITY_STALE');
          await c.query('INSERT INTO job_quality_reviews (job_id,generation,report,prior_results) VALUES ($1,$2,$3::jsonb,$4::jsonb)', [ctx.jobId, j.quality_regenerations_used, JSON.stringify(report), JSON.stringify(ctx.results)]);
          await c.query("UPDATE pipeline_states SET production='DONE', review='PASSED', quality_reasons='{}', updated_at=now() WHERE interview_id::text=$1", [ctx.subjectId]);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
        return { result: { ...report, publishable: true } };
      } catch (e) {
        if (!(e instanceof QualityRejectedError)) await d.pool.query("UPDATE pipeline_states SET production='FAILED', review='REJECTED', updated_at=now() WHERE interview_id::text=$1", [ctx.subjectId]);
        throw e;
      } finally { clearInterval(timer); }
    },
  };
}

/** Display every simultaneous blocker; rejected results are never publishable. */
export function qualityStatus(reasons: string[], passed: boolean) {
  const labels: Record<string, string> = { QUALITY_EXHAUSTED: '품질 자동 재제작 1회를 모두 사용했습니다.', BUDGET: '예산 확보를 기다립니다.', PERMISSION: '제작 권한 확인을 기다립니다.' };
  return { publishable: passed && reasons.length === 0, messages: reasons.map(r => labels[r] ?? r) };
}
