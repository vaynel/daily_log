import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue, type StageHandler } from '../jobs/queue.js';
import { displayStatus } from '../records/view.js';
import { createRenderHandler } from './renderStage.js';
import { RenderGate } from './renderGate.js';
import { mockInput, mockOverlay, rm, tmpDir } from './render.testutil.js';
import { createQualityHandler, qualityStatus } from './qualityStage.js';
import { input } from './quality.testutil.js';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('렌더 → 검수 → 부분 재제작 통합', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>, pool: pg.Pool, dir: string;
  beforeAll(async () => { t = await createTempSchema(url!); pool = t.pool(); dir = tmpDir('quality-stage-'); });
  afterAll(async () => { await pool.end(); await t.drop(); rm(dir); });
  it.each(['single-scene', 'cross-scene'])('%s: 실제 MP4 실패 파일·근거 보존, 자막만 재제작, 재검수 통과 후 완료', async mode => {
    const id = randomUUID();
    await pool.query("INSERT INTO interviews(id,owner_id,life_date,started_at,status) VALUES($1,'fixture','2030-01-01',now(),'CONFIRMED')", [id]);
    await pool.query("INSERT INTO pipeline_states(interview_id,updated_at) VALUES($1,now())", [id]);
    let captions = 0, images = 0;
    const renderInput = { ...mockInput([1]), scriptVersion: 2 };
    const handlers: Record<string, StageHandler> = {
      image: { execute: async () => ({ result: ++images }) },
      captions: { execute: async () => ({ result: ++captions }) },
      render: createRenderHandler({ gate: new RenderGate(pool), render: { overlay: mockOverlay(), minFreeBytes: 0 }, loadInput: async () => renderInput, outFile: () => path.join(dir, 'video.mp4'), heartbeatMs: 100 }),
      quality: createQualityHandler({ pool, resolveFile: f => path.join(dir, f), heartbeatMs: 100, permissionGranted: async () => true,
        repairStages: { script: ['captions'], visual: ['image'], transcript: [], subtitles: ['captions'], zooms: [], render: [] },
        loadInput: async ctx => {
          const i = input(); Object.assign(i, ctx.results.render); i.expectedSec = 1;
          if (captions === 1) {
            if (mode === 'cross-scene') {
              i.excludedTexts = ['비공개 프로젝트'];
              i.scenes = ['비공개', '프로젝트'].map((text, n) => ({ ...structuredClone(i.scenes[0]!), key: `s${n}`, subtitles: [text] }));
            } else i.scenes[0]!.subtitles = ['대통령 선거'];
          }
          return i;
        },
      }),
    };
    const q = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers: { video: handlers } });
    const j = await q.enqueue({ kind: 'video', subjectId: id, stages: Object.keys(handlers), idempotencyKey: id });
    await q.tick();
    const pipeline = (await pool.query('SELECT * FROM pipeline_states WHERE interview_id=$1', [id])).rows[0];
    expect(displayStatus('CONFIRMED', pipeline)).toBe('REVIEW_REJECTED');
    expect(await q.get(j.id)).toMatchObject({ state: 'QUEUED', qualityRegenerationsUsed: 1, autoRetriesUsed: 0 });
    const first = readdirSync(dir).find(f => f.endsWith(`${j.id}.q0.mp4`))!;
    const hash = createHash('sha256').update(readFileSync(path.join(dir, first))).digest('hex');
    await q.tick();
    expect(await q.get(j.id)).toMatchObject({ state: 'SUCCEEDED', qualityRegenerationsUsed: 1, autoRetriesUsed: 0 });
    expect(images).toBe(1); expect(captions).toBe(2);
    expect(createHash('sha256').update(readFileSync(path.join(dir, first))).digest('hex')).toBe(hash);
    expect(readdirSync(dir).filter(f => f.includes(j.id) && f.endsWith('.mp4'))).toHaveLength(2);
    const reports = (await pool.query('SELECT report FROM job_quality_reviews WHERE job_id=$1 ORDER BY id', [j.id])).rows;
    expect(reports.map(r => r.report.passed)).toEqual([false, true]);
    if (mode === 'cross-scene') expect(reports[0]!.report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ scene: null, component: 'subtitles', code: 'THIS_VIDEO_EXCLUDED', passed: false }),
    ]));
    expect((await q.stages(j.id)).find(s => s.stage === 'render')!.result.scriptVersion).toBe(2);
    expect(displayStatus('CONFIRMED', (await pool.query('SELECT * FROM pipeline_states WHERE interview_id=$1', [id])).rows[0])).toBe('COMPLETED');
  }, 60_000);
  it('소진·예산 대기를 둘 다 표시하며 검수 미통과 결과는 공개 불가다', () => {
    expect(qualityStatus(['QUALITY_EXHAUSTED', 'BUDGET'], false)).toEqual({ publishable: false, messages: ['품질 자동 재제작 1회를 모두 사용했습니다.', '예산 확보를 기다립니다.'] });
  });
});
