import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { LIMITS } from '../attachments/policy.js';
import { addCalendarMonthSeoul, addTrashPeriod, isValidDate, seoulDate, suggestLifeDate } from './time.js';

export type RecordErrorCode =
  | 'INVALID_LIFE_DATE'
  | 'EMPTY_PAST_DATE'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE'
  | 'CONFIRMED_LOCKED'
  | 'STALE_BRIEFING'
  | 'AUDIO_EXPIRED'
  | 'IN_TRASH'
  | 'TRASH_EXPIRED'
  | 'RECORD_PURGED'
  | 'SERVER_CLEANED'
  | 'TOO_MANY_ATTACHMENTS';

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

export interface Snapshot {
  interview: Interview;
  resumes: Date[];
  items: { id: string; seq: number; kind: ItemKind; body: string }[];
  attachments: { id: string; itemId: string | null; storageKey: string; checksum: string; kind?: string; name?: string | null }[];
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
    const r = await c.query(`SELECT ${INTERVIEW_COLS}, deleted_at, server_purged_at, server_cleaned_at FROM interviews WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [interviewId, ownerId]);
    if (!r.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
    assertNotDeleted(r.rows[0]);
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
        const r = await c.query(`SELECT ${INTERVIEW_COLS}, deleted_at, server_purged_at, server_cleaned_at FROM interviews WHERE owner_id = $1 AND life_date = $2 FOR UPDATE`, [ownerId, date]);
        if (!r.rows[0]) return null;
        assertNotDeleted(r.rows[0]);
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
      const r = await c.query('SELECT id, deleted_at, server_purged_at, server_cleaned_at FROM interviews WHERE owner_id = $1 AND life_date = $2 FOR UPDATE', [ownerId, lifeDate]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '해당 생활일의 기록이 없음');
      assertNotDeleted(r.rows[0]);
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
              (SELECT v.content FROM record_versions v WHERE v.interview_id = i.id AND v.kind = 'RESULT' ORDER BY v.version DESC LIMIT 1) AS result_content,
              EXISTS (SELECT 1 FROM record_versions v WHERE v.interview_id = i.id AND v.kind = 'RESULT') AS has_result,
              (SELECT count(*) FROM attachment_refs a WHERE a.interview_id = i.id AND a.deleted_at IS NULL)::int AS att
         FROM interviews i LEFT JOIN pipeline_states p ON p.interview_id = i.id
        WHERE i.owner_id = $1 AND i.deleted_at IS NULL AND ($2::date IS NULL OR i.life_date < $2::date)
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
    const r = await this.pool.query('SELECT to_char(life_date, \'YYYY-MM-DD\') AS d FROM interviews WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [id, ownerId]);
    return r.rows[0] ? this.load(ownerId, r.rows[0].d as string, now) : null;
  }

  /** 읽기 전용 조회. 어떤 경우에도 행을 만들지 않는다. */
  async load(ownerId: string, lifeDate: string, now: Date): Promise<Snapshot | null> {
    const r = await this.pool.query(`SELECT ${INTERVIEW_COLS} FROM interviews WHERE owner_id = $1 AND life_date = $2 AND deleted_at IS NULL`, [ownerId, lifeDate]);
    if (!r.rows[0]) return null;
    const interview = toInterview(r.rows[0]);
    const id = interview.id;
    const [resumes, items, atts, vers, pipe, audio] = await Promise.all([
      this.pool.query('SELECT resumed_at FROM interview_resumes WHERE interview_id = $1 ORDER BY id', [id]),
      this.pool.query('SELECT id, seq, kind, body FROM conversation_items WHERE interview_id = $1 AND deleted_at IS NULL ORDER BY seq', [id]),
      this.pool.query('SELECT id, item_id, storage_key, checksum, kind, original_name FROM attachment_refs WHERE interview_id = $1 AND deleted_at IS NULL ORDER BY saved_at, id', [id]),
      this.pool.query('SELECT kind, version, content FROM record_versions WHERE interview_id = $1 ORDER BY kind, version', [id]),
      this.pool.query('SELECT production, review, backup, quality_reasons FROM pipeline_states WHERE interview_id = $1', [id]),
      this.pool.query('SELECT id, first_saved_at, expires_at, status FROM audio_segments WHERE interview_id = $1 ORDER BY first_saved_at, id', [id]),
    ]);
    return {
      interview,
      resumes: resumes.rows.map((x) => x.resumed_at as Date),
      items: items.rows.map((x) => ({ id: x.id, seq: x.seq, kind: x.kind, body: x.body })),
      attachments: atts.rows.map((x) => ({ id: x.id, itemId: x.item_id, storageKey: x.storage_key, checksum: x.checksum, kind: x.kind, name: x.original_name })),
      versions: vers.rows.map((x) => ({ kind: x.kind, version: x.version, content: x.content })),
      pipeline: { production: pipe.rows[0].production, review: pipe.rows[0].review, backup: pipe.rows[0].backup, ...(pipe.rows[0].quality_reasons?.length ? { qualityReasons: pipe.rows[0].quality_reasons } : {}) } as PipelineState,
      audio: audio.rows.map((x) => viewAudio(x, now)),
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
      // 같은 파일을 지우는 정리 작업과 순서를 맞춘다(retention/service.ts removeUnreferencedFile 이 같은 잠금을 쓴다).
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`att:${f.storageKey}`]);
      const iv = await this.lock(c, ownerId, interviewId);
      const ex = await c.query('SELECT id, checksum FROM attachment_refs WHERE interview_id = $1 AND idempotency_key = $2', [interviewId, key]);
      if (ex.rows[0]) {
        if (ex.rows[0].checksum !== f.checksum) throw new RecordError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 첨부');
        return { id: ex.rows[0].id as string, duplicate: true };
      }
      assertEditable(iv);
      const same = await c.query('SELECT id FROM attachment_refs WHERE interview_id = $1 AND checksum = $2 AND deleted_at IS NULL ORDER BY saved_at LIMIT 1', [interviewId, f.checksum]);
      if (same.rows[0]) return { id: same.rows[0].id as string, duplicate: true };
      const n = await c.query('SELECT count(*)::int AS n FROM attachment_refs WHERE interview_id = $1 AND deleted_at IS NULL', [interviewId]);
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
    // 읽기 전용: 정리된(CLEANED) 기록도 조회는 되어야 하므로 쓰기용 잠금(lock)을 쓰지 않는다. 휴지통 기록은 NOT_FOUND 와 같게 취급한다.
    const own = await this.pool.query('SELECT 1 FROM interviews WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [interviewId, ownerId]);
    if (!own.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
    const r = await this.pool.query(
      `SELECT id, item_id, storage_key, kind, original_name, mime_type, size_bytes, saved_at, captured_at, captured_source
         FROM attachment_refs WHERE interview_id = $1 AND deleted_at IS NULL ORDER BY saved_at, id`,
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


  // ---- 휴지통 (TASK-29) ----

  /** 휴지통 명령용 잠금: 삭제된 기록도 돌려준다(상태 판단은 호출자). */
  private async lockAny(c: Q, ownerId: string, interviewId: string) {
    const r = await c.query('SELECT id, deleted_at, purge_at, server_purged_at FROM interviews WHERE id = $1 AND owner_id = $2 FOR UPDATE', [interviewId, ownerId]);
    if (!r.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
    return r.rows[0] as { id: string; deleted_at: Date | null; purge_at: Date | null; server_purged_at: Date | null };
  }

  /**
   * 기록(하루) 삭제 = 휴지통으로 이동. 삭제 시점부터 30일 동안 복구할 수 있다. 같은 기록을 다시 삭제해도 최초 삭제 시각을 바꾸지 않는다.
   * 서버 사본만 대상이며 Drive 백업·완성 영상은 건드리지 않는다.
   */
  async trashRecord(ownerId: string, interviewId: string, now: Date) {
    return this.tx(async (c) => {
      const r = await this.lockAny(c, ownerId, interviewId);
      if (r.server_purged_at) throw new RecordError('RECORD_PURGED', '서버 사본이 이미 삭제된 기록');
      if (r.deleted_at) return { deletedAt: r.deleted_at, purgeAt: r.purge_at!, duplicate: true };
      const purgeAt = addTrashPeriod(now);
      await c.query('UPDATE interviews SET deleted_at = $2, purge_at = $3, updated_at = $2 WHERE id = $1', [interviewId, now, purgeAt]);
      return { deletedAt: now, purgeAt, duplicate: false };
    });
  }

  /** 휴지통 기록 복구. 만료 시각 이후(= 삭제 후 30일)에는 복구할 수 없다. 만료된 기록의 실제 삭제는 정리 훑기가 한다. */
  async restoreRecord(ownerId: string, interviewId: string, now: Date) {
    return this.tx(async (c) => {
      const r = await this.lockAny(c, ownerId, interviewId);
      if (r.server_purged_at) throw new RecordError('RECORD_PURGED', '서버 사본이 삭제되어 복구할 수 없음');
      if (!r.deleted_at) return { restored: false, duplicate: true };
      if (now >= r.purge_at!) throw new RecordError('TRASH_EXPIRED', '휴지통 보관 30일이 지나 복구할 수 없음');
      await c.query('UPDATE interviews SET deleted_at = NULL, purge_at = NULL, updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { restored: true, duplicate: false };
    });
  }

  /** 기록 일부 삭제: 대화 항목 한 건(그 항목에 연결된 첨부 포함)을 휴지통으로. */
  async trashItem(ownerId: string, interviewId: string, itemId: string, now: Date) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const it = await c.query('SELECT deleted_at, purge_at FROM conversation_items WHERE id = $1 AND interview_id = $2 FOR UPDATE', [itemId, interviewId]);
      if (!it.rows[0]) throw new RecordError('NOT_FOUND', '대화 항목을 찾을 수 없음');
      if (it.rows[0].deleted_at) return { purgeAt: it.rows[0].purge_at as Date, duplicate: true };
      const purgeAt = addTrashPeriod(now);
      await c.query('UPDATE conversation_items SET deleted_at = $2, purge_at = $3 WHERE id = $1', [itemId, now, purgeAt]);
      await c.query('UPDATE attachment_refs SET deleted_at = $2, purge_at = $3 WHERE item_id = $1 AND deleted_at IS NULL', [itemId, now, purgeAt]);
      await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { purgeAt, duplicate: false };
    });
  }

  /** 기록 일부 삭제: 첨부 한 건을 휴지통으로. 같은 파일을 다른 기록이 참조해도 그쪽 참조·파일은 그대로다(실제 파일 삭제는 정리 훑기가 참조 수를 확인한 뒤에만). */
  async trashAttachment(ownerId: string, interviewId: string, attachmentId: string, now: Date) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const a = await c.query('SELECT deleted_at, purge_at FROM attachment_refs WHERE id = $1 AND interview_id = $2 FOR UPDATE', [attachmentId, interviewId]);
      if (!a.rows[0]) throw new RecordError('NOT_FOUND', '첨부를 찾을 수 없음');
      if (a.rows[0].deleted_at) return { purgeAt: a.rows[0].purge_at as Date, duplicate: true };
      const purgeAt = addTrashPeriod(now);
      await c.query('UPDATE attachment_refs SET deleted_at = $2, purge_at = $3 WHERE id = $1', [attachmentId, now, purgeAt]);
      await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { purgeAt, duplicate: false };
    });
  }

  /** 휴지통의 일부 항목 복구(항목 복구는 함께 삭제된 연결 첨부도 되살린다). */
  async restoreItem(ownerId: string, interviewId: string, itemId: string, now: Date) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const it = await c.query('SELECT deleted_at, purge_at FROM conversation_items WHERE id = $1 AND interview_id = $2 FOR UPDATE', [itemId, interviewId]);
      if (!it.rows[0]) throw new RecordError('NOT_FOUND', '대화 항목을 찾을 수 없음 (이미 삭제되었을 수 있음)');
      if (!it.rows[0].deleted_at) return { restored: false, duplicate: true };
      if (now >= (it.rows[0].purge_at as Date)) throw new RecordError('TRASH_EXPIRED', '휴지통 보관 30일이 지나 복구할 수 없음');
      await c.query('UPDATE attachment_refs SET deleted_at = NULL, purge_at = NULL WHERE item_id = $1 AND deleted_at = $2', [itemId, it.rows[0].deleted_at]);
      await c.query('UPDATE conversation_items SET deleted_at = NULL, purge_at = NULL WHERE id = $1', [itemId]);
      await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { restored: true, duplicate: false };
    });
  }

  async restoreAttachment(ownerId: string, interviewId: string, attachmentId: string, now: Date) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const a = await c.query('SELECT item_id, deleted_at, purge_at FROM attachment_refs WHERE id = $1 AND interview_id = $2 FOR UPDATE', [attachmentId, interviewId]);
      if (!a.rows[0]) throw new RecordError('NOT_FOUND', '첨부를 찾을 수 없음 (이미 삭제되었을 수 있음)');
      if (!a.rows[0].deleted_at) return { restored: false, duplicate: true };
      if (now >= (a.rows[0].purge_at as Date)) throw new RecordError('TRASH_EXPIRED', '휴지통 보관 30일이 지나 복구할 수 없음');
      if (a.rows[0].item_id) {
        const it = await c.query('SELECT deleted_at FROM conversation_items WHERE id = $1', [a.rows[0].item_id]);
        if (it.rows[0]?.deleted_at) throw new RecordError('IN_TRASH', '연결된 대화 항목이 휴지통에 있음. 항목을 먼저 복구하세요');
      }
      await c.query('UPDATE attachment_refs SET deleted_at = NULL, purge_at = NULL WHERE id = $1', [attachmentId]);
      await c.query('UPDATE interviews SET updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { restored: true, duplicate: false };
    });
  }

  /** 소유자의 휴지통: 삭제된 기록(남은 기간 포함)과 살아 있는 기록 안의 삭제된 일부 항목·첨부. 서버 사본이 이미 영구 삭제된 기록은 나오지 않는다. */
  async listTrash(ownerId: string, now: Date) {
    const recs = await this.pool.query(
      `SELECT id, to_char(life_date, 'YYYY-MM-DD') AS life_date, deleted_at, purge_at FROM interviews
        WHERE owner_id = $1 AND deleted_at IS NOT NULL AND server_purged_at IS NULL ORDER BY deleted_at DESC, id`, [ownerId]);
    const parts = await this.pool.query(
      `SELECT 'ITEM' AS kind, c.id, i.id AS interview_id, to_char(i.life_date, 'YYYY-MM-DD') AS life_date, c.deleted_at, c.purge_at, NULL::text AS name
         FROM conversation_items c JOIN interviews i ON i.id = c.interview_id WHERE i.owner_id = $1 AND i.deleted_at IS NULL AND c.deleted_at IS NOT NULL
       UNION ALL
       SELECT 'ATTACHMENT', a.id, i.id, to_char(i.life_date, 'YYYY-MM-DD'), a.deleted_at, a.purge_at, a.original_name
         FROM attachment_refs a JOIN interviews i ON i.id = a.interview_id WHERE i.owner_id = $1 AND i.deleted_at IS NULL AND a.deleted_at IS NOT NULL AND
          NOT EXISTS (SELECT 1 FROM conversation_items c2 WHERE c2.id = a.item_id AND c2.deleted_at IS NOT NULL)
       ORDER BY deleted_at DESC, id`, [ownerId]);
    const left = (purgeAt: Date) => Math.max(0, Math.ceil((purgeAt.getTime() - now.getTime()) / 86_400_000));
    return {
      records: recs.rows.map((x) => ({ id: x.id as string, lifeDate: x.life_date as string, deletedAt: x.deleted_at as Date, purgeAt: x.purge_at as Date, daysLeft: left(x.purge_at as Date), restorable: now < (x.purge_at as Date) })),
      parts: parts.rows.map((x) => ({ kind: x.kind as 'ITEM' | 'ATTACHMENT', id: x.id as string, interviewId: x.interview_id as string, lifeDate: x.life_date as string, name: (x.name as string | null) ?? null, deletedAt: x.deleted_at as Date, purgeAt: x.purge_at as Date, daysLeft: left(x.purge_at as Date), restorable: now < (x.purge_at as Date) })),
    };
  }

  /**
   * 서버 사본의 보관 상태(화면 문구용). 서버 사본이 어떻게 되었든 Drive 백업·완성 영상은 이 값과 무관하게 보존된다.
   * serverCopy: PRESENT(있음) / TRASHED(휴지통) / CLEANED(한 달 자동 정리됨) / PURGED(영구 삭제됨).
   */
  async retentionOf(ownerId: string, interviewId: string, now: Date) {
    const r = (await this.pool.query(
      `SELECT deleted_at, purge_at, server_purged_at, server_cleaned_at, cleanup_blocked_reason, cleanup_checked_at, created_at FROM interviews WHERE id = $1 AND owner_id = $2`, [interviewId, ownerId])).rows[0];
    if (!r) return null;
    const serverCopy = r.server_purged_at ? 'PURGED' : r.deleted_at ? 'TRASHED' : r.server_cleaned_at ? 'CLEANED' : 'PRESENT';
    return {
      serverCopy: serverCopy as 'PRESENT' | 'TRASHED' | 'CLEANED' | 'PURGED',
      trashPurgeAt: (r.purge_at as Date | null) ?? null,
      cleanupDueAt: addCalendarMonthSeoul(r.created_at as Date),
      cleanupBlockedReason: (r.cleanup_blocked_reason as string | null) ?? null,
      cleanupCheckedAt: (r.cleanup_checked_at as Date | null) ?? null,
      restorable: !!r.deleted_at && !r.server_purged_at && now < (r.purge_at as Date),
    };
  }

  /** 음성 구간에 파일 위치를 연결(파일이 있을 때만). 만료 시각은 바꾸지 않는다. */
  async attachAudioFile(ownerId: string, interviewId: string, audioId: string, fileKey: string) {
    if (!/^[\w][\w.-]{0,150}$/.test(fileKey) || fileKey.includes('..')) throw new RecordError('INVALID_STATE', '음성 파일 이름 오류');
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const r = await c.query('UPDATE audio_segments SET file_key = $3 WHERE id = $1 AND interview_id = $2 AND file_deleted_at IS NULL RETURNING id', [audioId, interviewId, fileKey]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '음성 구간 없음');
    });
  }

  /** 처리 작업이 음성을 읽는 동안 표시한다. 표시된 구간은 만료 시각이 지나도 처리 종료를 확인할 때까지 삭제하지 않는다(만료 시각 자체는 그대로). */
  async setAudioProcessing(ownerId: string, interviewId: string, audioId: string, inProcessing: boolean) {
    return this.tx(async (c) => {
      await this.lock(c, ownerId, interviewId);
      const r = await c.query('UPDATE audio_segments SET in_processing = $3 WHERE id = $1 AND interview_id = $2 RETURNING id', [audioId, interviewId, inProcessing]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '음성 구간 없음');
    });
  }

  /** 만료 시각이 지난 음성을 EXPIRED로 확정(만료 시각은 그대로). 인터뷰·상태 행은 만들거나 지우지 않는다. */
  async expireAudio(now: Date): Promise<number> {
    const r = await this.pool.query("UPDATE audio_segments SET status = 'EXPIRED', status_changed_at = $1 WHERE expires_at <= $1 AND status <> 'EXPIRED'", [now]);
    return r.rowCount ?? 0;
  }
}

/** 휴지통(또는 서버 사본 영구 삭제) 상태의 기록에는 어떤 쓰기도 하지 않는다. */
function assertNotDeleted(r: Record<string, unknown>) {
  if (r.server_purged_at) throw new RecordError('RECORD_PURGED', '서버 사본이 삭제된 기록');
  if (r.deleted_at) throw new RecordError('IN_TRASH', '휴지통에 있는 기록. 복구한 뒤 사용하세요');
  if (r.server_cleaned_at) throw new RecordError('SERVER_CLEANED', '한 달이 지나 서버 사본이 정리된 기록. Drive 백업에 보존되어 있습니다');
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
