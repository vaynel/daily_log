import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTempSchema } from './db.testutil.js';
import { RecordError, RecordStore } from './store.js';
import { addCalendarMonthSeoul, suggestLifeDate } from './time.js';

const url = process.env.DATABASE_URL;
const kst = (s: string) => new Date(`${s}+09:00`);
let owner = 0;
const newOwner = () => `owner-${++owner}`;

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RecordError);
  expect((err as RecordError).code).toBe(code);
}

describe('생활일 규칙 (순수 함수)', () => {
  it('05:00 KST 경계로 생활일을 제안한다', () => {
    expect(suggestLifeDate(kst('2026-10-20T22:30:00'))).toBe('2026-10-20');
    expect(suggestLifeDate(kst('2026-10-21T00:40:00'))).toBe('2026-10-20');
    expect(suggestLifeDate(kst('2026-10-21T04:59:59'))).toBe('2026-10-20');
    expect(suggestLifeDate(kst('2026-10-21T05:00:00'))).toBe('2026-10-21');
    expect(suggestLifeDate(kst('2026-10-21T05:10:00'))).toBe('2026-10-21');
  });
  it('한 달 만료는 서울 기준 다음 달 동일 일·시각, 없으면 말일', () => {
    expect(addCalendarMonthSeoul(kst('2026-10-21T13:00:00')).toISOString()).toBe(kst('2026-11-21T13:00:00').toISOString());
    expect(addCalendarMonthSeoul(kst('2026-01-31T09:00:00')).toISOString()).toBe(kst('2026-02-28T09:00:00').toISOString());
    expect(addCalendarMonthSeoul(kst('2028-01-31T09:00:00')).toISOString()).toBe(kst('2028-02-29T09:00:00').toISOString());
    expect(addCalendarMonthSeoul(kst('2026-12-15T00:30:00')).toISOString()).toBe(kst('2027-01-15T00:30:00').toISOString());
  });
});

