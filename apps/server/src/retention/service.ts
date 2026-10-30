import { rm } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { RecordError } from '../records/store.js';
import { addCalendarMonthSeoul } from '../records/time.js';

/**
 * 서버 사본 수명 정리(TASK-29). 이 서비스가 지우는 것은 서버의 텍스트·첨부·음성뿐이다.
 * Drive 백업(backup_items/backup_states)과 완성 영상(RESULT 버전·videos 파일)은 어떤 경로로도 지우거나 바꾸지 않는다.
 * Drive 클라이언트에는 삭제 메서드가 없고 이 모듈은 Drive 를 호출하지 않는다(readiness 만 BackupService 에서 받는다).
 *
 * 순서: ① DB 행을 한 트랜잭션에서 정리하며 지울 파일을 purge_file_queue 에 넣고 ② 커밋 뒤 큐를 비운다.
 * 큐 비우기가 실패하거나 프로세스가 죽어도 행이 남아 있으므로 다음 훑기가 이어서 지운다(부분 실패 상태: pendingFiles).
 */
export interface Readiness { found: boolean; ready?: boolean | null; reason?: string | null }

export interface RetentionDeps {
  pool: pg.Pool;
  fileStorageDir: string;
  /** BackupService.cleanupReadiness(live:true) 를 그대로 연결한다. 판정 로직을 여기서 복제하지 않는다. */
  readiness: (ownerId: string, interviewId: string) => Promise<Readiness>;
  now?: () => Date;
}

type Q = pg.PoolClient;
const SAFE_KEY = /^[\w][\w.-]{0,150}$/;

