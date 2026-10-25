import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempSchema } from '../records/db.testutil.js';
import { RecordStore } from '../records/store.js';
import { MemoryLiveUsageStore, PgLiveUsageStore } from './usage.js';

const url = process.env.DATABASE_URL;
const now = new Date('2026-10-25T12:00:00Z');

describe('MemoryLiveUsageStore', () => {
  it('합산하고, 끝내면 ENDED 가 되며 사유는 처음 값을 유지한다', async () => {
    const u = new MemoryLiveUsageStore();
    await u.open('o', 'i');
    await u.add('o', 'i', 1000, 5, null);
    expect(await u.get('o', 'i')).toMatchObject({ usedMs: 1000, costKrw: 5, status: 'OPEN' });
    await u.add('o', 'i', 500, 2, 'TIME_LIMIT');
    await u.add('o', 'i', 0, 0, 'USER_END');
    expect(await u.get('o', 'i')).toMatchObject({ usedMs: 1500, costKrw: 7, status: 'ENDED', endReason: 'TIME_LIMIT' });
    expect(await u.get('other', 'i')).toBeNull();
  });
});

describe.skipIf(!url)('PgLiveUsageStore (실제 PostgreSQL 임시 스키마)', () => {
  let tmp: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let id: string;
  beforeAll(async () => {
    tmp = await createTempSchema(url!);
    pool = tmp.pool();
    id = (await new RecordStore(pool).startInterview('o', now)).interview.id;
  });
  afterAll(async () => { await pool.end(); await tmp.drop(); });

  it('동시 open 은 한 행만 만들고 연결 수를 모두 센다', async () => {
    const u = new PgLiveUsageStore(pool);
    await Promise.all(Array.from({ length: 6 }, () => u.open('o', id, now)));
    expect(await u.get('o', id)).toMatchObject({ connections: 6, status: 'OPEN', usedMs: 0 });
    expect((await pool.query('SELECT count(*)::int AS n FROM interview_live_usage WHERE interview_id = $1', [id])).rows[0].n).toBe(1);
  });
  it('합산·끝내기·남의 기록 거부', async () => {
    const u = new PgLiveUsageStore(pool);
    await u.add('o', id, 120_000, 90.5, null, now);
    await u.add('o', id, 60_000, 10, 'USER_END', now);
    expect(await u.get('o', id)).toMatchObject({ usedMs: 180_000, costKrw: 100.5, status: 'ENDED', endReason: 'USER_END' });
    expect(await u.get('x', id)).toBeNull();
    await expect(u.open('x', id, now)).rejects.toThrow();
  });
});