describe.skipIf(!url)('RecordStore (실제 PostgreSQL 임시 스키마)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  const count = async (table: string, o?: string) =>
    Number((await pool.query(o ? `SELECT count(*) FROM ${table} WHERE owner_id = $1` : `SELECT count(*) FROM ${table}`, o ? [o] : [])).rows[0].count);

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
  });
  afterAll(async () => {
    await pool.end();
    await t.drop();
  });

  describe('AC-1 날짜 경계 / Wiki05 v9 7개 예시', () => {
    it('예시1: 10/20 22:30 시작 → 10/20', async () => {
      const o = newOwner();
      const { interview } = await store.startInterview(o, kst('2026-10-20T22:30:00'));
      expect(interview.lifeDate).toBe('2026-10-20');
      expect(interview.startedAt.toISOString()).toBe(kst('2026-10-20T22:30:00').toISOString());
    });

    it('예시2: 23:50 시작 → 00:20 종료·저장해도 시작 시 확정 생활일 유지', async () => {
      const o = newOwner();
      const { interview } = await store.startInterview(o, kst('2026-10-20T23:50:00'));
      await store.saveItem(o, interview.id, 'k1', 'ANSWER', '자정 넘어 저장', kst('2026-10-21T00:20:00'));
      const snap = await store.load(o, '2026-10-20', kst('2026-10-21T00:21:00'));
      expect(snap!.interview.lifeDate).toBe('2026-10-20');
      expect(snap!.items).toHaveLength(1);
      expect(await store.load(o, '2026-10-21', kst('2026-10-21T00:21:00'))).toBeNull();
    });

    it('예시3: 10/21 00:40 시작 → 10/20 제안, 자정 이후 회고가 10/20에 저장', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T00:40:00');
      const { interview } = await store.startInterview(o, now);
      expect(interview.lifeDate).toBe('2026-10-20');
      await store.saveItem(o, interview.id, 'k1', 'ANSWER', '오늘 회고', now);
      expect((await store.load(o, '2026-10-20', now))!.items).toHaveLength(1);
      expect(await store.load(o, '2026-10-21', now)).toBeNull();
      expect(interview.startedAt.toISOString()).toBe(now.toISOString());
    });

    it('예시3b: 사용자가 수정해 당일(10/21)을 고를 수 있다', async () => {
      const o = newOwner();
      const { interview } = await store.startInterview(o, kst('2026-10-21T00:40:00'), '2026-10-21');
      expect(interview.lifeDate).toBe('2026-10-21');
    });

    it('예시4: 10/21 05:10 시작 → 당일 10/21', async () => {
      const o = newOwner();
      expect((await store.startInterview(o, kst('2026-10-21T05:10:00'))).interview.lifeDate).toBe('2026-10-21');
    });

    it('예시5: 10/22에 재개해도 10/20 유지, 재개 시각 별도 기록', async () => {
      const o = newOwner();
      const { interview } = await store.startInterview(o, kst('2026-10-20T22:30:00'));
      await store.saveItem(o, interview.id, 'k1', 'ANSWER', '첫 답', kst('2026-10-20T22:35:00'));
      const resumeAt = kst('2026-10-22T09:00:00');
      const snap = await store.resumeInterview(o, '2026-10-20', resumeAt);
      expect(snap.interview.lifeDate).toBe('2026-10-20');
      expect(snap.interview.startedAt.toISOString()).toBe(kst('2026-10-20T22:30:00').toISOString());
      expect(snap.resumes.map((d) => d.toISOString())).toEqual([resumeAt.toISOString()]);
      const again = await store.startInterview(o, resumeAt, '2026-10-20');
      expect(again.resumed).toBe(true);
      expect(again.interview.id).toBe(interview.id);
    });

    it('예시6: 확정 후 제작하면 revision 증가, 이전 계획 버전은 보존', async () => {
      const o = newOwner();
      const now = kst('2026-10-20T23:00:00');
      const { interview } = await store.startInterview(o, now);
      await rejects(store.startProduction(o, interview.id, { s: 0 }, now), 'INVALID_STATE');
      await store.confirm(o, interview.id, now);
      expect((await store.startProduction(o, interview.id, { s: 1 }, now)).revision).toBe(2);
      expect((await store.startProduction(o, interview.id, { s: 2 }, now)).revision).toBe(3);
      const snap = await store.load(o, '2026-10-20', now);
      expect(snap!.interview.revision).toBe(3);
      expect(snap!.interview.lifeDate).toBe('2026-10-20');
      expect(snap!.versions.filter((v) => v.kind === 'PRODUCTION_PLAN').map((v) => v.version)).toEqual([1, 2]);
    });

    it('예시7: 10/23 10:00에 기록 없는 10/21·10/22 신규 선택은 거부(행 생성 없음), 당일 10/23만 허용', async () => {
      const o = newOwner();
      const now = kst('2026-10-23T10:00:00');
      await rejects(store.startInterview(o, now, '2026-10-21'), 'EMPTY_PAST_DATE');
      await rejects(store.startInterview(o, now, '2026-10-24'), 'INVALID_LIFE_DATE');
      await rejects(store.startInterview(o, now, '2026-02-30'), 'INVALID_LIFE_DATE');
      await rejects(store.startInterview(o, now, '2026-10-22'), 'EMPTY_PAST_DATE');
      expect(await count('interviews', o)).toBe(0);
      expect((await store.startInterview(o, now, '2026-10-23')).interview.lifeDate).toBe('2026-10-23');
    });

    it('F11-03 경계: 00:40 전전날 거부, 04:59 전날 허용, 05:00 전날 거부', async () => {
      const o = newOwner();
      await rejects(store.startInterview(o, kst('2026-10-21T00:40:00'), '2026-10-19'), 'EMPTY_PAST_DATE');
      expect((await store.startInterview(o, kst('2026-10-21T04:59:00'), '2026-10-20')).interview.lifeDate).toBe('2026-10-20');
      expect((await store.startInterview(newOwner(), kst('2026-10-21T04:59:00'), '2026-10-21')).interview.lifeDate).toBe('2026-10-21');
      const o2 = newOwner();
      await rejects(store.startInterview(o2, kst('2026-10-21T05:00:00'), '2026-10-20'), 'EMPTY_PAST_DATE');
      expect(await count('interviews', o2)).toBe(0);
    });

    it('F11-03 기존 작성 중 기록은 허용 창을 지나도 원래 생활일로 재개되고 재개 시각이 별도 기록된다', async () => {
      const o = newOwner();
      const { interview } = await store.startInterview(o, kst('2026-10-20T22:30:00'));
      const later = kst('2026-10-23T09:00:00');
      const again = await store.startInterview(o, later, '2026-10-20');
      expect(again).toMatchObject({ resumed: true });
      expect(again.interview.id).toBe(interview.id);
      expect(again.interview.startedAt.toISOString()).toBe(kst('2026-10-20T22:30:00').toISOString());
      const snap = await store.load(o, '2026-10-20', later);
      expect(snap!.resumes.map((d) => d.toISOString())).toEqual([later.toISOString()]);
    });
  });

  describe('F11-01 동시 시작', () => {
    it('같은 소유자·신규 생활일 동시 8회 시작 → 모두 성공, 같은 id, 행 1개', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      const rs = await Promise.all(Array.from({ length: 8 }, () => store.startInterview(o, now)));
      expect(new Set(rs.map((r) => r.interview.id)).size).toBe(1);
      expect(rs.filter((r) => !r.resumed)).toHaveLength(1);
      expect(await count('interviews', o)).toBe(1);
      expect(await count('pipeline_states')).toBe(Number((await pool.query('SELECT count(*) FROM interviews')).rows[0].count));
    });
  });

  describe('F11-02 확정 후 저장', () => {
    it('확정된 기록에는 새 항목·첨부 저장이 거부되고 내용은 그대로, 같은 요청 재전송은 중복으로 응답', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      const { interview } = await store.startInterview(o, now);
      const item = await store.saveItem(o, interview.id, 'a', 'ANSWER', '확정 전', now);
      await store.confirm(o, interview.id, now);
      const before = await store.load(o, '2026-10-21', now);
      await rejects(store.saveItem(o, interview.id, 'b', 'ANSWER', '확정 후', now), 'CONFIRMED_LOCKED');
      await rejects(store.saveItem(o, interview.id, 'a', 'ANSWER', '덮어쓰기', now), 'IDEMPOTENCY_CONFLICT');
      await rejects(store.saveItemWithAttachment(o, interview.id, 'c', 'ANSWER', 'x', { storageKey: 's', checksum: 'c' }, now), 'CONFIRMED_LOCKED');
      await rejects(store.saveAttachment(o, interview.id, 'att', { itemId: item.id, storageKey: 's', checksum: 'c' }, now), 'CONFIRMED_LOCKED');
      expect((await store.saveItem(o, interview.id, 'a', 'ANSWER', '확정 전', now)).duplicate).toBe(true);
      expect(await store.load(o, '2026-10-21', now)).toEqual(before);
    });
  });

  describe('AC-3 반복 요청', () => {
    it('동시 8회 동일 요청 → 1건, seq 연속, 내용이 다르면 충돌, 타 소유자 거부', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      const { interview } = await store.startInterview(o, now);
      const rs = await Promise.all(Array.from({ length: 8 }, () => store.saveItem(o, interview.id, 'same', 'ANSWER', '내용', now)));
      expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(rs.map((r) => r.id)).size).toBe(1);
      for (let i = 2; i <= 5; i++) await store.saveItem(o, interview.id, `k${i}`, 'QUESTION', `q${i}`, now);
      await Promise.all(Array.from({ length: 4 }, (_, i) => store.saveItem(o, interview.id, `p${i}`, 'ANSWER', `p${i}`, now)));
      const items = (await store.load(o, '2026-10-21', now))!.items;
      expect(items).toHaveLength(9);
      expect(items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      await rejects(store.saveItem(o, interview.id, 'same', 'ANSWER', '다른 내용', now), 'IDEMPOTENCY_CONFLICT');
      await rejects(store.saveItem('someone-else', interview.id, 'x', 'ANSWER', 'x', now), 'NOT_FOUND');
    });

    it('첨부 재전송도 중복되지 않고 항목에 연결된다', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      const { interview } = await store.startInterview(o, now);
      const item = await store.saveItem(o, interview.id, 'a', 'ANSWER', '사진', now);
      const ref = { itemId: item.id, storageKey: 's/1.png', checksum: 'abc' };
      const rs = await Promise.all(Array.from({ length: 5 }, () => store.saveAttachment(o, interview.id, 'att1', ref, now)));
      expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
      await rejects(store.saveAttachment(o, interview.id, 'att1', { ...ref, checksum: 'zzz' }, now), 'IDEMPOTENCY_CONFLICT');
      await rejects(store.saveAttachment(o, interview.id, 'att2', { ...ref, itemId: '00000000-0000-4000-8000-000000000000' }, now), 'NOT_FOUND');
      const snap = await store.load(o, '2026-10-21', now);
      expect(snap!.attachments).toEqual([{ id: rs[0]!.id, itemId: item.id, storageKey: 's/1.png', checksum: 'abc', kind: 'PHOTO', name: null }]);
    });
  });

  describe('AC-4 빈 날짜', () => {
    it('조회·재개·만료 처리로 인터뷰/상태가 생성되지 않는다', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      expect(await store.load(o, '2026-10-21', now)).toBeNull();
      await rejects(store.resumeInterview(o, '2026-10-21', now), 'NOT_FOUND');
      await store.expireAudio(now);
      expect(await count('interviews', o)).toBe(0);
      const before = [await count('pipeline_states'), await count('record_versions')];
      await store.load(o, '2026-10-20', now);
      expect([await count('pipeline_states'), await count('record_versions')]).toEqual(before);
    });

    it('인터뷰 시작 시에도 제작·영상 상태는 NONE이고 결과 버전은 없다', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      await store.startInterview(o, now);
      const snap = await store.load(o, '2026-10-21', now);
      expect(snap!.pipeline).toEqual({ production: 'NONE', review: 'NONE', backup: 'NONE' });
      expect(snap!.versions).toEqual([]);
    });
  });

  describe('AC-5 임시 음성 보관', () => {
    it('최초 저장·만료 시각 불변, 재전송·재접속으로 연장되지 않고 만료 후 복구로 표시하지 않는다', async () => {
      const o = newOwner();
      const t0 = kst('2026-01-31T09:00:00');
      const { interview } = await store.startInterview(o, t0);
      const a = await store.saveAudioSegment(o, interview.id, 'seg1', t0);
      expect(a.firstSavedAt.toISOString()).toBe(t0.toISOString());
      expect(a.expiresAt.toISOString()).toBe(kst('2026-02-28T09:00:00').toISOString());
      expect(a.status).toBe('UNPROCESSED');

      await store.resumeInterview(o, '2026-01-31', kst('2026-02-20T09:00:00'));
      const again = await store.saveAudioSegment(o, interview.id, 'seg1', kst('2026-02-20T09:00:00'), 'INTERRUPTED');
      expect(again.duplicate).toBe(true);
      expect(again.expiresAt.toISOString()).toBe(a.expiresAt.toISOString());
      expect(again.firstSavedAt.toISOString()).toBe(t0.toISOString());
      expect(again.status).toBe('UNPROCESSED');

      const newPool = t.pool(); // 재접속
      const store2 = new RecordStore(newPool);
      const mid = kst('2026-02-27T23:59:59');
      const live = (await store2.load(o, '2026-01-31', mid))!.audio[0]!;
      expect(live).toMatchObject({ status: 'UNPROCESSED', recovered: true });
      expect(live.expiresAt.toISOString()).toBe(a.expiresAt.toISOString());

      await store2.setAudioStatus(o, interview.id, a.id, 'INTERRUPTED', mid);
      const after = kst('2026-02-28T09:00:00'); // 만료 시각 정각
      const exp = (await store2.load(o, '2026-01-31', after))!.audio[0]!;
      expect(exp).toMatchObject({ status: 'EXPIRED', recovered: false });
      await rejects(store2.setAudioStatus(o, interview.id, a.id, 'PROCESSED', after), 'AUDIO_EXPIRED');
      expect(await store2.expireAudio(after)).toBeGreaterThanOrEqual(0);
      const row = (await newPool.query('SELECT first_saved_at, expires_at, status FROM audio_segments WHERE id = $1', [a.id])).rows[0];
      expect(row.status).toBe('EXPIRED');
      expect(row.first_saved_at.toISOString()).toBe(t0.toISOString());
      expect(row.expires_at.toISOString()).toBe(a.expiresAt.toISOString());
      await newPool.end();
    });

    it('처리 상태 전이는 만료 전에만 허용', async () => {
      const o = newOwner();
      const t0 = kst('2026-10-21T10:00:00');
      const { interview } = await store.startInterview(o, t0);
      const a = await store.saveAudioSegment(o, interview.id, 'seg', t0);
      await store.setAudioStatus(o, interview.id, a.id, 'PROCESSED', kst('2026-10-21T10:05:00'));
      expect((await store.load(o, '2026-10-21', kst('2026-10-21T10:06:00')))!.audio[0]!.status).toBe('PROCESSED');
    });
  });

  describe('D11-04 제작·검수·백업 상태 분리', () => {
    it('개별 갱신 독립, 잘못된 값 거부, 재시작 후 보존', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      const { interview } = await store.startInterview(o, now);
      await store.setPipeline(o, interview.id, { review: 'PENDING' }, now);
      await store.setPipeline(o, interview.id, { backup: 'VERIFIED' }, now);
      await rejects(store.setPipeline(o, interview.id, { production: 'BOGUS' as never }, now), 'INVALID_STATE');
      const p2 = t.pool();
      const snap = await new RecordStore(p2).load(o, '2026-10-21', now);
      expect(snap!.pipeline).toEqual({ production: 'NONE', review: 'PENDING', backup: 'VERIFIED' });
      await p2.end();
    });

    it('요약 버전은 누적되고 동일 내용 재전송은 중복 생성하지 않는다', async () => {
      const o = newOwner();
      const now = kst('2026-10-21T10:00:00');
      const { interview } = await store.startInterview(o, now);
      expect((await store.appendVersion(o, interview.id, 'SUMMARY', { t: 'a' }, now)).version).toBe(1);
      expect((await store.appendVersion(o, interview.id, 'SUMMARY', { t: 'a' }, now)).duplicate).toBe(true);
      expect((await store.appendVersion(o, interview.id, 'SUMMARY', { t: 'b' }, now)).version).toBe(2);
    });
  });
});
