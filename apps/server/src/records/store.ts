import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { LIMITS } from '../attachments/policy.js';
import type { ProductionPlan } from '../briefing/briefing.js';
import { applyRevision, type RevisedPlan, type RevisionKind, type RevisionRejection, type RevisionRequest } from './revision.js';
import { displayStatus } from './view.js';
import { addCalendarMonthSeoul, isValidDate, seoulDate, suggestLifeDate } from './time.js';

export type RecordErrorCode =
  | 'INVALID_LIFE_DATE'
  | 'EMPTY_PAST_DATE'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE'
  | 'CONFIRMED_LOCKED'
  | 'STALE_BRIEFING'
  | 'AUDIO_EXPIRED'
  | 'TOO_MANY_ATTACHMENTS'
  | 'NOT_REVISABLE'
  | 'REMAKE_IN_PROGRESS'
  | 'NOT_RETRYABLE'
  | 'NOT_CONFIRMABLE';

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
  qualityReasons?: string[];
  production: 'NONE' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'WAITING_BUDGET';
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

/** 수정 요청이 반영되지 않았다는 뜻. 트랜잭션은 되돌려지고 아무것도 바뀌지 않는다. */
export class RevisionRejected extends Error {
  constructor(public readonly rejection: RevisionRejection) {
    super(rejection.message);
    this.name = 'RevisionRejected';
  }
}

export interface ResultVersionRow {
  version: number;
  content: unknown;
  createdAt: Date;
  /** 수정으로 대체된 시각. 대체되지 않았으면 null. */
  supersededAt: Date | null;
  reviewAtSupersede: PipelineState['review'] | null;
  confirmedAt: Date | null;
}

export interface Snapshot {
  interview: Interview;
  resumes: Date[];
  items: { id: string; seq: number; kind: ItemKind; body: string }[];
  attachments: { id: string; itemId: string | null; storageKey: string; checksum: string; kind?: string; name?: string | null }[];
  versions: { kind: VersionKind; version: number; content: unknown }[];
  pipeline: PipelineState;
  audio: AudioView[];
  /** 수정으로 대체되어 더는 현재 결과가 아닌 RESULT 버전. */
  supersededResults?: number[];
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

const MAX_ATTACHMENTS_PER_RECORD = LIMITS.perRecord;

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
export interface RecordListRow { id: string; lifeDate: string; status: Interview['status']; pipeline: PipelineState; hasResult: boolean; resultContent: unknown; attachmentCount: number }

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

  /**
   * 새 인터뷰에서 선택할 수 있는 생활일: 제안일과 서울 오늘 달력일.
   * 05:00 KST 전에는 전날·당일, 05:00 이후에는 당일만 허용한다(Wiki05 v9).
   */
  allowedNewLifeDates(now: Date): string[] {
    return [...new Set([suggestLifeDate(now), seoulDate(now)])].sort();
  }

