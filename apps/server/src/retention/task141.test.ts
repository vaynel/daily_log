import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTempSchema } from '../records/db.testutil.js';
import { RetentionService } from './service.js';

let db: Awaited<ReturnType<typeof createTempSchema>>;
let pool: ReturnType<typeof db.pool>;
let dir: string;
beforeAll(async () => {
  db = await createTempSchema(process.env.DATABASE_URL!);
  pool = db.pool();
  dir = await mkdtemp('/workspace/data/task141-');
});
afterAll(async () => { await pool?.end(); await db?.drop(); if (dir) await rm(dir, { recursive: true, force: true }); });
const exists = (file: string) => stat(file).then(() => true, () => false);

// Literal deadlines independently cover KST midnight, leap February, short months and year rollover.
for (const [created, deadline] of [
  ['2024-01-31T15:30:00Z', '2024-02-29T15:30:00Z'], // Feb 1 KST -> Mar 1 KST
  ['2024-01-30T15:30:00Z', '2024-02-28T15:30:00Z'], // Jan 31 -> leap Feb 29
  ['2025-01-31T03:00:00Z', '2025-02-28T03:00:00Z'],
  ['2026-03-31T03:00:00Z', '2026-04-30T03:00:00Z'],
  ['2026-12-31T03:00:00Z', '2027-01-31T03:00:00Z'],
] as const) it(`TASK141 legacy transcript expires at calendar month: ${created}`, async () => {
  const file = path.join(dir, 'live-legacy.json');
  await writeFile(file, JSON.stringify({ endedAt: created, turns: [{ userText: 'synthetic-private-text' }] }));
  await utimes(file, new Date(created), new Date(created));
  let clock = new Date(new Date(deadline!).getTime() - 1);
  const service = new RetentionService({ pool, fileStorageDir: dir, sessionDir: dir, backup: { cleanupReadiness: async () => ({ found: false }) } });
  await service.sweepAll(clock);
  expect(await exists(file), 'must remain before deadline').toBe(true);
  clock = new Date(deadline!);
  await service.sweepAll(clock);
  expect(await exists(file), 'expired legacy transcript must be deleted').toBe(false);
});

it('TASK141 preserves linked, active, processing, malformed and unrelated files', async () => {
  const old = new Date('2024-01-01T00:00:00Z');
  const bodies: Record<string, unknown> = {
    'live-linked.json': { interviewId: 'another-record', endedAt: old.toISOString() },
    'live-active.json': { endedAt: null },
    'live-processing.json': { endedAt: old.toISOString(), processing: true },
    'live-unknown.json': {},
    'unrelated.json': { endedAt: old.toISOString() },
    'live-array.json': [],
  };
  for (const [name, body] of Object.entries(bodies)) {
    const file = path.join(dir, name);
    await writeFile(file, JSON.stringify(body)); await utimes(file, old, old);
  }
  const service = new RetentionService({ pool, fileStorageDir: dir, sessionDir: dir, now: () => new Date('2026-11-03T00:00:00Z'), backup: { cleanupReadiness: async () => ({ found: false }) } });
  await service.sweepAll();
  for (const name of Object.keys(bodies)) expect(await exists(path.join(dir, name)), name).toBe(true);
});
