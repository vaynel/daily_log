import type pg from 'pg';

export interface LiveUsage {
  interviewId: string;
  usedMs: number;
  costKrw: number;
  connections: number;
  status: 'OPEN' | 'ENDED';
  endReason: string | null;
}

/** 생활일 기록 1건당 실시간 대화 사용량. ENDED 면 그날 대화는 다시 시작할 수 없다(하루 1회). */
export interface LiveUsageStore {
  get(ownerId: string, interviewId: string): Promise<LiveUsage | null>;
  /** 없으면 만들고, 있으면 그대로. 연결 수만 올린다. */
  open(ownerId: string, interviewId: string, now: Date): Promise<LiveUsage>;
  /** 한 연결의 사용 시간·비용을 합산한다. endReason 이 있으면 그날 대화를 끝낸다(ENDED). */
  add(ownerId: string, interviewId: string, usedMs: number, costKrw: number, endReason: string | null, now: Date): Promise<LiveUsage>;
}

const toUsage = (r: Record<string, unknown>): LiveUsage => ({
  interviewId: r.interview_id as string, usedMs: Number(r.used_ms), costKrw: Number(r.cost_krw), connections: Number(r.connections),
  status: r.status as LiveUsage['status'], endReason: (r.end_reason as string | null) ?? null,
});

export class PgLiveUsageStore implements LiveUsageStore {
  constructor(private readonly pool: pg.Pool) {}
  async get(ownerId: string, interviewId: string) {
    const r = await this.pool.query('SELECT * FROM interview_live_usage WHERE interview_id = $1 AND owner_id = $2', [interviewId, ownerId]);
    return r.rows[0] ? toUsage(r.rows[0]) : null;
  }
  async open(ownerId: string, interviewId: string, now: Date) {
    await this.pool.query(
      `INSERT INTO interview_live_usage (interview_id, owner_id, created_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (interview_id) DO NOTHING`, [interviewId, ownerId, now]);
    const r = await this.pool.query(
      `UPDATE interview_live_usage SET connections = connections + 1, updated_at = $3
        WHERE interview_id = $1 AND owner_id = $2 RETURNING *`, [interviewId, ownerId, now]);
    if (!r.rows[0]) throw new Error('usage owner mismatch');
    return toUsage(r.rows[0]);
  }
  async add(ownerId: string, interviewId: string, usedMs: number, costKrw: number, endReason: string | null, now: Date) {
    const r = await this.pool.query(
      `UPDATE interview_live_usage SET used_ms = used_ms + $3, cost_krw = cost_krw + $4,
              status = CASE WHEN $5::text IS NULL THEN status ELSE 'ENDED' END,
              end_reason = COALESCE($5::text, end_reason), updated_at = $6
        WHERE interview_id = $1 AND owner_id = $2 RETURNING *`,
      [interviewId, ownerId, Math.max(0, Math.round(usedMs)), Math.max(0, costKrw), endReason, now]);
    if (!r.rows[0]) throw new Error('usage row missing');
    return toUsage(r.rows[0]);
  }
}

/** 시험·DB 없는 환경용. */
export class MemoryLiveUsageStore implements LiveUsageStore {
  readonly rows = new Map<string, LiveUsage & { ownerId: string }>();
  async get(ownerId: string, interviewId: string) {
    const r = this.rows.get(interviewId);
    return r && r.ownerId === ownerId ? { ...r } : null;
  }
  async open(ownerId: string, interviewId: string, _now?: Date) {
    void _now;
    const r = this.rows.get(interviewId) ?? { ownerId, interviewId, usedMs: 0, costKrw: 0, connections: 0, status: 'OPEN' as const, endReason: null };
    if (r.ownerId !== ownerId) throw new Error('usage owner mismatch');
    r.connections++;
    this.rows.set(interviewId, r);
    return { ...r };
  }
  async add(ownerId: string, interviewId: string, usedMs: number, costKrw: number, endReason: string | null, _now?: Date) {
    void _now;
    const r = this.rows.get(interviewId);
    if (!r || r.ownerId !== ownerId) throw new Error('usage row missing');
    r.usedMs += Math.max(0, Math.round(usedMs)); r.costKrw += Math.max(0, costKrw);
    if (endReason) { r.status = 'ENDED'; r.endReason ??= endReason; }
    return { ...r };
  }
}
