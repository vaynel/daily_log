import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { addCalendarMonthSeoul, addDays, isValidDate, seoulDate, suggestLifeDate } from './time.js';

export type RecordErrorCode =
  | 'INVALID_LIFE_DATE'
  | 'EMPTY_PAST_DATE'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE'
  | 'AUDIO_EXPIRED';

export class RecordError extends Error {
  constructor(public readonly code: RecordErrorCode, message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

export type ItemKind = 'QUESTION' | 'ANSWER';
export type VersionKind = 'SUMMARY' | 'PRODUCTION_PLAN' | 'RESULT';
export type AudioStatus = 'UNPROCESSED' | 'INTERRUPTED' | 'PROCESSED' | 'EXPIRED';
export interface PipelineState {
  production: 'NONE' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  review: 'NONE' | 'PENDING' | 'PASSED' | 'REJECTED';
  backup: 'NONE' | 'PENDING' | 'VERIFIED' | 'FAILED';
}

export interface Interview {
  id: string;
  ownerId: string;
  lifeDate: string;
  startedAt: Date;
  status: 'IN_PROGRESS' | 'CONFIRMED';
  revision: number;
}

export interface Snapshot {
  interview: Interview;
  resumes: Date[];
  items: { id: string; seq: number; kind: ItemKind; body: string }[];
  attachments: { id: string; itemId: string | null; storageKey: string; checksum: string }[];
  versions: { kind: VersionKind; version: number; content: unknown }[];
  pipeline: PipelineState;
  audio: AudioView[];
}

export interface AudioView {
  id: string;
  firstSavedAt: Date;
  expiresAt: Date;
  status: AudioStatus;
  /** 만료된 구간은 절대 복구된 것으로 표시하지 않는다. */
  recovered: boolean;
}

export interface StoreOptions {
  /** 테스트용: 트랜잭션 중간(항목 저장 직후, 첨부 저장 직전)에 호출된다. */
  afterItemInsert?: () => Promise<void>;
}

type Q = pg.PoolClient;

function toInterview(r: Record<string, unknown>): Interview {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    lifeDate: r.life_date as string,
    startedAt: r.started_at as Date,
    status: r.status as Interview['status'],
    revision: r.revision as number,
  };
}

const LIFE_DATE_SQL = "to_char(life_date, 'YYYY-MM-DD')";
const INTERVIEW_COLS = `id, owner_id, ${LIFE_DATE_SQL} AS life_date, started_at, status, revision`;

/**
 * 생활일별 기록 저장소. 모든 시각은 호출자가 주입한 now를 사용한다(시계 제어 가능).
 * 인터뷰가 없는 날짜에는 어떤 행도 만들지 않는다.
 */
export class RecordStore {
  constructor(private readonly pool: pg.Pool, private readonly opts: StoreOptions = {}) {}

