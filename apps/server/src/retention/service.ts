import { rm } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { buildBackupPlan } from '../backup/plan.js';
import type { BackupService } from '../backup/service.js';
import { RecordError } from '../records/store.js';
import { addCalendarMonthSeoul, addTrashPeriod } from '../records/time.js';

type Q = pg.PoolClient;

/** 서버 사본 정리 대기 사유(민감정보 없는 코드). 화면은 이 코드를 문구로 바꿔 보여준다. */
export type CleanupBlock = 'PROCESSING' | 'CHANGED_DURING_CHECK' | 'BACKUP_NOT_CURRENT' | 'SOURCE_INCOMPLETE' | 'VERIFY_MISMATCH' | 'BACKUP_INCOMPLETE' | 'IN_TRASH' | 'DRIVE_NOT_CONNECTED' | 'DRIVE_AUTH_EXPIRED' | 'DRIVE_UNREACHABLE' | 'CHECK_FAILED';

export interface RetentionDeps {
  pool: pg.Pool;
  fileStorageDir: string;
  /** 서버 사본 정리 가능 여부의 유일한 판정자. 판정 로직을 여기에 복제하지 않는다. */
  backup: Pick<BackupService, 'cleanupReadiness'>;
  now?: () => Date;
}

/**
 * 데이터 수명 정책(TASK-7/29). 이 서비스는 Google Drive 에 어떤 요청도 보내지 않는다(백업 확인은 BackupService.cleanupReadiness 가 읽기 전용으로 한다).
 *  - 음성: 전사·요약 저장이 확인된 PROCESSED 는 즉시 삭제, 그 밖은 최초 저장 + 달력 한 달(Asia/Seoul) 후 삭제. 백업 확인은 요구하지 않는다.
 *  - 휴지통: 삭제 후 30일이 지나면 서버 사본을 영구 삭제. 사용자의 즉시 영구 삭제도 같은 경로를 쓴다.
 *  - 한 달 정리: 최신 revision·checksum 이 Drive 에서 지금도 확인될 때만 서버의 텍스트·첨부 사본을 지운다. 실패하면 원본을 보존하고 사유를 남긴다.
 *  - 완성 영상(RESULT 버전과 videos/ 파일)과 backup_* 테이블은 어떤 경로로도 지우지 않는다.
 */
export class RetentionService {
  constructor(private readonly d: RetentionDeps) {}
  private now() { return this.d.now?.() ?? new Date(); }

  private async tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
    const c = await this.d.pool.connect();
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

  // ---- 음성 ----
  /**
   * 음성 삭제 훑기. 처리 중인 작업(대기 포함)이 그 기록을 참조하는 동안은 건드리지 않고 다음 훑기로 미룬다.
   * 음성 파일은 이 저장소에 따로 남지 않으므로 삭제는 구간 기록을 DELETED 로 바꾸는 것이다.
   */
  async sweepAudio(now = this.now()): Promise<{ early: number; expired: number; deferred: number }> {
    const rows = (await this.d.pool.query(
      `SELECT s.id, s.status, s.expires_at,
              EXISTS (SELECT 1 FROM conversation_items c WHERE c.interview_id = s.interview_id) AS has_transcript,
              EXISTS (SELECT 1 FROM record_versions v WHERE v.interview_id = s.interview_id AND v.kind = 'SUMMARY') AS has_summary,
              EXISTS (SELECT 1 FROM jobs j WHERE j.subject_id = s.interview_id::text AND j.state IN ('QUEUED', 'RUNNING', 'WAITING')) AS in_flight
         FROM audio_segments s WHERE s.status <> 'DELETED'`)).rows;
    let early = 0, expired = 0, deferred = 0;
    for (const r of rows) {
      const isExpired = now >= (r.expires_at as Date);
      const isEarly = r.status === 'PROCESSED' && r.has_transcript && r.has_summary;
      if (!isExpired && !isEarly) continue;
      if (r.in_flight) { deferred++; continue; }
      const u = await this.d.pool.query(
        "UPDATE audio_segments SET status = 'DELETED', deleted_at = $2, delete_reason = $3, status_changed_at = $2 WHERE id = $1 AND status <> 'DELETED'",
        [r.id, now, isEarly ? 'EARLY_PROCESSED' : 'MONTH_EXPIRED']);
      if (u.rowCount) { if (isEarly) early++; else expired++; }
    }
    return { early, expired, deferred };
  }

