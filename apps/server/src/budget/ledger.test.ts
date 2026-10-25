import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTempSchema } from '../records/db.testutil.js';
import { buildVoiceApp } from '../voice/app.js';
import { mockTransports } from '../voice/mock.testutil.js';
import { TransportError } from '../voice/transports.js';
import { paidCall } from './gateway.js';
import { HARD_MONTHLY_LIMIT_KRW, MonthlyLedger, monthOf } from './ledger.js';

const url = process.env.DATABASE_URL;

describe('월 구분(서울)', () => {
  it('UTC 월말이어도 서울 기준 달로 센다', () => {
    expect(monthOf(new Date('2026-10-31T16:00:00Z'))).toBe('2026-11');
    expect(monthOf(new Date('2026-10-31T14:59:59Z'))).toBe('2026-10');
  });
  it('설정으로도 50,000원을 넘길 수 없다', () => {
    expect(new MonthlyLedger({} as pg.Pool, { limitKrw: 90000 }).limitKrw).toBe(HARD_MONTHLY_LIMIT_KRW);
  });
});

describe.skipIf(!url)('월 예산 원장 (실제 PostgreSQL 임시 스키마)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  // 시험마다 서로 다른 달을 써서 격리한다.
  let seq = 0;
  const fresh = () => {
    const month = `2030-${String(++seq).padStart(2, '0')}`;
    return new MonthlyLedger(pool, { clock: () => new Date(`${month}-15T12:00:00+09:00`) });
  };
  beforeAll(async () => { t = await createTempSchema(url!); pool = t.pool(); });
  afterAll(async () => { await pool.end(); await t.drop(); });

  const req = (estimateKrw: number, over: object = {}) => ({ provider: 'openai', operation: 'stt', purpose: 'PRODUCT' as const, estimateKrw, ...over });

  it('AC-1 한도 경계: 합계가 정확히 한도면 허용, 1원이라도 넘으면 거부하고 호출하지 않는다', async () => {
    const l = fresh();
    expect((await l.reserve(req(49999))).ok).toBe(true);
    expect((await l.reserve(req(1))).ok).toBe(true); // 합계 50,000 = 허용
    let ran = 0;
    const r = await paidCall({ ledger: l, provider: 'openai', operation: 'stt', purpose: 'PRODUCT', estimateKrw: 0.01, run: async () => { ran++; return 1; } });
    expect(r).toEqual({ ok: false, code: 'BUDGET_EXCEEDED' });
    expect(ran).toBe(0);
    expect((await l.snapshot()).committedKrw).toBe(50000);
  });

  it('AC-1 확정액이 예상보다 커도 사실대로 기록하고 이후 호출은 막는다', async () => {
    const l = fresh();
    const a = await l.reserve(req(100));
    if (!a.ok) throw new Error('x');
    await l.confirm(a.id, 49950);
    expect((await l.reserve(req(51))).ok).toBe(false);
    expect((await l.reserve(req(50))).ok).toBe(true);
  });

  it('AC-2 동시 요청 50건이 같은 잔여 예산을 중복 예약하지 않는다', async () => {
    const l = fresh();
    const rs = await Promise.all(Array.from({ length: 50 }, () => l.reserve(req(1500))));
    const ok = rs.filter((r) => r.ok).length;
    expect(ok).toBe(33); // floor(50000/1500)
    const s = await l.snapshot();
    expect(s.reservedKrw).toBe(33 * 1500);
    expect(s.committedKrw).toBeLessThanOrEqual(HARD_MONTHLY_LIMIT_KRW);
  });

  it('AC-2 같은 멱등키 동시 요청은 하나만 예약한다', async () => {
    const l = fresh();
    const rs = await Promise.all(Array.from({ length: 10 }, () => l.reserve(req(700, { idempotencyKey: `k-${seq}` }))));
    expect(new Set(rs.map((r) => (r.ok ? r.id : 'x'))).size).toBe(1);
    expect((await l.snapshot()).reservedKrw).toBe(700);
  });

  it('AC-3 재시도·테스트·제품 호출·이월분이 같은 원장 합계에 들어간다(비용 대조)', async () => {
    const l = fresh();
    const month = l.currentMonth();
    await l.recordCarryover(month, 1520, 'carry', '기존 서버 세션');
    expect(await l.recordCarryover(month, 1520, 'carry', '기존 서버 세션')).toBe(false); // 중복 입력 무시
    for (const [purpose, krw] of [['PRODUCT', 10], ['TEST', 20], ['RETRY', 30]] as const) {
      const r = await paidCall({ ledger: l, provider: 'gemini', operation: 'tts', purpose, estimateKrw: krw, run: async () => 1 });
      expect(r.ok).toBe(true);
    }
    const s = await l.snapshot();
    expect(s.byPurpose).toEqual({ CARRYOVER: 1520, PRODUCT: 10, TEST: 20, RETRY: 30 });
    expect(s.confirmedKrw).toBe(1580);
    // DB 직접 합계와 스냅샷 일치
    const sum = await pool.query("SELECT SUM(actual_krw) s FROM budget_entries WHERE month=$1 AND state='CONFIRMED'", [month]);
    expect(Number(sum.rows[0].s)).toBe(s.confirmedKrw);
  });

  it('AC-5 응답 유실(네트워크 오류)은 예약액을 유지하고 확인 전 환급하지 않는다', async () => {
    const l = fresh();
    const r = await paidCall({ ledger: l, provider: 'openai', operation: 'stt', purpose: 'PRODUCT', estimateKrw: 800, run: async () => { throw new Error('socket hang up'); } });
    expect(r).toMatchObject({ ok: false, code: 'CALL_UNKNOWN' });
    const id = (r as { entryId: string }).entryId;
    expect((await l.snapshot()).unknownKrw).toBe(800);
    expect(await l.releaseUnsent(id)).toBe(false); // 일반 해제 불가
    expect(await l.listUnknown()).toHaveLength(1);
    // 근거 없는 환급 거부
    await expect(l.resolveUnknown(id, { charged: false, evidence: ' ' })).rejects.toThrow();
    expect((await l.snapshot()).committedKrw).toBe(800);
    // 확인 후에만 환급
    expect(await l.resolveUnknown(id, { charged: false, evidence: '제공자 사용량 화면 확인' })).toBe(true);
    expect((await l.snapshot()).committedKrw).toBe(0);
  });

  it('AC-5 5xx·시간 초과도 불명, 4xx 명시 거절만 해제', async () => {
    const l = fresh();
    const run = (code: string) => paidCall({ ledger: l, provider: 'openai', operation: 'stt', purpose: 'PRODUCT', estimateKrw: 100, run: async () => { throw new TransportError(code); } });
    expect(await run('STT_HTTP_503')).toMatchObject({ code: 'CALL_UNKNOWN' });
    expect(await run('STT_HTTP_429')).toMatchObject({ code: 'CALL_REJECTED' });
    const s = await l.snapshot();
    expect(s.unknownKrw).toBe(100);
    expect(s.committedKrw).toBe(100);
  });

  it('AC-5 확인 결과 과금됐으면 확인된 금액으로 확정한다', async () => {
    const l = fresh();
    const r = await paidCall({ ledger: l, provider: 'openai', operation: 'stt', purpose: 'PRODUCT', estimateKrw: 100, run: async () => { throw new Error('timeout'); } });
    await l.resolveUnknown((r as { entryId: string }).entryId, { charged: true, actualKrw: 120, evidence: '청구 확인' });
    expect((await l.snapshot()).confirmedKrw).toBe(120);
  });

  describe('음성 서버 연동(같은 원장)', () => {
    const setup = async (o: Parameters<typeof mockTransports>[0] = {}) => {
      const m = mockTransports(o);
      const l = fresh();
      const app = buildVoiceApp({ transports: m.t, sessionDir: mkdtempSync(path.join(os.tmpdir(), 'dl-b-')), monthly: l, logger: false });
      const id = ((await app.inject({ method: 'POST', url: '/voice/api/sessions' })).json() as { id: string }).id;
      const turn = () => app.inject({ method: 'POST', url: `/voice/api/sessions/${id}/turns`, payload: Buffer.alloc(4000, 7), headers: { 'content-type': 'audio/webm', 'x-audio-duration-ms': '2000' } });
      return { l, m, turn };
    };

    it('AC-3 STT·TTS 호출이 월 원장에 확정으로 기록되고 세션 추정액과 일치한다', async () => {
      const { l, turn } = await setup();
      const r = await turn();
      expect(r.statusCode).toBe(200);
      const s = await l.snapshot();
      expect(s.confirmedKrw).toBeCloseTo(r.json().turn.metrics.estimatedCostKrw, 1);
      expect(s.byPurpose.TEST).toBeGreaterThan(0);
    });

    it('AC-1 월 잔여가 없으면 STT 호출 전에 중단한다', async () => {
      const { l, m, turn } = await setup();
      await l.recordCarryover(l.currentMonth(), HARD_MONTHLY_LIMIT_KRW, 'full', '소진');
      const r = await turn();
      expect(r.statusCode).toBe(402);
      expect(m.calls.stt).toBe(0);
    });

    it('AC-5 STT 응답이 유실되면 세션 응답은 실패지만 원장은 불명으로 점유한다', async () => {
      const { l, turn } = await setup({ sttThrows: true });
      expect((await turn()).statusCode).toBe(502);
      expect((await l.snapshot()).unknownKrw).toBeGreaterThan(0);
    });

    it('AC-4 Pro 한도(WAIT_LIMIT)에서는 TTS 등 다른 유료 호출·대체 경로가 호출되지 않는다', async () => {
      const { l, m, turn } = await setup({ pro: { state: 'WAIT_LIMIT' } });
      const r = await turn();
      expect(r.statusCode).toBe(503);
      expect(r.json().code).toBe('PRO_WAIT_LIMIT');
      expect(m.calls.pro).toBe(1); // 재시도·대체 호출 없음
      expect(m.calls.tts).toBe(0);
      const s = await l.snapshot();
      expect(s.byPurpose.PRODUCT ?? 0).toBe(0);
      const ops = await pool.query('SELECT DISTINCT operation FROM budget_entries WHERE month=$1', [l.currentMonth()]);
      expect(ops.rows.map((x) => x.operation)).toEqual(['stt']); // 별도 유료 모델 항목 없음
    });
  });
});
