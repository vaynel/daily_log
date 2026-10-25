import type pg from 'pg';

/** 관리자 결정: 테스트 포함 월 합계 50,000원 절대 초과 금지. 설정으로도 이 값을 넘길 수 없다. */
export const HARD_MONTHLY_LIMIT_KRW = 50000;

export type Purpose = 'PRODUCT' | 'TEST' | 'RETRY' | 'CARRYOVER';
export type EntryState = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'UNKNOWN';

export interface ReserveInput {
  provider: string;
  operation: string;
  purpose: Purpose;
  estimateKrw: number;
  /** 같은 키의 재요청은 새 예약을 만들지 않고 기존 항목을 돌려준다. */
  idempotencyKey?: string;
  note?: string;
}
export type ReserveResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; code: 'BUDGET_EXCEEDED'; remainingKrw: number };

export interface Snapshot {
  month: string;
  limitKrw: number;
  confirmedKrw: number;
  reservedKrw: number;
  unknownKrw: number;
  /** 확정 + 예약 + 불명. 새 호출 허용 여부는 이 값 기준이다. */
  committedKrw: number;
  remainingKrw: number;
  byPurpose: Record<string, number>;
}

/** 서울 시각 기준 'YYYY-MM'. */
export function monthOf(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
}

const num = (v: unknown) => Number(v);
const finiteNonNeg = (v: number) => Number.isFinite(v) && v >= 0;

// 항목의 현재 점유액: 확정은 실제액, 해제는 0, 예약·불명은 예상액(과소 계상 금지).
const HELD = `CASE state WHEN 'CONFIRMED' THEN actual_krw WHEN 'RELEASED' THEN 0 ELSE estimate_krw END`;