  private async tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** 소유자의 인터뷰를 잠그고 반환. 없거나 타 소유자면 NOT_FOUND. */
  private async lock(c: Q, ownerId: string, interviewId: string): Promise<Interview> {
    const r = await c.query(`SELECT ${INTERVIEW_COLS} FROM interviews WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [interviewId, ownerId]);
    if (!r.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
    return toInterview(r.rows[0]);
  }

  /** 새 인터뷰에서 선택할 수 있는 생활일: 제안일, 그 전날, 오늘(서울) 달력일. */
  allowedNewLifeDates(now: Date): string[] {
    const s = suggestLifeDate(now);
    return [...new Set([s, addDays(s, -1), seoulDate(now)])].sort();
  }

  /**
   * 인터뷰 시작. lifeDate 생략 시 05:00 KST 규칙의 제안일.
   * 같은 생활일의 기록이 이미 있으면 이어보기(재개 시각만 별도 기록, 생활일 불변).
   * 기록이 없는 과거·미래 날짜의 신규 생성은 거부한다.
   */
  async startInterview(ownerId: string, now: Date, lifeDate?: string): Promise<{ interview: Interview; resumed: boolean }> {
    const date = lifeDate ?? suggestLifeDate(now);
    if (!isValidDate(date)) throw new RecordError('INVALID_LIFE_DATE', '생활일 형식 오류');
    return this.tx(async (c) => {
      const existing = await c.query(`SELECT ${INTERVIEW_COLS} FROM interviews WHERE owner_id = $1 AND life_date = $2 FOR UPDATE`, [ownerId, date]);
      if (existing.rows[0]) {
        const iv = toInterview(existing.rows[0]);
        await c.query('INSERT INTO interview_resumes (interview_id, resumed_at) VALUES ($1, $2)', [iv.id, now]);
        return { interview: iv, resumed: true };
      }
      if (date > seoulDate(now)) throw new RecordError('INVALID_LIFE_DATE', '미래 생활일은 선택할 수 없음');
      if (!this.allowedNewLifeDates(now).includes(date)) throw new RecordError('EMPTY_PAST_DATE', '기록이 없는 과거 날짜는 새로 만들 수 없음');
      const id = randomUUID();
      const ins = await c.query(
        `INSERT INTO interviews (id, owner_id, life_date, started_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $4)
         RETURNING ${INTERVIEW_COLS}`,
        [id, ownerId, date, now],
      );
      await c.query('INSERT INTO pipeline_states (interview_id, updated_at) VALUES ($1, $2)', [id, now]);
      return { interview: toInterview(ins.rows[0]), resumed: false };
    });
  }

  /** 재접속 이어하기. 생활일은 원래 값 유지, 실제 재개 시각만 기록. 기록이 없으면 NOT_FOUND(자동 생성 금지). */
  async resumeInterview(ownerId: string, lifeDate: string, now: Date): Promise<Snapshot> {
    await this.tx(async (c) => {
      const r = await c.query('SELECT id FROM interviews WHERE owner_id = $1 AND life_date = $2 FOR UPDATE', [ownerId, lifeDate]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '해당 생활일의 기록이 없음');
      await c.query('INSERT INTO interview_resumes (interview_id, resumed_at) VALUES ($1, $2)', [r.rows[0].id, now]);
    });
    const snap = await this.load(ownerId, lifeDate, now);
    if (!snap) throw new RecordError('NOT_FOUND', '해당 생활일의 기록이 없음');
    return snap;
  }

  /** 읽기 전용 조회. 어떤 경우에도 행을 만들지 않는다. */
  async load(ownerId: string, lifeDate: string, now: Date): Promise<Snapshot | null> {
    const r = await this.pool.query(`SELECT ${INTERVIEW_COLS} FROM interviews WHERE owner_id = $1 AND life_date = $2`, [ownerId, lifeDate]);
    if (!r.rows[0]) return null;
    const interview = toInterview(r.rows[0]);
    const id = interview.id;
    const [resumes, items, atts, vers, pipe, audio] = await Promise.all([
      this.pool.query('SELECT resumed_at FROM interview_resumes WHERE interview_id = $1 ORDER BY id', [id]),
      this.pool.query('SELECT id, seq, kind, body FROM conversation_items WHERE interview_id = $1 ORDER BY seq', [id]),
      this.pool.query('SELECT id, item_id, storage_key, checksum FROM attachment_refs WHERE interview_id = $1 ORDER BY saved_at, id', [id]),
      this.pool.query('SELECT kind, version, content FROM record_versions WHERE interview_id = $1 ORDER BY kind, version', [id]),
      this.pool.query('SELECT production, review, backup FROM pipeline_states WHERE interview_id = $1', [id]),
      this.pool.query('SELECT id, first_saved_at, expires_at, status FROM audio_segments WHERE interview_id = $1 ORDER BY first_saved_at, id', [id]),
    ]);
    return {
      interview,
      resumes: resumes.rows.map((x) => x.resumed_at as Date),
      items: items.rows.map((x) => ({ id: x.id, seq: x.seq, kind: x.kind, body: x.body })),
      attachments: atts.rows.map((x) => ({ id: x.id, itemId: x.item_id, storageKey: x.storage_key, checksum: x.checksum })),
      versions: vers.rows.map((x) => ({ kind: x.kind, version: x.version, content: x.content })),
      pipeline: pipe.rows[0] as PipelineState,
      audio: audio.rows.map((x) => viewAudio(x, now)),
    };
  }

  /** 대화 항목 저장(멱등). 같은 키·같은 내용 재전송은 기존 항목 반환, 내용이 다르면 충돌. */
  async saveItem(ownerId: string, interviewId: string, key: string, kind: ItemKind, body: string, now: Date) {
    return this.tx((c) => this.insertItem(c, ownerId, interviewId, key, kind, body, now));
  }

  private async insertItem(c: Q, ownerId: string, interviewId: string, key: string, kind: ItemKind, body: string, now: Date) {
    await this.lock(c, ownerId, interviewId);
    const ex = await c.query('SELECT id, seq, kind, body FROM conversation_items WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
    if (ex.rows[0]) {
      if (ex.rows[0].kind !== kind || ex.rows[0].body !== body) throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 내용');
      return { id: ex.rows[0].id as string, seq: ex.rows[0].seq as number, duplicate: true };
    }
    const id = randomUUID();
    const r = await c.query(
      `INSERT INTO conversation_items (id, interview_id, seq, idempotency_key, kind, body, saved_at)
       VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_items WHERE interview_id = $2), $3, $4, $5, $6) RETURNING seq`,
      [id, interviewId, key, kind, body, now],
    );
    await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
    return { id, seq: r.rows[0].seq as number, duplicate: false };
  }

  /** 첨부 참조 저장(멱등). itemId가 있으면 해당 대화 항목에 연결. */
  async saveAttachment(ownerId: string, interviewId: string, key: string, ref: { itemId?: string; storageKey: string; checksum: string }, now: Date) {
    return this.tx((c) => this.insertAttachment(c, ownerId, interviewId, key, ref, now));
  }

  private async insertAttachment(c: Q, ownerId: string, interviewId: string, key: string, ref: { itemId?: string; storageKey: string; checksum: string }, now: Date) {
    await this.lock(c, ownerId, interviewId);
    const ex = await c.query('SELECT id, item_id, storage_key, checksum FROM attachment_refs WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
    if (ex.rows[0]) {
      const x = ex.rows[0];
      if (x.storage_key !== ref.storageKey || x.checksum !== ref.checksum || (x.item_id ?? null) !== (ref.itemId ?? null)) {
        throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 첨부');
      }
      return { id: x.id as string, duplicate: true };
    }
    if (ref.itemId) {
      const it = await c.query('SELECT 1 FROM conversation_items WHERE id = $1 AND interview_id = $2', [ref.itemId, interviewId]);
      if (!it.rows[0]) throw new RecordError('NOT_FOUND', '연결할 대화 항목이 없음');
    }
    const id = randomUUID();
    await c.query(
      'INSERT INTO attachment_refs (id, interview_id, item_id, idempotency_key, storage_key, checksum, saved_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, interviewId, ref.itemId ?? null, key, ref.storageKey, ref.checksum, now],
    );
    await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
    return { id, duplicate: false };
  }

  /** 항목과 첨부를 한 트랜잭션으로 저장. 중간에 프로세스가 죽으면 둘 다 남지 않는다. */
  async saveItemWithAttachment(
    ownerId: string, interviewId: string, key: string, kind: ItemKind, body: string,
    att: { storageKey: string; checksum: string }, now: Date,
  ) {
    return this.tx(async (c) => {
      const item = await this.insertItem(c, ownerId, interviewId, key, kind, body, now);
      await this.opts.afterItemInsert?.();
      const attachment = await this.insertAttachment(c, ownerId, interviewId, `${key}:att`, { itemId: item.id, ...att }, now);
      return { item, attachment };
    });
  }

  /** 요약·제작 계획·결과를 새 버전으로 누적(멱등 키 없이 내용 동일 최신본은 중복 생성하지 않음). */
  async appendVersion(ownerId: string, interviewId: string, kind: VersionKind, content: unknown, now: Date) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const last = await c.query('SELECT version, content FROM record_versions WHERE interview_id = $1 AND kind = $2 ORDER BY version DESC LIMIT 1', [interviewId, kind]);
      if (last.rows[0] && JSON.stringify(last.rows[0].content) === JSON.stringify(content)) return { version: last.rows[0].version as number, duplicate: true };
      const version = ((last.rows[0]?.version as number | undefined) ?? 0) + 1;
      await c.query('INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), interviewId, kind, version, JSON.stringify(content), now]);
      return { version, duplicate: false };
    });
  }

  /** 사용자가 브리핑을 확정. 확정 후 생활일은 자동으로 바뀌지 않는다. */
  async confirm(ownerId: string, interviewId: string, now: Date) {
    return this.tx(async (c) => {
      const iv = await this.lock(c, ownerId, interviewId);
      if (iv.status === 'CONFIRMED') return { revision: iv.revision, duplicate: true };
      await c.query("UPDATE interviews SET status = 'CONFIRMED', updated_at = $2 WHERE id = $1", [interviewId, now]);
      return { revision: iv.revision, duplicate: false };
    });
  }

  /** 확정된 기록으로 (재)제작할 때 revision을 올린다. 조용한 덮어쓰기 없음. */
  async startProduction(ownerId: string, interviewId: string, plan: unknown, now: Date) {
    return this.tx(async (c) => {
      const iv = await this.lock(c, ownerId, interviewId);
      if (iv.status !== 'CONFIRMED') throw new RecordError('INVALID_STATE', '확정되지 않은 기록은 제작할 수 없음');
      const revision = iv.revision + 1;
      await c.query('UPDATE interviews SET revision = $2, updated_at = $3 WHERE id = $1', [interviewId, revision, now]);
      const last = await c.query("SELECT COALESCE(MAX(version), 0) AS v FROM record_versions WHERE interview_id = $1 AND kind = 'PRODUCTION_PLAN'", [interviewId]);
      await c.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'PRODUCTION_PLAN',$3,$4,$5)", [randomUUID(), interviewId, (last.rows[0].v as number) + 1, JSON.stringify(plan), now]);
      await c.query("UPDATE pipeline_states SET production = 'QUEUED', updated_at = $2 WHERE interview_id = $1", [interviewId, now]);
      return { revision };
    });
  }

  /** 제작·검수·백업 상태를 각각 독립적으로 갱신. 지정하지 않은 상태는 그대로 둔다. */
  async setPipeline(ownerId: string, interviewId: string, patch: Partial<PipelineState>, now: Date) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      for (const col of ['production', 'review', 'backup'] as const) {
        const v = patch[col];
        if (v === undefined) continue;
        try {
          await c.query('SAVEPOINT s');
          await c.query(`UPDATE pipeline_states SET ${col} = $2, updated_at = $3 WHERE interview_id = $1`, [interviewId, v, now]);
          await c.query('RELEASE SAVEPOINT s');
        } catch {
          throw new RecordError('INVALID_STATE', `${col} 상태 값 오류`);
        }
      }
    });
  }

  /**
   * 임시 음성 구간 저장. 최초 저장 시각과 한 달 만료 시각은 첫 저장 때 확정되며
   * 같은 키의 재전송·재접속으로 바뀌지 않는다.
   */
  async saveAudioSegment(ownerId: string, interviewId: string, key: string, now: Date, status: 'UNPROCESSED' | 'INTERRUPTED' = 'UNPROCESSED') {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const ins = await c.query(
        `INSERT INTO audio_segments (id, interview_id, idempotency_key, first_saved_at, expires_at, status, status_changed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$4) ON CONFLICT (interview_id, idempotency_key) DO NOTHING RETURNING id`,
        [randomUUID(), interviewId, key, now, addCalendarMonthSeoul(now), status],
      );
      const r = await c.query('SELECT id, first_saved_at, expires_at, status FROM audio_segments WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
      return { ...viewAudio(r.rows[0], now), duplicate: ins.rowCount === 0 };
    });
  }

  /** 음성 처리 상태 변경. 만료 후에는 거부하고 EXPIRED로 확정한다. */
  async setAudioStatus(ownerId: string, interviewId: string, audioId: string, status: Exclude<AudioStatus, 'EXPIRED'>, now: Date) {
    const out = await this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const r = await c.query('SELECT expires_at, status FROM audio_segments WHERE id = $1 AND interview_id = $2 FOR UPDATE', [audioId, interviewId]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '음성 구간 없음');
      if (r.rows[0].status === 'EXPIRED' || now >= (r.rows[0].expires_at as Date)) {
        await c.query("UPDATE audio_segments SET status = 'EXPIRED', status_changed_at = $2 WHERE id = $1 AND status <> 'EXPIRED'", [audioId, now]);
        return false;
      }
      await c.query('UPDATE audio_segments SET status = $2, status_changed_at = $3 WHERE id = $1', [audioId, status, now]);
      return true;
    });
    if (!out) throw new RecordError('AUDIO_EXPIRED', '만료된 음성 구간');
  }

  /** 만료 시각이 지난 음성을 EXPIRED로 확정(만료 시각은 그대로). 인터뷰·상태 행은 만들거나 지우지 않는다. */
  async expireAudio(now: Date): Promise<number> {
    const r = await this.pool.query("UPDATE audio_segments SET status = 'EXPIRED', status_changed_at = $1 WHERE expires_at <= $1 AND status <> 'EXPIRED'", [now]);
    return r.rowCount ?? 0;
  }
}

function viewAudio(r: Record<string, unknown>, now: Date): AudioView {
  const expiresAt = r.expires_at as Date;
  const status = r.status as AudioStatus;
  const expired = status === 'EXPIRED' || now >= expiresAt;
  return {
    id: r.id as string,
    firstSavedAt: r.first_saved_at as Date,
    expiresAt,
    status: expired ? 'EXPIRED' : status,
    recovered: !expired,
  };
}