  // ---- 영구 삭제(사용자 즉시 삭제와 30일 만료 공통) ----
  /** 서버 사본(대화·첨부·요약/계획)을 지우고 영상·백업 연결 메타데이터만 남긴다. 호출자가 소유자·휴지통 조건을 확인한다. */
  private async purgeRecordTx(c: Q, interviewId: string, now: Date) {
    const keys = (await c.query('SELECT DISTINCT storage_key FROM attachment_refs WHERE interview_id = $1', [interviewId])).rows.map((r) => r.storage_key as string);
    await c.query('DELETE FROM attachment_refs WHERE interview_id = $1', [interviewId]);
    await c.query('DELETE FROM conversation_items WHERE interview_id = $1', [interviewId]);
    await c.query("DELETE FROM record_versions WHERE interview_id = $1 AND kind IN ('SUMMARY', 'PRODUCTION_PLAN')", [interviewId]);
    await c.query('DELETE FROM audio_segments WHERE interview_id = $1', [interviewId]);
    await this.queueUnreferenced(c, keys);
    await c.query('UPDATE interviews SET server_purged_at = $2, updated_at = $2 WHERE id = $1', [interviewId, now]);
  }

  /** 다른 참조(다른 기록·휴지통의 참조 포함)가 없는 파일만 삭제 대기열에 올린다. */
  private async queueUnreferenced(c: Q, keys: string[]) {
    for (const k of keys) {
      await c.query(
        'INSERT INTO purge_file_queue (storage_key) SELECT $1::text WHERE NOT EXISTS (SELECT 1 FROM attachment_refs WHERE storage_key = $1) ON CONFLICT DO NOTHING', [k]);
    }
  }