export class MonthlyLedger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly o: { limitKrw?: number; clock?: () => Date } = {},
  ) {
    const l = o.limitKrw ?? HARD_MONTHLY_LIMIT_KRW;
    if (!finiteNonNeg(l) || l <= 0) throw new Error('월 한도 값이 올바르지 않음');
  }

  get limitKrw() { return Math.min(this.o.limitKrw ?? HARD_MONTHLY_LIMIT_KRW, HARD_MONTHLY_LIMIT_KRW); }
  private now() { return (this.o.clock ?? (() => new Date()))(); }
  currentMonth() { return monthOf(this.now()); }

  /** 월 행을 잠가 같은 달 예약을 직렬화한다(동시 요청의 이중 예약 방지). */
  private async lockMonth(c: pg.PoolClient, month: string): Promise<number> {
    await c.query('INSERT INTO budget_months (month, limit_krw) VALUES ($1, $2) ON CONFLICT (month) DO NOTHING', [month, this.limitKrw]);
    const r = await c.query<{ limit_krw: string }>('SELECT limit_krw FROM budget_months WHERE month = $1 FOR UPDATE', [month]);
    // 저장된 월 한도와 설정 중 더 작은 값을 쓴다.
    return Math.min(num(r.rows[0]!.limit_krw), this.limitKrw);
  }

  private async committed(c: pg.PoolClient | pg.Pool, month: string): Promise<number> {
    const r = await c.query<{ s: string }>(`SELECT COALESCE(SUM(${HELD}), 0) AS s FROM budget_entries WHERE month = $1`, [month]);
    return num(r.rows[0]!.s);
  }

  async reserve(i: ReserveInput): Promise<ReserveResult> {
    if (!finiteNonNeg(i.estimateKrw)) throw new Error('예상액이 올바르지 않음');
    const month = this.currentMonth();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const limit = await this.lockMonth(c, month);
      if (i.idempotencyKey) {
        const ex = await c.query<{ id: string }>('SELECT id FROM budget_entries WHERE idempotency_key = $1', [i.idempotencyKey]);
        if (ex.rows[0]) { await c.query('COMMIT'); return { ok: true, id: ex.rows[0].id, duplicate: true }; }
      }
      const held = await this.committed(c, month);
      if (held + i.estimateKrw > limit) {
        await c.query('COMMIT');
        return { ok: false, code: 'BUDGET_EXCEEDED', remainingKrw: Math.max(0, limit - held) };
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO budget_entries (month, provider, operation, purpose, state, estimate_krw, idempotency_key, note)
         VALUES ($1,$2,$3,$4,'RESERVED',$5,$6,$7) RETURNING id`,
        [month, i.provider, i.operation, i.purpose, i.estimateKrw, i.idempotencyKey ?? null, (i.note ?? '').slice(0, 200)],
      );
      await c.query('COMMIT');
      return { ok: true, id: r.rows[0]!.id, duplicate: false };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** 실제(추정) 사용액으로 확정. 예상보다 커도 사실대로 기록한다(누적 사용량 갱신을 위해 재확정 허용). RELEASED 는 되살리지 않는다. */
  async confirm(id: string, actualKrw: number): Promise<boolean> {
    if (!finiteNonNeg(actualKrw)) throw new Error('실제액이 올바르지 않음');
    const r = await this.pool.query(
      `UPDATE budget_entries SET state='CONFIRMED', actual_krw=$2, settled_at=now() WHERE id=$1 AND state IN ('RESERVED','UNKNOWN','CONFIRMED')`,
      [id, actualKrw],
    );
    return r.rowCount === 1;
  }

  /** 호출이 외부로 나가지 않았음이 확실할 때만 해제(RESERVED 만). 불명 항목은 해제할 수 없다. */
  async releaseUnsent(id: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE budget_entries SET state='RELEASED', settled_at=now() WHERE id=$1 AND state='RESERVED'`, [id]);
    return r.rowCount === 1;
  }

  /** 호출 결과가 불명확(응답 유실·시간 초과 등). 예약액을 그대로 점유하고 확인 전 환급하지 않는다. */
  async markUnknown(id: string, note = ''): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE budget_entries SET state='UNKNOWN', note=left($2,200) WHERE id=$1 AND state='RESERVED'`, [id, note]);
    return r.rowCount === 1;
  }

  /**
   * 불명 항목을 제공자 사용량 확인 후 정산한다. 확인 근거(evidence)가 없으면 거부한다.
   * NOT_CHARGED 만 환급(0원)이고, CHARGED 는 확인된 금액으로 확정한다.
   */
  async resolveUnknown(id: string, outcome: { charged: false; evidence: string } | { charged: true; actualKrw: number; evidence: string }): Promise<boolean> {
    if (!outcome.evidence.trim()) throw new Error('확인 근거가 필요함');
    if (outcome.charged) {
      if (!finiteNonNeg(outcome.actualKrw)) throw new Error('실제액이 올바르지 않음');
      const r = await this.pool.query(
        `UPDATE budget_entries SET state='CONFIRMED', actual_krw=$2, note=left($3,200), settled_at=now() WHERE id=$1 AND state='UNKNOWN'`,
        [id, outcome.actualKrw, `확인: ${outcome.evidence}`]);
      return r.rowCount === 1;
    }
    const r = await this.pool.query(
      `UPDATE budget_entries SET state='RELEASED', note=left($2,200), settled_at=now() WHERE id=$1 AND state='UNKNOWN'`,
      [id, `확인: ${outcome.evidence}`]);
    return r.rowCount === 1;
  }

  /** 시스템 밖 기존 지출(이월분)을 기록한다. 이미 지출된 사실이므로 한도 검사 없이 넣되, 같은 키는 한 번만. */
  async recordCarryover(month: string, amountKrw: number, key: string, note: string): Promise<boolean> {
    if (!/^\d{4}-\d{2}$/.test(month) || !finiteNonNeg(amountKrw) || !key.trim()) throw new Error('이월 입력이 올바르지 않음');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.lockMonth(c, month);
      const r = await c.query(
        `INSERT INTO budget_entries (month, provider, operation, purpose, state, estimate_krw, actual_krw, idempotency_key, note, settled_at)
         VALUES ($1,'carryover','carryover','CARRYOVER','CONFIRMED',$2,$2,$3,$4,now()) ON CONFLICT (idempotency_key) DO NOTHING`,
        [month, amountKrw, key, note.slice(0, 200)]);
      await c.query('COMMIT');
      return r.rowCount === 1;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async snapshot(month = this.currentMonth()): Promise<Snapshot> {
    const r = await this.pool.query<{ state: string; purpose: string; s: string }>(
      `SELECT state, purpose, SUM(${HELD}) AS s FROM budget_entries WHERE month=$1 GROUP BY state, purpose`, [month]);
    let confirmed = 0, reserved = 0, unknown = 0;
    const byPurpose: Record<string, number> = {};
    for (const row of r.rows) {
      const v = num(row.s);
      if (row.state === 'CONFIRMED') confirmed += v; else if (row.state === 'RESERVED') reserved += v; else if (row.state === 'UNKNOWN') unknown += v;
      byPurpose[row.purpose] = (byPurpose[row.purpose] ?? 0) + v;
    }
    const committed = confirmed + reserved + unknown;
    return { month, limitKrw: this.limitKrw, confirmedKrw: confirmed, reservedKrw: reserved, unknownKrw: unknown, committedKrw: committed, remainingKrw: Math.max(0, this.limitKrw - committed), byPurpose };
  }

  async listUnknown() {
    const r = await this.pool.query<{ id: string; provider: string; operation: string; estimate_krw: string; created_at: Date }>(
      `SELECT id, provider, operation, estimate_krw, created_at FROM budget_entries WHERE state='UNKNOWN' ORDER BY created_at`);
    return r.rows.map((x) => ({ id: x.id, provider: x.provider, operation: x.operation, estimateKrw: num(x.estimate_krw), createdAt: x.created_at }));
  }
}