  /**
   * 인터뷰 시작. lifeDate 생략 시 05:00 KST 규칙의 제안일.
   * 같은 생활일의 기록이 이미 있으면 이어보기(재개 시각만 별도 기록, 생활일 불변). 기존 작성 중 기록은
   * 날짜 규칙과 무관하게 원래 생활일로 재개된다. 동시 요청은 INSERT ... ON CONFLICT로 한 행만 만들고 나머지는 재개한다.
   * 기록이 없는 과거·미래 날짜의 신규 생성은 거부한다.
   */
  async startInterview(ownerId: string, now: Date, lifeDate?: string): Promise<{ interview: Interview; resumed: boolean }> {
    const date = lifeDate ?? suggestLifeDate(now);
    if (!isValidDate(date)) throw new RecordError('INVALID_LIFE_DATE', '생활일 형식 오류');
    return this.tx(async (c) => {
      const resume = async (): Promise<Interview | null> => {
        const r = await c.query(`SELECT ${INTERVIEW_COLS} FROM interviews WHERE owner_id = $1 AND life_date = $2 FOR UPDATE`, [ownerId, date]);
        if (!r.rows[0]) return null;
        const iv = toInterview(r.rows[0]);
        await c.query('INSERT INTO interview_resumes (interview_id, resumed_at) VALUES ($1, $2)', [iv.id, now]);
        return iv;
      };
      const existing = await resume();
      if (existing) return { interview: existing, resumed: true };
      if (date > seoulDate(now)) throw new RecordError('INVALID_LIFE_DATE', '미래 생활일은 선택할 수 없음');
      if (!this.allowedNewLifeDates(now).includes(date)) throw new RecordError('EMPTY_PAST_DATE', '기록이 없는 과거 날짜는 새로 만들 수 없음');
      const ins = await c.query(
        `INSERT INTO interviews (id, owner_id, life_date, started_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $4)
         ON CONFLICT (owner_id, life_date) DO NOTHING
         RETURNING ${INTERVIEW_COLS}`,
        [randomUUID(), ownerId, date, now],
      );
      if (!ins.rows[0]) {
        // 동시 요청이 먼저 만들었다: 그 기록을 이어본다.
        const raced = await resume();
        if (!raced) throw new RecordError('INVALID_STATE', '기록을 시작하지 못했습니다. 다시 시도하세요');
        return { interview: raced, resumed: true };
      }
      const iv = toInterview(ins.rows[0]);
      await c.query('INSERT INTO pipeline_states (interview_id, updated_at) VALUES ($1, $2)', [iv.id, now]);
      return { interview: iv, resumed: false };
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

  /**
   * 소유자의 기록 목록: 생활일 최신순(제작·완료 시각과 무관). 읽기 전용.
   * (owner_id, life_date) 는 유일하므로 생활일이 곧 커서다: `before` 보다 이전 생활일만 limit 건 돌려준다.
   * 한 건 더 읽어 다음 페이지 유무를 알린다(nextCursor 가 null 이면 마지막).
   */
  async listRecords(ownerId: string, page: { limit: number; before?: string | null }): Promise<{ rows: RecordListRow[]; nextCursor: string | null }> {
    const r = await this.pool.query(
      `SELECT i.id, to_char(i.life_date, 'YYYY-MM-DD') AS life_date, i.status, p.production, p.review, p.backup, p.quality_reasons,
              (SELECT v.content FROM record_versions v WHERE v.interview_id = i.id AND v.kind = 'RESULT' AND NOT EXISTS (SELECT 1 FROM result_version_marks m WHERE m.interview_id = i.id AND m.result_version = v.version) ORDER BY v.version DESC LIMIT 1) AS result_content,
              EXISTS (SELECT 1 FROM record_versions v WHERE v.interview_id = i.id AND v.kind = 'RESULT' AND NOT EXISTS (SELECT 1 FROM result_version_marks m WHERE m.interview_id = i.id AND m.result_version = v.version)) AS has_result,
              (SELECT count(*) FROM attachment_refs a WHERE a.interview_id = i.id)::int AS att
         FROM interviews i LEFT JOIN pipeline_states p ON p.interview_id = i.id
        WHERE i.owner_id = $1 AND ($2::date IS NULL OR i.life_date < $2::date)
        ORDER BY i.life_date DESC LIMIT $3`,
      [ownerId, page.before ?? null, page.limit + 1],
    );
    const more = r.rows.length > page.limit;
    const rows = r.rows.slice(0, page.limit).map((x): RecordListRow => ({
      id: x.id, lifeDate: x.life_date, status: x.status,
      pipeline: { production: x.production ?? 'NONE', review: x.review ?? 'NONE', backup: x.backup ?? 'NONE', ...(x.quality_reasons?.length ? { qualityReasons: x.quality_reasons } : {}) },
      hasResult: x.has_result, resultContent: x.result_content ?? null, attachmentCount: x.att,
    }));
    return { rows, nextCursor: more ? rows[rows.length - 1]!.lifeDate : null };
  }

  /** id 로 읽기 전용 조회(소유자 확인). 없거나 타 소유자면 null. */
  async loadById(ownerId: string, id: string, now: Date): Promise<Snapshot | null> {
    const r = await this.pool.query('SELECT to_char(life_date, \'YYYY-MM-DD\') AS d FROM interviews WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    return r.rows[0] ? this.load(ownerId, r.rows[0].d as string, now) : null;
  }

  /** 읽기 전용 조회. 어떤 경우에도 행을 만들지 않는다. */
  async load(ownerId: string, lifeDate: string, now: Date): Promise<Snapshot | null> {
    const r = await this.pool.query(`SELECT ${INTERVIEW_COLS} FROM interviews WHERE owner_id = $1 AND life_date = $2`, [ownerId, lifeDate]);
    if (!r.rows[0]) return null;
    const interview = toInterview(r.rows[0]);
    const id = interview.id;
    const [resumes, items, atts, vers, pipe, audio, marks] = await Promise.all([
      this.pool.query('SELECT resumed_at FROM interview_resumes WHERE interview_id = $1 ORDER BY id', [id]),
      this.pool.query('SELECT id, seq, kind, body FROM conversation_items WHERE interview_id = $1 ORDER BY seq', [id]),
      this.pool.query('SELECT id, item_id, storage_key, checksum, kind, original_name FROM attachment_refs WHERE interview_id = $1 ORDER BY saved_at, id', [id]),
      this.pool.query('SELECT kind, version, content FROM record_versions WHERE interview_id = $1 ORDER BY kind, version', [id]),
      this.pool.query('SELECT production, review, backup, quality_reasons FROM pipeline_states WHERE interview_id = $1', [id]),
      this.pool.query('SELECT id, first_saved_at, expires_at, status FROM audio_segments WHERE interview_id = $1 ORDER BY first_saved_at, id', [id]),
      this.pool.query('SELECT result_version FROM result_version_marks WHERE interview_id = $1 ORDER BY result_version', [id]),
    ]);
    return {
      interview,
      resumes: resumes.rows.map((x) => x.resumed_at as Date),
      items: items.rows.map((x) => ({ id: x.id, seq: x.seq, kind: x.kind, body: x.body })),
      attachments: atts.rows.map((x) => ({ id: x.id, itemId: x.item_id, storageKey: x.storage_key, checksum: x.checksum, kind: x.kind, name: x.original_name })),
      versions: vers.rows.map((x) => ({ kind: x.kind, version: x.version, content: x.content })),
      pipeline: { production: pipe.rows[0].production, review: pipe.rows[0].review, backup: pipe.rows[0].backup, ...(pipe.rows[0].quality_reasons?.length ? { qualityReasons: pipe.rows[0].quality_reasons } : {}) } as PipelineState,
      audio: audio.rows.map((x) => viewAudio(x, now)),
      supersededResults: marks.rows.map((x) => x.result_version as number),
    };
  }

  /** 대화 항목 저장(멱등). 같은 키·같은 내용 재전송은 기존 항목 반환, 내용이 다르면 충돌. */
  async saveItem(ownerId: string, interviewId: string, key: string, kind: ItemKind, body: string, now: Date) {
    return this.tx((c) => this.insertItem(c, ownerId, interviewId, key, kind, body, now));
  }

  private async insertItem(c: Q, ownerId: string, interviewId: string, key: string, kind: ItemKind, body: string, now: Date) {
    const iv = await this.lock(c, ownerId, interviewId);
    const ex = await c.query('SELECT id, seq, kind, body FROM conversation_items WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
    if (ex.rows[0]) {
      if (ex.rows[0].kind !== kind || ex.rows[0].body !== body) throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 내용');
      return { id: ex.rows[0].id as string, seq: ex.rows[0].seq as number, duplicate: true };
    }
    assertEditable(iv);
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
    const iv = await this.lock(c, ownerId, interviewId);
    const ex = await c.query('SELECT id, item_id, storage_key, checksum, kind, original_name FROM attachment_refs WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
    if (ex.rows[0]) {
      const x = ex.rows[0];
      if (x.storage_key !== ref.storageKey || x.checksum !== ref.checksum || (x.item_id ?? null) !== (ref.itemId ?? null)) {
        throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 첨부');
      }
      return { id: x.id as string, duplicate: true };
    }
    assertEditable(iv);
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

  /**
   * 업로드된 파일 참조 저장. 같은 기록에 같은 내용(checksum)이 이미 있으면 새 참조를 만들지 않고 기존 것을 돌려준다.
   * 멱등 키가 같으면 재전송으로 본다. 촬영 시각은 호출자가 EXIF 에서 얻은 값만 받는다(업로드 시각으로 채우지 않음).
   */
  async saveFileAttachment(
    ownerId: string, interviewId: string, key: string,
    f: { itemId?: string; storageKey: string; checksum: string; kind: string; name: string; mime: string; size: number; capturedAt: Date | null; capturedSource: string | null },
    now: Date,
  ) {
    return this.tx(async (c) => {
      const iv = await this.lock(c, ownerId, interviewId);
      const ex = await c.query('SELECT id, checksum FROM attachment_refs WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
      if (ex.rows[0]) {
        if (ex.rows[0].checksum !== f.checksum) throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 첨부');
        return { id: ex.rows[0].id as string, duplicate: true };
      }
      assertEditable(iv);
      const same = await c.query('SELECT id FROM attachment_refs WHERE interview_id = $1 AND checksum = $2 ORDER BY saved_at LIMIT 1', [interviewId, f.checksum]);
      if (same.rows[0]) return { id: same.rows[0].id as string, duplicate: true };
      const n = await c.query('SELECT count(*)::int AS n FROM attachment_refs WHERE interview_id = $1', [interviewId]);
      if ((n.rows[0].n as number) >= MAX_ATTACHMENTS_PER_RECORD) throw new RecordError('TOO_MANY_ATTACHMENTS', '기록당 첨부 개수 제한');
      if (f.itemId) {
        const it = await c.query('SELECT 1 FROM conversation_items WHERE id = $1 AND interview_id = $2', [f.itemId, interviewId]);
        if (!it.rows[0]) throw new RecordError('NOT_FOUND', '연결할 대화 항목이 없음');
      }
      const id = randomUUID();
      await c.query(
        `INSERT INTO attachment_refs (id, interview_id, item_id, idempotency_key, storage_key, checksum, saved_at, kind, original_name, mime_type, size_bytes, captured_at, captured_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, interviewId, f.itemId ?? null, key, f.storageKey, f.checksum, now, f.kind, f.name, f.mime, f.size, f.capturedAt, f.capturedSource],
      );
      await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { id, duplicate: false };
    });
  }

  async isStorageKeyReferenced(storageKey: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM attachment_refs WHERE storage_key = $1 LIMIT 1', [storageKey])).rows.length > 0;
  }

  /** 기록의 첨부 목록. 촬영 시각이 없으면 capturedAt 은 null(업로드 시각 uploadedAt 과 별개). */
  async listAttachments(ownerId: string, interviewId: string) {
    await this.tx((c) => this.lock(c, ownerId, interviewId));
    const r = await this.pool.query(
      `SELECT id, item_id, storage_key, kind, original_name, mime_type, size_bytes, saved_at, captured_at, captured_source
         FROM attachment_refs WHERE interview_id = $1 ORDER BY saved_at, id`,
      [interviewId],
    );
    return r.rows.map((x) => ({
      id: x.id as string, itemId: (x.item_id as string | null) ?? null, storageKey: x.storage_key as string, kind: x.kind as string,
      name: (x.original_name as string | null) ?? null, mime: (x.mime_type as string | null) ?? null, size: x.size_bytes === null ? null : Number(x.size_bytes),
      uploadedAt: x.saved_at as Date, capturedAt: (x.captured_at as Date | null) ?? null, capturedSource: (x.captured_source as string | null) ?? null,
    }));
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

  /** RESULT 버전 전체(대체된 것 포함). 소유자가 아니면 NOT_FOUND. */
  async listResultVersions(ownerId: string, interviewId: string): Promise<ResultVersionRow[]> {
    const own = await this.pool.query('SELECT 1 FROM interviews WHERE id = $1 AND owner_id = $2', [interviewId, ownerId]);
    if (!own.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
    const r = await this.pool.query(
      `SELECT v.version, v.content, v.created_at, m.superseded_at, m.review_at_supersede, c.confirmed_at
         FROM record_versions v
         LEFT JOIN result_version_marks m ON m.interview_id = v.interview_id AND m.result_version = v.version
         LEFT JOIN result_confirmations c ON c.interview_id = v.interview_id AND c.result_version = v.version
        WHERE v.interview_id = $1 AND v.kind = 'RESULT' ORDER BY v.version DESC`,
      [interviewId],
    );
    return r.rows.map((x) => ({
      version: x.version as number, content: x.content, createdAt: x.created_at as Date, supersededAt: (x.superseded_at as Date | null) ?? null,
      reviewAtSupersede: (x.review_at_supersede as PipelineState['review'] | null) ?? null, confirmedAt: (x.confirmed_at as Date | null) ?? null,
    }));
  }

  /**
   * 사용자의 결과 확인. 지금 정상 완료(COMPLETED)인 현재 결과 버전에만 기록하며, 시간이 지나도 자동으로 만들어지지 않는다.
   * 같은 버전의 재확인은 처음 확인 시각을 그대로 돌려준다.
   */
  async confirmResult(ownerId: string, interviewId: string, version: number, now: Date): Promise<{ confirmedAt: Date; duplicate: boolean }> {
    return this.tx(async (c) => {
      const iv = await this.lock(c, ownerId, interviewId);
      const p = (await c.query('SELECT production, review, backup FROM pipeline_states WHERE interview_id = $1', [interviewId])).rows[0] as PipelineState;
      const cur = await c.query(
        `SELECT max(v.version) AS v FROM record_versions v WHERE v.interview_id = $1 AND v.kind = 'RESULT'
            AND NOT EXISTS (SELECT 1 FROM result_version_marks m WHERE m.interview_id = v.interview_id AND m.result_version = v.version)`, [interviewId]);
      if (cur.rows[0].v === null || Number(cur.rows[0].v) !== version) throw new RecordError('NOT_CONFIRMABLE', '현재 결과 버전이 아님');
      if (displayStatus(iv.status, p) !== 'COMPLETED') throw new RecordError('NOT_CONFIRMABLE', '검수를 통과한 완료 결과만 확인할 수 있음');
      const ins = await c.query('INSERT INTO result_confirmations (interview_id, result_version, confirmed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [interviewId, version, now]);
      const r = await c.query('SELECT confirmed_at FROM result_confirmations WHERE interview_id = $1 AND result_version = $2', [interviewId, version]);
      return { confirmedAt: r.rows[0].confirmed_at as Date, duplicate: ins.rowCount === 0 };
    });
  }

  /**
   * 결과 수정·재시도 명령을 결과 버전에 연결한다. 모든 변경은 한 트랜잭션이다.
   * - EXCLUDE/EDIT_TEXT/VOICE: 새 제작 계획 버전(장면·내레이션·자막 재제작 지정), 기존 RESULT 대체 표식, 제작 QUEUED·검수 NONE, 새 작업.
   * - RETRY: 실패하거나 대기 중인 같은 작업을 다시 대기열에 올린다(자동 재시도·품질 재제작 횟수는 그대로 계승).
   * 같은 commandId 의 재전송은 처음 결과를 돌려주고, 내용이 다르면 IDEMPOTENCY_CONFLICT 이다.
   */
  async reviseResult(
    ownerId: string, interviewId: string, o: { commandId: string; request: RevisionRequest; job: { kind: string; stages: string[] } }, now: Date,
  ): Promise<{ duplicate: boolean; planVersion: number | null; jobId: string; revision: number; removedIds: string[]; changedIds: string[]; suggestedKeywords: string[] }> {
    const hash = createHash('sha256').update(JSON.stringify(o.request)).digest('hex');
    return this.tx(async (c) => {
      const iv = await this.lock(c, ownerId, interviewId);
      const dup = await c.query('SELECT request_hash, plan_version, job_id FROM result_revisions WHERE interview_id = $1 AND command_id = $2', [interviewId, o.commandId]);
      if (dup.rows[0]) {
        if (dup.rows[0].request_hash !== hash) throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 명령 식별자에 다른 요청');
        return { duplicate: true, planVersion: dup.rows[0].plan_version as number | null, jobId: dup.rows[0].job_id as string, revision: iv.revision, removedIds: [], changedIds: [], suggestedKeywords: [] };
      }
      if (iv.status !== 'CONFIRMED') throw new RecordError('NOT_REVISABLE', '확정된 기록만 수정할 수 있음');
      const p = (await c.query('SELECT production, review, backup FROM pipeline_states WHERE interview_id = $1 FOR UPDATE', [interviewId])).rows[0] as PipelineState;
      const kind: RevisionKind = o.request.kind;

      if (o.request.kind === 'RETRY') {
        const jr = await c.query('SELECT * FROM jobs WHERE kind = $1 AND subject_id = $2 ORDER BY created_at DESC, id LIMIT 1 FOR UPDATE', [o.job.kind, interviewId]);
        const j = jr.rows[0] as Record<string, unknown> | undefined;
        const unsettled = j ? (await c.query(`SELECT 1 FROM job_stages WHERE job_id = $1 AND state IN ('SENT','UNKNOWN')`, [j.id])).rows.length > 0 : false;
        const retryable = !!j && !unsettled && (j.state === 'FAILED' || (j.state === 'WAITING' && (j.wait_reason === 'BUDGET' || j.wait_reason === 'PERMISSION')));
        if (!retryable) throw new RecordError('NOT_RETRYABLE', '다시 시도할 수 있는 실패·대기 작업이 없음');
        const jobId = j!.id as string;
        await c.query(
          `INSERT INTO job_requests (job_id, command_id, actor, kind, prior_state, prior_wait_reason, inherited_auto_retries) VALUES ($1,$2,$3,'MANUAL_RETRY',$4,$5,$6)`,
          [jobId, `result:${interviewId}:${o.commandId}`, ownerId, j!.state, j!.wait_reason, j!.auto_retries_used]);
        await c.query(`UPDATE jobs SET state='QUEUED', wait_reason=NULL, error_code=NULL, manual_requests=manual_requests+1, updated_at=$2 WHERE id=$1`, [jobId, now]);
        await c.query("INSERT INTO job_events (job_id, event, code) VALUES ($1,'MANUAL_RETRY',$2)", [jobId, o.commandId]);
        await c.query("UPDATE pipeline_states SET production = 'QUEUED', updated_at = $2 WHERE interview_id = $1", [interviewId, now]);
        await c.query('INSERT INTO result_revisions (id, interview_id, command_id, kind, request_hash, plan_version, job_id, remake, created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
          [randomUUID(), interviewId, o.commandId, kind, hash, jobId, [], now]);
        return { duplicate: false, planVersion: null, jobId, revision: iv.revision, removedIds: [], changedIds: [], suggestedKeywords: [] };
      }

      if (p.production === 'QUEUED' || p.production === 'RUNNING' || p.production === 'WAITING_BUDGET') throw new RecordError('REMAKE_IN_PROGRESS', '제작이 진행 중이라 지금은 수정할 수 없음');
      if (p.production === 'NONE') throw new RecordError('NOT_REVISABLE', '제작된 결과가 아직 없음');
      const planRow = await c.query("SELECT version, content FROM record_versions WHERE interview_id = $1 AND kind = 'PRODUCTION_PLAN' ORDER BY version DESC LIMIT 1", [interviewId]);
      if (!planRow.rows[0]) throw new RecordError('NOT_REVISABLE', '수정할 제작 계획이 없음');
      const out = applyRevision(planRow.rows[0].content as ProductionPlan, o.request);
      if (!out.ok) throw new RevisionRejected(out);
      const planVersion = (planRow.rows[0].version as number) + 1;
      const revision = iv.revision + 1;
      await c.query('UPDATE interviews SET revision = $2, updated_at = $3 WHERE id = $1', [interviewId, revision, now]);
      await c.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'PRODUCTION_PLAN',$3,$4,$5)", [randomUUID(), interviewId, planVersion, JSON.stringify(out.plan satisfies RevisedPlan), now]);
      // 지금까지의 모든 결과는 이 수정으로 대체된다. 새 결과가 검수를 통과하기 전에는 어떤 것도 정상 완성본으로 보이지 않는다.
      await c.query(
        `INSERT INTO result_version_marks (interview_id, result_version, superseded_at, review_at_supersede, command_id)
         SELECT v.interview_id, v.version, $2, $3, $4 FROM record_versions v WHERE v.interview_id = $1 AND v.kind = 'RESULT' ON CONFLICT DO NOTHING`,
        [interviewId, now, p.review, o.commandId]);
      await c.query("UPDATE pipeline_states SET production = 'QUEUED', review = 'NONE', quality_reasons = '{}', updated_at = $2 WHERE interview_id = $1", [interviewId, now]);
      const job = await c.query('INSERT INTO jobs (kind, subject_id, stages, idempotency_key) VALUES ($1,$2,$3,$4) RETURNING id', [o.job.kind, interviewId, o.job.stages, `revise:${interviewId}:${o.commandId}`]);
      const jobId = job.rows[0].id as string;
      await c.query("INSERT INTO job_events (job_id, event) VALUES ($1, 'ENQUEUED')", [jobId]);
      await c.query('INSERT INTO result_revisions (id, interview_id, command_id, kind, request_hash, plan_version, job_id, remake, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), interviewId, o.commandId, kind, hash, planVersion, jobId, [...out.plan.remake.components], now]);
      return { duplicate: false, planVersion, jobId, revision, removedIds: out.removedIds, changedIds: out.changedIds, suggestedKeywords: out.suggestedKeywords };
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

  /**
   * 브리핑 확인과 제작 요청을 한 트랜잭션으로 묶는다(TASK-20, AC-2).
   * 확정·revision 증가·제작 계획·파이프라인 QUEUED·작업 큐 등록이 모두 되거나 모두 안 된다.
   * 확인한 브리핑 버전이 최신이 아니면(정정이 그 사이에 있었으면) STALE_BRIEFING 으로 거부하고 아무것도 만들지 않는다.
   * 같은 브리핑 버전의 재확인은 이미 만든 작업을 돌려주며 중복 작업을 만들지 않는다.
   */
  async confirmBriefing(
    ownerId: string, interviewId: string, o: { briefingVersion: number; plan: unknown; job: { kind: string; stages: string[]; idempotencyKey: string } }, now: Date,
  ): Promise<{ jobId: string; duplicate: boolean; revision: number }> {
    return this.tx(async (c) => {
      const iv = await this.lock(c, ownerId, interviewId);
      const last = await c.query("SELECT COALESCE(MAX(version), 0) AS v FROM record_versions WHERE interview_id = $1 AND kind = 'SUMMARY'", [interviewId]);
      if (Number(last.rows[0].v) !== o.briefingVersion || o.briefingVersion < 1) throw new RecordError('STALE_BRIEFING', '확인한 브리핑이 최신이 아님');
      const prior = await c.query('SELECT id FROM jobs WHERE idempotency_key = $1', [o.job.idempotencyKey]);
      if (prior.rows[0]) return { jobId: prior.rows[0].id as string, duplicate: true, revision: iv.revision };
      if (iv.status === 'CONFIRMED') throw new RecordError('CONFIRMED_LOCKED', '이미 다른 브리핑으로 확정된 기록');
      const revision = iv.revision + 1;
      await c.query("UPDATE interviews SET status = 'CONFIRMED', revision = $2, updated_at = $3 WHERE id = $1", [interviewId, revision, now]);
      const pv = await c.query("SELECT COALESCE(MAX(version), 0) AS v FROM record_versions WHERE interview_id = $1 AND kind = 'PRODUCTION_PLAN'", [interviewId]);
      await c.query("INSERT INTO record_versions (id, interview_id, kind, version, content, created_at) VALUES ($1,$2,'PRODUCTION_PLAN',$3,$4,$5)", [randomUUID(), interviewId, Number(pv.rows[0].v) + 1, JSON.stringify(o.plan), now]);
      await c.query("UPDATE pipeline_states SET production = 'QUEUED', updated_at = $2 WHERE interview_id = $1", [interviewId, now]);
      const job = await c.query('INSERT INTO jobs (kind, subject_id, stages, idempotency_key) VALUES ($1,$2,$3,$4) RETURNING id', [o.job.kind, interviewId, o.job.stages, o.job.idempotencyKey]);
      await c.query("INSERT INTO job_events (job_id, event) VALUES ($1, 'ENQUEUED')", [job.rows[0].id]);
      return { jobId: job.rows[0].id as string, duplicate: false, revision };
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

/** 확정된 기록은 저장 요청으로 바뀌지 않는다. 수정은 startProduction의 새 revision으로만 남긴다. */
function assertEditable(iv: Interview) {
  if (iv.status === 'CONFIRMED') throw new RecordError('CONFIRMED_LOCKED', '확정된 기록은 저장으로 수정할 수 없음');
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