  /** 사용자가 확인한 즉시 영구 삭제. 기록: 하루 전체, 항목, 첨부. 대상이 없으면 NOT_FOUND. */
  async purgeNow(ownerId: string, target: { scope: 'RECORD'; interviewId: string } | { scope: 'ITEM' | 'ATTACHMENT'; interviewId: string; id: string }, now = this.now()): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query('SELECT id, deleted_at FROM interviews WHERE id = $1 AND owner_id = $2 AND server_purged_at IS NULL FOR UPDATE', [target.interviewId, ownerId]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
      if (target.scope === 'RECORD') return this.purgeRecordTx(c, target.interviewId, now);
      await this.purgeChild(c, target.scope, target.interviewId, target.id);
    });
    await this.drainFileQueue();
  }

  private async purgeChild(c: Q, scope: 'ITEM' | 'ATTACHMENT', interviewId: string, id: string) {
    if (scope === 'ITEM') {
      const it = await c.query('SELECT 1 FROM conversation_items WHERE id = $1 AND interview_id = $2 FOR UPDATE', [id, interviewId]);
      if (!it.rows[0]) throw new RecordError('NOT_FOUND', '대화 항목을 찾을 수 없음');
      const keys = (await c.query('SELECT DISTINCT storage_key FROM attachment_refs WHERE interview_id = $1 AND item_id = $2', [interviewId, id])).rows.map((x) => x.storage_key as string);
      await c.query('DELETE FROM attachment_refs WHERE interview_id = $1 AND item_id = $2', [interviewId, id]);
      await c.query('DELETE FROM conversation_items WHERE id = $1', [id]);
      await this.queueUnreferenced(c, keys);
    } else {
      const a = await c.query('SELECT storage_key FROM attachment_refs WHERE id = $1 AND interview_id = $2 FOR UPDATE', [id, interviewId]);
      if (!a.rows[0]) throw new RecordError('NOT_FOUND', '첨부를 찾을 수 없음');
      await c.query('DELETE FROM attachment_refs WHERE id = $1', [id]);
      await this.queueUnreferenced(c, [a.rows[0].storage_key as string]);
    }
  }

  /** 보관 30일이 지난 휴지통 항목을 영구 삭제한다. 기록 단위가 먼저, 그 다음 아직 남아 있는 기록의 항목·첨부. */
  async sweepTrash(now = this.now()): Promise<{ records: number; items: number; attachments: number }> {
    let records = 0, items = 0, attachments = 0;
    const due = (await this.d.pool.query('SELECT id FROM interviews WHERE purge_at <= $1 AND server_purged_at IS NULL ORDER BY purge_at, id', [now])).rows;
    for (const r of due) {
      await this.tx(async (c) => {
        const x = await c.query('SELECT purge_at FROM interviews WHERE id = $1 AND server_purged_at IS NULL FOR UPDATE', [r.id]);
        // 잠근 뒤 다시 확인: 그 사이에 복구됐거나 이미 지워졌으면 건드리지 않는다.
        if (x.rows[0]?.purge_at && now >= (x.rows[0].purge_at as Date)) { await this.purgeRecordTx(c, r.id as string, now); records++; }
      });
    }
    const cutoff = new Date(now.getTime() - (addTrashPeriod(new Date(0)).getTime()));
    const kids = (await this.d.pool.query(
      `SELECT 'ITEM' AS scope, c.id, c.interview_id FROM conversation_items c JOIN interviews i ON i.id = c.interview_id
        WHERE c.deleted_at IS NOT NULL AND c.deleted_at <= $1 AND i.server_purged_at IS NULL
       UNION ALL
       SELECT 'ATTACHMENT', a.id, a.interview_id FROM attachment_refs a JOIN interviews i ON i.id = a.interview_id
        WHERE a.deleted_at IS NOT NULL AND NOT a.deleted_via_item AND a.deleted_at <= $1 AND i.server_purged_at IS NULL`, [cutoff])).rows;
    for (const k of kids) {
      await this.tx(async (c) => {
        const iv = await c.query('SELECT 1 FROM interviews WHERE id = $1 AND server_purged_at IS NULL FOR UPDATE', [k.interview_id]);
        if (!iv.rows[0]) return;
        // 잠근 뒤 다시 확인(복구 경쟁).
        const col = k.scope === 'ITEM' ? 'conversation_items' : 'attachment_refs';
        const still = await c.query(`SELECT 1 FROM ${col} WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at <= $2`, [k.id, cutoff]);
        if (!still.rows[0]) return;
        await this.purgeChild(c, k.scope as 'ITEM' | 'ATTACHMENT', k.interview_id as string, k.id as string);
        if (k.scope === 'ITEM') items++; else attachments++;
      });
    }
    await this.drainFileQueue();
    return { records, items, attachments };
  }

  // ---- 한 달 자동 정리 ----
  /**
   * 생성(최초 저장)부터 달력 한 달(Asia/Seoul)이 지난 기록의 서버 텍스트·첨부 사본을 정리한다.
   * 최신 revision·checksum 의 Drive 백업이 지금도 확인될 때만 지우고, 아니면 원본을 보존한 채 사유를 남긴다.
   * 진행 중인 작업이 있거나 확인하는 사이에 내용이 바뀌면 지우지 않는다. 휴지통의 기록은 휴지통 규칙을 따른다.
   */
  async sweepMonthly(now = this.now()): Promise<{ cleaned: number; blocked: number }> {
    const cand = (await this.d.pool.query(
      `SELECT id, owner_id, created_at FROM interviews
        WHERE deleted_at IS NULL AND server_purged_at IS NULL AND server_cleaned_at IS NULL AND created_at <= $1 ORDER BY created_at, id`,
      [new Date(now.getTime() - 27 * 24 * 3600 * 1000)])).rows;
    let cleaned = 0, blocked = 0;
    for (const r of cand) {
      if (now < addCalendarMonthSeoul(r.created_at as Date)) continue;
      const out = await this.cleanOne(r.owner_id as string, r.id as string, now);
      if (out === 'CLEANED') cleaned++; else blocked++;
    }
    return { cleaned, blocked };
  }

  private async block(id: string, reason: CleanupBlock, now: Date) {
    await this.d.pool.query('UPDATE interviews SET cleanup_blocked_reason = $2, cleanup_checked_at = $3 WHERE id = $1 AND server_cleaned_at IS NULL', [id, reason, now]);
    return reason;
  }

  private async cleanOne(ownerId: string, id: string, now: Date): Promise<'CLEANED' | CleanupBlock> {
    const busy = async (q: pg.Pool | Q) => (await q.query("SELECT 1 FROM jobs WHERE subject_id = $1 AND state IN ('QUEUED', 'RUNNING', 'WAITING') LIMIT 1", [id])).rowCount! > 0;
    try {
      if (await busy(this.d.pool)) return this.block(id, 'PROCESSING', now);
      const before = await buildBackupPlan(this.d.pool, this.d.fileStorageDir, id);
      if (!before) return this.block(id, 'CHECK_FAILED', now);
      const ready = await this.d.backup.cleanupReadiness(ownerId, id, { live: true });
      if (!ready.found) return this.block(id, 'CHECK_FAILED', now);
      if (ready.ready !== true) return this.block(id, (ready.reason ?? 'CHECK_FAILED') as CleanupBlock, now);
      return await this.tx(async (c) => {
        const iv = await c.query('SELECT deleted_at FROM interviews WHERE id = $1 AND owner_id = $2 AND server_purged_at IS NULL AND server_cleaned_at IS NULL FOR UPDATE', [id, ownerId]);
        if (!iv.rows[0]) return 'CHECK_FAILED' as const;
        if (iv.rows[0].deleted_at) return 'IN_TRASH' as const;
        // 행을 잠근 뒤 내용이 확인 당시와 같고 진행 중 작업이 없는지 다시 본다(저장 경로는 같은 행 잠금을 쓴다).
        const after = await buildBackupPlan(this.d.pool, this.d.fileStorageDir, id);
        if (!after || after.fingerprint !== before.fingerprint || (await busy(c))) return 'CHANGED_DURING_CHECK' as const;
        const keys = (await c.query('SELECT DISTINCT storage_key FROM attachment_refs WHERE interview_id = $1', [id])).rows.map((x) => x.storage_key as string);
        await c.query('DELETE FROM attachment_refs WHERE interview_id = $1', [id]);
        await c.query('DELETE FROM conversation_items WHERE interview_id = $1', [id]);
        await c.query("DELETE FROM record_versions WHERE interview_id = $1 AND kind IN ('SUMMARY', 'PRODUCTION_PLAN')", [id]);
        await this.queueUnreferenced(c, keys);
        await c.query('UPDATE interviews SET server_cleaned_at = $2, cleanup_blocked_reason = NULL, cleanup_checked_at = $2, updated_at = $2 WHERE id = $1', [id, now]);
        return 'CLEANED' as const;
      }).then(async (res) => { if (res === 'CLEANED') { await this.drainFileQueue(); return res; } return this.block(id, res, now); });
    } catch {
      return this.block(id, 'CHECK_FAILED', now); // 오류 내용(경로·토큰 가능성)은 남기지 않는다
    }
  }

  // ---- 파일 삭제 대기열 ----
  /**
   * 대기열의 첨부 파일을 지운다. 파일 키별 잠금 아래에서 참조를 다시 확인하므로, 같은 내용을 새로 올리는 요청(같은 키 잠금)과 겹쳐도
   * 새 참조가 생긴 파일은 지우지 않는다. 지우기에 실패한 항목은 대기열에 남겨 다음 훑기에서 다시 시도한다.
   */
  async drainFileQueue(): Promise<{ deleted: number; kept: number; failed: number }> {
    const keys = (await this.d.pool.query('SELECT storage_key FROM purge_file_queue ORDER BY created_at, storage_key')).rows.map((r) => r.storage_key as string);
    let deleted = 0, kept = 0, failed = 0;
    for (const key of keys) {
      const res = await this.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        if ((await c.query('SELECT 1 FROM attachment_refs WHERE storage_key = $1 LIMIT 1', [key])).rowCount) {
          await c.query('DELETE FROM purge_file_queue WHERE storage_key = $1', [key]);
          return 'kept' as const;
        }
        if (!/^[0-9a-f]{64}\.\w{1,8}$/.test(key)) { await c.query('DELETE FROM purge_file_queue WHERE storage_key = $1', [key]); return 'kept' as const; }
        try {
          await rm(path.join(this.d.fileStorageDir, 'attachments', key), { force: true });
        } catch (e) {
          await c.query('UPDATE purge_file_queue SET attempts = attempts + 1, last_error = $2 WHERE storage_key = $1', [key, (e as NodeJS.ErrnoException).code ?? 'ERROR']);
          return 'failed' as const;
        }
        await c.query('DELETE FROM purge_file_queue WHERE storage_key = $1', [key]);
        return 'deleted' as const;
      });
      if (res === 'deleted') deleted++; else if (res === 'kept') kept++; else failed++;
    }
    return { deleted, kept, failed };
  }

  /** 한 번의 훑기: 음성 → 휴지통 만료 → 한 달 정리 → 파일 대기열. 단계 하나가 실패해도 나머지는 계속한다. */
  async sweepAll(now = this.now()) {
    const out: Record<string, unknown> = {};
    for (const [name, fn] of [['audio', () => this.sweepAudio(now)], ['trash', () => this.sweepTrash(now)], ['monthly', () => this.sweepMonthly(now)], ['files', () => this.drainFileQueue()]] as const) {
      out[name] = await fn().catch((e) => ({ error: e instanceof Error ? e.name : 'ERROR' }));
    }
    return out;
  }
}
