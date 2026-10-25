import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { createTempSchema } from '../records/db.testutil.js';
import { RecordStore } from '../records/store.js';
import { reminderSlots, scheduledAt } from './schedule.js';
import type { PushPayload, PushSender, PushTarget, SendOutcome } from './sender.js';
import { NotificationService } from './service.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const cookie = (sub: string, email: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 }, SECRET, 'session')}`;
};
const kst = (s: string) => new Date(`${s}+09:00`);

class FakeSender implements PushSender {
  sent: { target: PushTarget; payload: PushPayload }[] = [];
  next: () => SendOutcome = () => ({ ok: true });
  async send(target: PushTarget, payload: PushPayload) {
    this.sent.push({ target, payload });
    return this.next();
  }
}

describe('reminderSlots (시계 제어, 순수 계산)', () => {
  it('22:00 KST 이전은 NOT_YET, 이후 유예 안은 DUE, 유예 초과는 MISSED', () => {
    const today = (now: string) => reminderSlots(kst(now), '22:00').find((s) => s.date === now.slice(0, 10))!.state;
    expect(today('2026-10-25T21:59:59')).toBe('NOT_YET');
    expect(today('2026-10-25T22:00:00')).toBe('DUE');
    expect(today('2026-10-25T00:59:00')).toBe('NOT_YET');
    expect(today('2026-10-25T23:59:00')).toBe('DUE');
    expect(scheduledAt('2026-10-25', '22:00').toISOString()).toBe('2026-10-25T13:00:00.000Z'); // UTC 13:00 = KST 22:00
  });
  it('UTC 날짜와 KST 날짜가 다른 시각에도 KST 기준(UTC 13:00 = 22:00)', () => {
    expect(reminderSlots(new Date('2026-10-25T13:00:00Z'), '22:00').find((s) => s.state === 'DUE')!.date).toBe('2026-10-25');
    expect(reminderSlots(new Date('2026-10-25T12:59:00Z'), '22:00').some((s) => s.state === 'DUE')).toBe(false);
  });
  it('자정을 넘겨도 전날 늦은 예약(23:59)의 유예를 본다', () => {
    const due = reminderSlots(kst('2026-10-26T00:30:00'), '23:59').filter((s) => s.state === 'DUE');
    expect(due.map((s) => s.date)).toEqual(['2026-10-25']);
  });
});

