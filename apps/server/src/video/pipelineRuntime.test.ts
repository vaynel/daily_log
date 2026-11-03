import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import type { StageContext } from '../jobs/queue.js';
import { buildVideoRuntime } from './pipelineRuntime.js';

it('quality waits for Pro before database reads or budget reservations when providers are absent', async () => {
  const query = vi.fn();
  const reserve = vi.fn();
  const runtime = await buildVideoRuntime({ config: { fileStorageDir: '/workspace/data/test' } as Config,
    pool: { query } as unknown as pg.Pool, ledger: { reserve } as unknown as MonthlyLedger, env: {} });
  await expect(runtime.handlers.quality!.execute({ jobId:'absent', stage:'quality', attempt:1, externalRequestId:'test', subjectId: 'absent', results: {}, heartbeat: async () => true } satisfies StageContext)).rejects.toThrow('PRO_UNAVAILABLE');
  expect(query).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  await runtime.close();
});