export interface SweepResult {
  trash: { records: number; parts: number };
  audio: { expired: number; processed: number; deferred: number };
  monthly: { cleaned: number; blocked: number; skipped: number };
  files: { removed: number; kept: number; failed: number };
}

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

  private async queueFiles(c: Q, kind: 'ATTACHMENT' | 'AUDIO', keys: (string | null)[], now: Date) {
    for (const k of new Set(keys.filter((x): x is string => !!x))) {
      await c.query('INSERT INTO purge_file_queue (kind, storage_key, queued_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [kind, k, now]);
    }
  }

  // ---- 기록 단위 영구 삭제 ----

  /**
   * 서버 사본 영구 삭제(트랜잭션 안). 대화 항목·첨부 참조·요약/제작 계획 버전·음성을 지운다.
   * 완성 영상 메타데이터(RESULT 버전)와 Drive 백업 메타데이터가 있으면 기록 행은 날짜 연결용 표식(server_purged_at)으로 남기고,
   * 보존할 것이 없으면 행째 지워 같은 날짜에 새로 기록할 수 있게 한다.
   */
  private async purgeInterviewTx(c: Q, interviewId: string, now: Date) {
    const atts = await c.query('SELECT storage_key FROM attachment_refs WHERE interview_id = $1', [interviewId]);
    await c.query('DELETE FROM attachment_refs WHERE interview_id = $1', [interviewId]);
    await c.query('DELETE FROM conversation_items WHERE interview_id = $1', [interviewId]);
    await c.query("DELETE FROM record_versions WHERE interview_id = $1 AND kind IN ('SUMMARY', 'PRODUCTION_PLAN')", [interviewId]);
    // 처리 중 참조가 있는 음성은 종료가 확인될 때까지 남긴다(sweepAudio 가 기록 영구 삭제 상태를 보고 나중에 지운다).
    const audio = await c.query('SELECT id, file_key FROM audio_segments WHERE interview_id = $1 AND NOT in_processing AND file_deleted_at IS NULL FOR UPDATE', [interviewId]);
    if (audio.rows.length) {
      await c.query(
        `UPDATE audio_segments SET status = 'EXPIRED', status_changed_at = $2, file_deleted_at = $2, deleted_reason = 'RECORD_PURGED', file_key = NULL WHERE id = ANY($1::uuid[])`,
        [audio.rows.map((x) => x.id), now]);
      await this.queueFiles(c, 'AUDIO', audio.rows.map((x) => x.file_key as string | null), now);
    }
    await this.queueFiles(c, 'ATTACHMENT', atts.rows.map((x) => x.storage_key as string), now);
    return this.finishPurge(c, interviewId, now);
  }

  private async finishPurge(c: Q, interviewId: string, now: Date) {
    const keep = await c.query(
      `SELECT (EXISTS (SELECT 1 FROM record_versions WHERE interview_id = $1 AND kind = 'RESULT')
             OR EXISTS (SELECT 1 FROM backup_items WHERE interview_id = $1)
             OR EXISTS (SELECT 1 FROM backup_states WHERE interview_id = $1)
             OR EXISTS (SELECT 1 FROM audio_segments WHERE interview_id = $1 AND file_deleted_at IS NULL)) AS keep`, [interviewId]);
    if (keep.rows[0].keep) {
      await c.query('UPDATE interviews SET server_purged_at = $2, cleanup_blocked_reason = NULL, updated_at = $2 WHERE id = $1', [interviewId, now]);
      return 'TOMBSTONE' as const;
    }
    await c.query('DELETE FROM interviews WHERE id = $1', [interviewId]);
    return 'DELETED' as const;
  }

  /** 즉시 삭제(사용자 명령): 휴지통에 있든 없든 서버 사본을 지금 영구 삭제한다. Drive 백업·완성 영상은 유지된다. */
  async purgeNow(ownerId: string, interviewId: string, now: Date = this.now()) {
    const out = await this.tx(async (c) => {
      const r = await c.query('SELECT id, deleted_at, server_purged_at FROM interviews WHERE id = $1 AND owner_id = $2 FOR UPDATE', [interviewId, ownerId]);
      if (!r.rows[0]) throw new RecordError('NOT_FOUND', '기록을 찾을 수 없음');
      if (r.rows[0].server_purged_at) return { already: true as const };
      if (!r.rows[0].deleted_at) await c.query('UPDATE interviews SET deleted_at = $2, purge_at = $2, updated_at = $2 WHERE id = $1', [interviewId, now]);
      return { already: false as const, result: await this.purgeInterviewTx(c, interviewId, now) };
    });
    const files = await this.drainFileQueue();
    return { ...out, files };
  }

  // ---- 파일 큐 ----

  /**
   * 대기 중인 파일을 지운다. 첨부 파일은 어떤 기록이든(휴지통 포함) 참조가 하나라도 남아 있으면 지우지 않는다(AC-4: 공유 첨부).
   * 참조 확인과 삭제는 같은 잠금 안에서 하며 업로드 저장(saveFileAttachment)도 같은 잠금을 쓴다.
   */
  async drainFileQueue(): Promise<{ removed: number; kept: number; failed: number }> {
    const rows = (await this.d.pool.query('SELECT kind, storage_key FROM purge_file_queue ORDER BY queued_at, storage_key')).rows as { kind: 'ATTACHMENT' | 'AUDIO'; storage_key: string }[];
    const res = { removed: 0, kept: 0, failed: 0 };
    for (const r of rows) {
      const outcome = await this.removeOne(r.kind, r.storage_key);
      res[outcome]++;
    }
    return res;
  }

  private async removeOne(kind: 'ATTACHMENT' | 'AUDIO', key: string): Promise<'removed' | 'kept' | 'failed'> {
    return this.tx(async (c) => {
      if (kind === 'ATTACHMENT') await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`att:${key}`]);
      if (kind === 'ATTACHMENT') {
        const ref = await c.query('SELECT 1 FROM attachment_refs WHERE storage_key = $1 LIMIT 1', [key]);
        if (ref.rows[0]) { await c.query('DELETE FROM purge_file_queue WHERE kind = $1 AND storage_key = $2', [kind, key]); return 'kept' as const; }
      }
      if (!SAFE_KEY.test(key) || key.includes('..')) {
        await c.query('UPDATE purge_file_queue SET attempts = attempts + 1, last_error = $3 WHERE kind = $1 AND storage_key = $2', [kind, key, 'UNSAFE_KEY']);
        return 'failed' as const;
      }
      const full = path.join(this.d.fileStorageDir, kind === 'ATTACHMENT' ? 'attachments' : 'audio', key);
      try {
        await rm(full, { force: true });
      } catch (e) {
        // 민감 정보 없이 오류 코드만 남긴다. 행이 남으므로 다음 훑기에서 다시 시도한다.
        await c.query('UPDATE purge_file_queue SET attempts = attempts + 1, last_error = $3 WHERE kind = $1 AND storage_key = $2', [kind, key, (e as NodeJS.ErrnoException).code ?? 'UNLINK_FAILED']);
        return 'failed' as const;
      }
      await c.query('DELETE FROM purge_file_queue WHERE kind = $1 AND storage_key = $2', [kind, key]);
      return 'removed' as const;
    });
  }

  async pendingFiles(): Promise<{ kind: string; storageKey: string; attempts: number; lastError: string | null }[]> {
    const r = await this.d.pool.query('SELECT kind, storage_key, attempts, last_error FROM purge_file_queue ORDER BY queued_at, storage_key');
    return r.rows.map((x) => ({ kind: x.kind as string, storageKey: x.storage_key as string, attempts: x.attempts as number, lastError: (x.last_error as string | null) ?? null }));
  }

  // ---- 휴지통 만료 ----

  /** 삭제 후 30일이 지난 기록·일부 항목을 서버에서 영구 삭제한다. 만료 시각 이전에는 아무것도 지우지 않는다. */
  async sweepTrash(now: Date = this.now()): Promise<{ records: number; parts: number }> {
    let records = 0, parts = 0;
    const due = await this.d.pool.query('SELECT id FROM interviews WHERE deleted_at IS NOT NULL AND server_purged_at IS NULL AND purge_at <= $1 ORDER BY purge_at, id', [now]);
    for (const row of due.rows) {
      const did = await this.tx(async (c) => {
        const r = await c.query('SELECT purge_at, server_purged_at FROM interviews WHERE id = $1 FOR UPDATE', [row.id]);
        // 그 사이 복구되었거나 이미 지워졌으면 건드리지 않는다.
        if (!r.rows[0] || r.rows[0].server_purged_at || !r.rows[0].purge_at || r.rows[0].purge_at > now) return false;
        await this.purgeInterviewTx(c, row.id as string, now);
        return true;
      });
      if (did) records++;
    }
    // 살아 있는 기록 안에서 삭제된 일부 항목·첨부 중 만료된 것.
    const items = await this.d.pool.query(
      'SELECT c.id, c.interview_id FROM conversation_items c JOIN interviews i ON i.id = c.interview_id WHERE c.purge_at <= $1 AND i.deleted_at IS NULL', [now]);
    for (const it of items.rows) {
      parts += await this.tx(async (c) => {
        await c.query('SELECT 1 FROM interviews WHERE id = $1 FOR UPDATE', [it.interview_id]);
        const cur = await c.query('SELECT purge_at FROM conversation_items WHERE id = $1 FOR UPDATE', [it.id]);
        if (!cur.rows[0] || !cur.rows[0].purge_at || cur.rows[0].purge_at > now) return 0;
        const atts = await c.query('SELECT storage_key FROM attachment_refs WHERE item_id = $1', [it.id]);
        await c.query('DELETE FROM conversation_items WHERE id = $1', [it.id]); // 연결 첨부 참조는 ON DELETE CASCADE
        await this.queueFiles(c, 'ATTACHMENT', atts.rows.map((x) => x.storage_key as string), now);
        return 1;
      });
    }
    const atts = await this.d.pool.query(
      'SELECT a.id, a.interview_id FROM attachment_refs a JOIN interviews i ON i.id = a.interview_id WHERE a.purge_at <= $1 AND i.deleted_at IS NULL', [now]);
    for (const a of atts.rows) {
      parts += await this.tx(async (c) => {
        await c.query('SELECT 1 FROM interviews WHERE id = $1 FOR UPDATE', [a.interview_id]);
        const cur = await c.query('SELECT storage_key, purge_at FROM attachment_refs WHERE id = $1 FOR UPDATE', [a.id]);
        if (!cur.rows[0] || !cur.rows[0].purge_at || cur.rows[0].purge_at > now) return 0;
        await c.query('DELETE FROM attachment_refs WHERE id = $1', [a.id]);
        await this.queueFiles(c, 'ATTACHMENT', [cur.rows[0].storage_key as string], now);
        return 1;
      });
    }
    return { records, parts };
  }

  // ---- 음성 수명 ----

  /**
   * ① 전사·요약·정정이 저장된 기록의 처리 완료(PROCESSED) 음성은 즉시 삭제한다(조기 삭제).
   * ② 그 외 음성(미변환·중단 등)은 최초 저장 시각의 Asia/Seoul 달력 한 달(expires_at) 이후 삭제한다. 재접속은 만료 시각을 바꾸지 않는다.
   * 처리 중 참조(in_processing)는 종료가 확인될 때까지 두 경우 모두 지우지 않는다(deferred). Drive 백업 검증은 요구하지 않는다(음성은 백업 대상이 아니다).
   */
  async sweepAudio(now: Date = this.now()): Promise<{ expired: number; processed: number; deferred: number }> {
    const res = { expired: 0, processed: 0, deferred: 0 };
    const rows = (await this.d.pool.query(
      `SELECT a.id, a.interview_id, a.status, a.expires_at, a.in_processing, i.server_purged_at,
              EXISTS (SELECT 1 FROM conversation_items c WHERE c.interview_id = a.interview_id AND c.kind = 'ANSWER' AND c.deleted_at IS NULL) AS has_transcript,
              EXISTS (SELECT 1 FROM record_versions v WHERE v.interview_id = a.interview_id AND v.kind = 'SUMMARY') AS has_summary
         FROM audio_segments a JOIN interviews i ON i.id = a.interview_id WHERE a.file_deleted_at IS NULL ORDER BY a.first_saved_at, a.id`)).rows;
    for (const r of rows) {
      const expired = now >= (r.expires_at as Date);
      const processed = r.status === 'PROCESSED' && r.has_transcript && r.has_summary;
      const reason: 'EXPIRED' | 'PROCESSED' | 'RECORD_PURGED' | null = r.server_purged_at ? 'RECORD_PURGED' : processed ? 'PROCESSED' : expired ? 'EXPIRED' : null;
      if (!reason) continue;
      if (r.in_processing) { res.deferred++; continue; }
      const did = await this.tx(async (c) => {
        const cur = await c.query('SELECT file_key, in_processing, file_deleted_at FROM audio_segments WHERE id = $1 FOR UPDATE', [r.id]);
        if (!cur.rows[0] || cur.rows[0].file_deleted_at || cur.rows[0].in_processing) return false;
        await c.query(
          `UPDATE audio_segments SET file_deleted_at = $2, deleted_reason = $3, file_key = NULL,
                  status = CASE WHEN $3 = 'PROCESSED' THEN status ELSE 'EXPIRED' END, status_changed_at = $2 WHERE id = $1`, [r.id, now, reason]);
        await this.queueFiles(c, 'AUDIO', [cur.rows[0].file_key as string | null], now);
        return true;
      });
      if (did) { if (reason === 'PROCESSED') res.processed++; else res.expired++; }
    }
    return res;
  }

  // ---- 한 달 자동 정리 (텍스트·첨부) ----

  /**
   * 최초 저장(기록 생성) 시각의 Asia/Seoul 달력 한 달이 지난 기록의 서버 텍스트·첨부를 정리한다.
   * 최신 revision·checksum 의 Drive 백업이 지금도 확인될 때(readiness.ready === true)에만 지우고, 그 외(미연결·장애·미완료·확인 불가)에는 원본을 그대로 두고 사유를 표시한다.
   * 확인 뒤 지우기 전에 기록이 바뀌었거나 처리 중인 작업이 있으면 지우지 않는다. 완성 영상·RESULT 메타데이터·Drive 는 건드리지 않는다.
   */
  async sweepMonthly(now: Date = this.now()): Promise<{ cleaned: number; blocked: number; skipped: number }> {
    const res = { cleaned: 0, blocked: 0, skipped: 0 };
    const cands = (await this.d.pool.query(
      `SELECT id, owner_id, created_at, updated_at, revision FROM interviews
        WHERE deleted_at IS NULL AND server_cleaned_at IS NULL AND server_purged_at IS NULL AND created_at <= $1::timestamptz - interval '28 days'
        ORDER BY created_at, id`, [now])).rows;
    for (const r of cands) {
      if (now < addCalendarMonthSeoul(r.created_at as Date)) continue; // 한 달 전
      const active = await this.d.pool.query(`SELECT 1 FROM jobs WHERE subject_id = $1 AND state IN ('QUEUED', 'RUNNING', 'WAITING') LIMIT 1`, [r.id]);
      if (active.rows[0]) { await this.block(r.id as string, 'JOB_IN_PROGRESS', now); res.blocked++; continue; }
      let ready: boolean; let reason: string;
      try {
        const rd = await this.d.readiness(r.owner_id as string, r.id as string);
        ready = rd.found && rd.ready === true;
        reason = !rd.found ? 'RECORD_NOT_FOUND' : (rd.reason ?? 'BACKUP_NOT_CURRENT');
      } catch {
        ready = false; reason = 'DRIVE_UNREACHABLE';
      }
      if (!ready) { await this.block(r.id as string, reason, now); res.blocked++; continue; }
      const did = await this.tx(async (c) => {
        const cur = await c.query('SELECT updated_at, revision, deleted_at, server_cleaned_at FROM interviews WHERE id = $1 FOR UPDATE', [r.id]);
        const x = cur.rows[0];
        // 백업 확인 뒤에 기록이 바뀌었다면 그 변경분은 백업되지 않았다: 지우지 않고 다음 훑기에서 다시 확인한다.
        if (!x || x.deleted_at || x.server_cleaned_at || +x.updated_at !== +r.updated_at || x.revision !== r.revision) return false;
        const atts = await c.query('SELECT storage_key FROM attachment_refs WHERE interview_id = $1', [r.id]);
        await c.query('DELETE FROM attachment_refs WHERE interview_id = $1', [r.id]);
        await c.query('DELETE FROM conversation_items WHERE interview_id = $1', [r.id]);
        await c.query("DELETE FROM record_versions WHERE interview_id = $1 AND kind IN ('SUMMARY', 'PRODUCTION_PLAN')", [r.id]);
        await c.query('UPDATE interviews SET server_cleaned_at = $2, cleanup_blocked_reason = NULL, cleanup_checked_at = $2 WHERE id = $1', [r.id, now]);
        await this.queueFiles(c, 'ATTACHMENT', atts.rows.map((a) => a.storage_key as string), now);
        return true;
      });
      if (did) res.cleaned++; else { await this.block(r.id as string, 'CHANGED_DURING_CHECK', now); res.skipped++; }
    }
    return res;
  }

  private async block(interviewId: string, reason: string, now: Date) {
    await this.d.pool.query('UPDATE interviews SET cleanup_blocked_reason = $2, cleanup_checked_at = $3 WHERE id = $1', [interviewId, reason, now]);
  }

  /** 모든 수명 정리를 한 번 돈다. 실패한 파일은 큐에 남아 다음 훑기에서 이어진다. */
  async sweep(now: Date = this.now()): Promise<SweepResult> {
    const trash = await this.sweepTrash(now);
    const audio = await this.sweepAudio(now);
    const monthly = await this.sweepMonthly(now);
    const files = await this.drainFileQueue();
    return { trash, audio: audio, monthly, files };
  }
}