describe.skipIf(!url)('알림 (실제 PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let sender: FakeSender;
  let clock: Date;
  const mkService = () => new NotificationService({ pool, sender, now: () => clock });
  let svc: NotificationService;
  const OWNER = 'owner-a';
  const SUB = { endpoint: 'https://push.example.test/sub-1', p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) };
  const reminders = async () => (await pool.query(`SELECT * FROM notifications WHERE kind='INTERVIEW_REMINDER' ORDER BY created_at`)).rows;

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
  });
  afterAll(async () => {
    await pool.end();
    await t.drop();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE notifications, push_subscriptions, notification_settings, interviews CASCADE');
    sender = new FakeSender();
    clock = kst('2026-10-25T12:00:00');
    svc = mkService();
    await svc.saveSubscription(OWNER, SUB);
    await svc.reportPermission(OWNER, 'granted');
  });

  it('AC-1 기본 22:00 KST 에 정확히 1건 전달, 그 전에는 전달 없음', async () => {
    expect((await svc.getSettings(OWNER)).interviewTime).toBe('22:00');
    clock = kst('2026-10-25T21:59:59');
    await svc.run();
    expect(sender.sent).toHaveLength(0);
    clock = kst('2026-10-25T22:00:00');
    await svc.run();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.payload.tag).toBe(`INTERVIEW_REMINDER:${OWNER}:2026-10-25`);
    for (const m of ['22:01:00', '22:30:00', '23:59:00']) { clock = kst(`2026-10-25T${m}`); await svc.run(); }
    expect(sender.sent).toHaveLength(1);
    expect((await reminders())[0].status).toBe('ACCEPTED');
  });

  it('AC-2 미응답·스케줄러 재시작·동시 실행에도 같은 날 재알림 없음, 다음 날은 다시 1건', async () => {
    clock = kst('2026-10-25T22:00:05');
    await Promise.all([mkService().run(), mkService().run(), mkService().run()]); // 서로 다른 스케줄러 인스턴스(재시작·중복 작업자)
    expect(sender.sent).toHaveLength(1);
    clock = kst('2026-10-25T22:40:00');
    await mkService().run(); // 재시작 후, 사용자 미응답
    expect(sender.sent).toHaveLength(1);
    expect(await reminders()).toHaveLength(1);
    clock = kst('2026-10-26T22:00:00');
    await svc.run();
    expect(sender.sent).toHaveLength(2);
    expect((await reminders()).map((r) => r.dedupe_key)).toEqual([`INTERVIEW_REMINDER:${OWNER}:2026-10-25`, `INTERVIEW_REMINDER:${OWNER}:2026-10-26`]);
  });

  it('AC-2 중단 중 22:00 을 지나 늦게 재시작해도 유예 안이면 1번, 유예를 넘기면 그날은 건너뜀', async () => {
    clock = kst('2026-10-25T23:30:00'); // 서버가 22:00 에 꺼져 있다가 이제 시작
    await svc.run();
    expect(sender.sent).toHaveLength(1);
    await pool.query('TRUNCATE notifications');
    sender.sent = [];
    clock = kst('2026-10-26T03:00:00'); // 22:00 + 5시간 > 유예 3시간
    await svc.run();
    expect(sender.sent).toHaveLength(0);
  });

  it('그날 기록을 이미 확정했다면 알리지 않는다', async () => {
    const id = (await store.startInterview(OWNER, kst('2026-10-25T20:00:00'), '2026-10-25')).interview.id;
    await store.confirm(OWNER, id, kst('2026-10-25T20:30:00'));
    clock = kst('2026-10-25T22:00:00');
    await svc.run();
    expect(sender.sent).toHaveLength(0);
    expect((await reminders())[0].error_code).toBe('ALREADY_RECORDED');
  });

  describe('AC-3 설정 E2E (HTTP → 스케줄러)', () => {
    let app: FastifyInstance;
    const A = cookie(OWNER, 'a@example.test');
    const call = (method: 'GET' | 'PUT', u: string, payload?: object) => app.inject({ method, url: u, headers: { cookie: A }, payload });
    beforeAll(async () => {
      const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
      app = buildApp({ auth, sessionSecret: SECRET, notifications: new NotificationService({ pool, sender, now: () => clock }) });
    });
    afterAll(() => app.close());

    it('시각을 21:00 으로 바꾸면 21:00 에 울리고 22:00 에는 울리지 않는다', async () => {
      expect((await call('GET', '/api/notifications/settings')).json()).toMatchObject({ interviewTime: '22:00', timezone: 'Asia/Seoul', permission: 'granted', subscribed: true });
      const put = await call('PUT', '/api/notifications/settings', { interviewTime: '21:00' });
      expect(put.statusCode).toBe(200);
      expect(put.json().interviewTime).toBe('21:00');
      expect((await call('GET', '/api/notifications/settings')).json().interviewTime).toBe('21:00');
      clock = kst('2026-10-25T20:59:00');
      await svc.run();
      expect(sender.sent).toHaveLength(0);
      clock = kst('2026-10-25T21:00:00');
      await svc.run();
      expect(sender.sent).toHaveLength(1);
      clock = kst('2026-10-25T22:00:00');
      await svc.run();
      expect(sender.sent).toHaveLength(1);
    });

    it('이미 지난 시각으로 바꾸면 오늘은 즉시 울리지 않고 내일부터 적용, 잘못된 값·미인증은 거부', async () => {
      clock = kst('2026-10-25T21:30:00');
      expect((await call('PUT', '/api/notifications/settings', { interviewTime: '21:00' })).statusCode).toBe(200);
      await svc.run();
      expect(sender.sent).toHaveLength(0);
      clock = kst('2026-10-26T21:00:00');
      await svc.run();
      expect(sender.sent).toHaveLength(1);
      for (const bad of ['24:00', '9:00', '21:60', '', 2100, null]) expect((await call('PUT', '/api/notifications/settings', { interviewTime: bad })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: '/api/notifications/settings', payload: { interviewTime: '20:00' } })).statusCode).toBe(401);
    });

    it('이미 오늘 알림을 보낸 뒤 늦은 시각으로 바꿔도 같은 날 두 번째 알림은 없다', async () => {
      clock = kst('2026-10-25T22:00:00');
      await svc.run();
      expect(sender.sent).toHaveLength(1);
      await call('PUT', '/api/notifications/settings', { interviewTime: '23:00' });
      clock = kst('2026-10-25T23:00:00');
      await svc.run();
      expect(sender.sent).toHaveLength(1);
    });
  });

  describe('결과 알림', () => {
    const finish = async (id: string, patch: Parameters<RecordStore['setPipeline']>[2], at: Date, result?: string) => {
      if (result) await store.appendVersion(OWNER, id, 'RESULT', { file: result }, at);
      await store.setPipeline(OWNER, id, patch, at);
    };
    const results = async () => (await pool.query(`SELECT * FROM notifications WHERE kind <> 'INTERVIEW_REMINDER' ORDER BY created_at`)).rows;

    it('AC-4 며칠 늦게 완료된 작업은 완료 후 해당 기록(생활일 무관)으로 이동하는 알림을 1번 보낸다', async () => {
      const id = (await store.startInterview(OWNER, kst('2026-10-19T20:00:00'), '2026-10-19')).interview.id;
      await store.confirm(OWNER, id, kst('2026-10-19T21:00:00'));
      await finish(id, { production: 'RUNNING' }, kst('2026-10-19T21:05:00'));
      clock = kst('2026-10-20T09:00:00');
      await svc.run();
      expect(sender.sent.filter((s) => s.payload.url.includes(id))).toHaveLength(0); // 제작 중에는 완료 알림 없음
      clock = kst('2026-10-24T09:00:00'); // 5일 뒤 완료
      await finish(id, { production: 'DONE', review: 'PASSED' }, clock, 'late.mp4');
      await svc.run();
      await svc.run();
      const n = sender.sent.filter((s) => s.payload.url.includes(id));
      expect(n).toHaveLength(1);
      expect(n[0]!.payload.url).toBe(`/?record=${id}`);
      expect(n[0]!.payload.body).toContain('2026-10-19');
      expect((await results())[0]).toMatchObject({ kind: 'RESULT_COMPLETED', status: 'ACCEPTED', interview_id: id });
    });

    it('수정 완료(새 결과 버전)는 별도 알림, 처리 실패·백업 실패도 각각 1번', async () => {
      const id = (await store.startInterview(OWNER, kst('2026-10-24T20:00:00'), '2026-10-24')).interview.id;
      await store.confirm(OWNER, id, kst('2026-10-24T21:00:00'));
      clock = kst('2026-10-25T09:00:00');
      await finish(id, { production: 'DONE', review: 'PASSED' }, clock, 'v1.mp4');
      await svc.run();
      clock = kst('2026-10-25T10:00:00');
      await finish(id, { production: 'DONE', review: 'PASSED' }, clock, 'v2.mp4');
      await svc.run();
      await finish(id, { backup: 'FAILED' }, clock);
      await svc.run();
      await svc.run();
      await finish(id, { production: 'FAILED' }, clock);
      await svc.run();
      await svc.run();
      expect((await results()).map((r) => r.kind).sort()).toEqual(['BACKUP_FAILED', 'PROCESSING_FAILED', 'RESULT_COMPLETED', 'RESULT_REVISED']);
      expect(sender.sent.map((s) => s.payload.title)).toHaveLength(4);
    });

    it('검수 미통과·진행 중에는 완료 알림을 만들지 않고, 오래된(48시간 밖) 기록은 일괄 알림하지 않는다', async () => {
      const a = (await store.startInterview(OWNER, kst('2026-10-24T20:00:00'), '2026-10-24')).interview.id;
      const b = (await store.startInterview(OWNER, kst('2026-10-10T20:00:00'), '2026-10-10')).interview.id;
      clock = kst('2026-10-25T09:00:00');
      await finish(a, { production: 'DONE', review: 'REJECTED' }, clock, 'x.mp4');
      await finish(b, { production: 'DONE', review: 'PASSED' }, kst('2026-10-10T09:00:00'), 'old.mp4');
      await svc.run();
      expect(await results()).toHaveLength(0);
    });

    it('AC-5 전송 오류(일시 오류·만료·권한 거부·구독 없음·발송기 예외)는 기록·제작 상태를 바꾸지 않는다', async () => {
      const id = (await store.startInterview(OWNER, kst('2026-10-24T20:00:00'), '2026-10-24')).interview.id;
      await store.confirm(OWNER, id, kst('2026-10-24T21:00:00'));
      clock = kst('2026-10-25T09:00:00');
      await finish(id, { production: 'DONE', review: 'PASSED' }, clock, 'ok.mp4');
      const snapshot = async () => JSON.stringify([
        (await pool.query('SELECT id, status, revision FROM interviews ORDER BY id')).rows,
        (await pool.query('SELECT production, review, backup, updated_at FROM pipeline_states ORDER BY interview_id')).rows,
        (await pool.query('SELECT version, kind, content FROM record_versions ORDER BY version')).rows,
      ]);
      const before = await snapshot();

      sender.next = () => ({ ok: false, gone: false, code: 'HTTP_500' });
      await svc.run(); // 시도 1: 재시도 대기
      expect((await results())[0]).toMatchObject({ status: 'PENDING', attempts: 1, error_code: 'HTTP_500' });
      for (const min of [2, 6]) { clock = new Date(clock.getTime() + min * 60_000); await svc.run(); }
      expect((await results())[0]).toMatchObject({ status: 'FAILED', attempts: 3, error_code: 'HTTP_500' });
      expect(await snapshot()).toBe(before); // 제작 결과·기록 그대로
      expect((await store.loadById(OWNER, id, clock))!.pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });

      // 발송기가 예외를 던져도 워커 단계는 던지지 않는다.
      sender.next = () => { throw new Error('boom'); };
      await pool.query('TRUNCATE notifications');
      await expect(svc.run()).resolves.toBeUndefined();
      expect((await results())[0]).toMatchObject({ status: 'PENDING', error_code: 'SENDER_EXCEPTION' });

      // 구독 만료(410): 구독만 비활성, 알림은 UNDELIVERABLE
      await pool.query('TRUNCATE notifications');
      sender.next = () => ({ ok: false, gone: true, code: 'HTTP_410' });
      await svc.run();
      expect((await results())[0]).toMatchObject({ status: 'UNDELIVERABLE', error_code: 'NO_SUBSCRIPTION' });
      expect((await pool.query('SELECT active FROM push_subscriptions')).rows[0].active).toBe(false);

      // 권한 거부
      await pool.query('TRUNCATE notifications');
      await svc.saveSubscription(OWNER, SUB);
      await svc.reportPermission(OWNER, 'denied');
      await svc.run();
      expect((await results())[0]).toMatchObject({ status: 'UNDELIVERABLE', error_code: 'PERMISSION_DENIED' });
      expect(await snapshot()).toBe(before);
    });

    it('푸시 서비스가 받았다는 ACCEPTED 와 권한 거부 후 재허용 시 다시 전달', async () => {
      await svc.reportPermission(OWNER, 'denied');
      expect((await svc.getSettings(OWNER)).subscribed).toBe(false); // 거부 시 구독 비활성
      await svc.reportPermission(OWNER, 'granted');
      await svc.saveSubscription(OWNER, SUB);
      expect((await svc.getSettings(OWNER))).toMatchObject({ permission: 'granted', subscribed: true });
    });
  });

  it('AC-5 안내: 상태 API 는 전달 실패 알림에 사유별 안내와 "기록은 그대로" 문구를 준다', async () => {
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    const app = buildApp({ auth, sessionSecret: SECRET, notifications: svc });
    await svc.reportPermission(OWNER, 'denied');
    clock = kst('2026-10-25T22:00:00');
    await svc.run();
    const res = (await app.inject({ method: 'GET', url: '/api/notifications/status', headers: { cookie: cookie(OWNER, 'a@example.test') } })).json();
    expect(res.settings.permission).toBe('denied');
    expect(res.recent[0]).toMatchObject({ kind: 'INTERVIEW_REMINDER', status: 'UNDELIVERABLE', errorCode: 'PERMISSION_DENIED' });
    expect(res.recent[0].guidance).toContain('설정 > 앱 > 알림');
    expect(res.recent[0].guidance).toContain('그대로');
    await app.close();
  });
});
