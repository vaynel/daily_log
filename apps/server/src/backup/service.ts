import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { NonRetryableError, PermissionDeniedError, type JobQueue, type JobRow, type StageContext, type StageHandler } from '../jobs/queue.js';
import { DriveAuthError, DriveQuotaError, DriveRequestError, DriveTransientError, type DriveApi, type DriveFile } from './drive.js';
import { buildBackupPlan, hashFile, type BackupPlan, type PlanItem } from './plan.js';

export const BACKUP_KIND = 'drive-backup';
export const BACKUP_STAGES = ['preflight', 'copy', 'finalize'] as const;
export const ROOT_FOLDER_NAME = 'Daily Log Backup';

export type BackupReason =
  | 'DRIVE_NOT_CONNECTED' | 'DRIVE_AUTH_EXPIRED' | 'DRIVE_PERMISSION_DENIED' | 'DRIVE_QUOTA_INSUFFICIENT'
  | 'COPY_FAILED' | 'RETRYING' | 'SOURCE_INCOMPLETE' | 'SOURCE_FILE_MISSING' | 'SOURCE_CORRUPT' | 'VERIFY_MISMATCH' | 'RECORD_GONE';
export type BackupStateName = 'PENDING' | 'VERIFIED' | 'FAILED';

export interface BackupDeps {
  pool: pg.Pool;
  queue: JobQueue;
  fileStorageDir: string;
  /** 소유자의 Drive 접근. 미연결·만료면 DriveAuthError 를 던진다. */
  drive: (ownerId: string) => Promise<DriveApi>;
  connections: { rootFolder(o: string): Promise<string | null>; setRootFolder(o: string, id: string): Promise<void>; state(o: string): Promise<'NONE' | 'CONNECTED' | 'AUTH_EXPIRED'> };
  now?: () => Date;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 사유 → 파이프라인 백업 열. 미연결·재시도 대기는 실패가 아니라 대기(PENDING)이며 어떤 경우도 VERIFIED 가 아니다(AC-4). */
const KNOWN_REASONS = new Set(['SOURCE_INCOMPLETE', 'SOURCE_FILE_MISSING', 'SOURCE_CORRUPT', 'VERIFY_MISMATCH', 'RECORD_GONE']);
const stateOf = (r: BackupReason): BackupStateName => (r === 'DRIVE_NOT_CONNECTED' || r === 'RETRYING' ? 'PENDING' : 'FAILED');

export class BackupService {
  constructor(private readonly d: BackupDeps) {}
  private now() { return this.d.now?.() ?? new Date(); }

  // ---- 상태 기록 ----
  private async setState(plan: { interviewId: string; ownerId: string; fingerprint: string }, state: BackupStateName, reason: BackupReason | null, jobId: string | null) {
    const c = await this.d.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO backup_states (interview_id, owner_id, fingerprint, state, reason, job_id, verified_at) VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4='VERIFIED' THEN now() END)
         ON CONFLICT (interview_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, fingerprint=EXCLUDED.fingerprint, state=EXCLUDED.state, reason=EXCLUDED.reason,
           job_id=COALESCE(EXCLUDED.job_id, backup_states.job_id), verified_at=CASE WHEN EXCLUDED.state='VERIFIED' THEN now() ELSE NULL END, updated_at=now()`,
        [plan.interviewId, plan.ownerId, plan.fingerprint, state, reason, jobId]);
      // 파이프라인 열은 파생 값이다. 행이 없으면 만들지 않는다(기록 생성은 기록 저장소의 책임).
      await c.query(`UPDATE pipeline_states SET backup=$2, updated_at=now() WHERE interview_id=$1`, [plan.interviewId, state]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  // ---- 작업 만들기 ----
  /** 현재 내용의 백업 작업을 만든다(같은 내용이면 같은 작업). 이미 전부 검증됐으면 작업 없이 VERIFIED 만 확인한다. */
  async enqueueInterview(interviewId: string): Promise<{ plan: BackupPlan; job: JobRow | null } | null> {
    const plan = await buildBackupPlan(this.d.pool, this.d.fileStorageDir, interviewId);
    if (!plan) return null;
    if (!plan.problems.length && (await this.pendingItems(plan)).length === 0) {
      await this.setState(plan, 'VERIFIED', null, null);
      return { plan, job: null };
    }
    const job = await this.d.queue.enqueue({ kind: BACKUP_KIND, subjectId: interviewId, stages: [...BACKUP_STAGES], idempotencyKey: `${BACKUP_KIND}:${interviewId}:${plan.fingerprint}` });
    const cur = (await this.d.pool.query('SELECT fingerprint, state FROM backup_states WHERE interview_id=$1', [interviewId])).rows[0];
    if (!cur || cur.fingerprint !== plan.fingerprint) await this.setState(plan, 'PENDING', null, job.id);
    return { plan, job };
  }

  /** 하루 1회 이상 호출되는 훑기. 내용이 있는 모든 기록을 대상으로 하며 변경이 없으면 아무 작업도 만들지 않는다. */
  async sweep(): Promise<{ enqueued: number; verified: number }> {
    const ids = (await this.d.pool.query(
      `SELECT i.id FROM interviews i WHERE i.deleted_at IS NULL AND i.server_cleaned_at IS NULL AND (EXISTS (SELECT 1 FROM conversation_items c WHERE c.interview_id=i.id AND c.deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM attachment_refs a WHERE a.interview_id=i.id AND a.deleted_at IS NULL) OR EXISTS (SELECT 1 FROM record_versions v WHERE v.interview_id=i.id))
       ORDER BY i.life_date`)).rows.map((r) => r.id as string);
    let enqueued = 0, verified = 0;
    for (const id of ids) {
      const r = await this.enqueueInterview(id);
      if (!r) continue;
      if (r.job) enqueued++; else verified++;
    }
    return { enqueued, verified };
  }

  private async pendingItems(plan: BackupPlan): Promise<PlanItem[]> {
    const done = await this.d.pool.query(`SELECT item_kind, item_key, content_sha256 FROM backup_items WHERE interview_id=$1 AND status='VERIFIED'`, [plan.interviewId]);
    const ok = new Set(done.rows.map((r) => `${r.item_kind}|${r.item_key}|${r.content_sha256}`));
    return plan.items.filter((i) => !ok.has(`${i.kind}|${i.key}|${i.sha256}`));
  }

  // ---- 작업 단계 ----
  handlers(): Record<string, StageHandler> {
    const wrap = (stage: (ctx: StageContext) => Promise<unknown>): StageHandler => ({
      execute: async (ctx) => {
        try {
          return { result: await stage(ctx) };
        } catch (e) {
          throw await this.onFailure(ctx, e);
        }
      },
    });
    return {
      preflight: wrap((ctx) => this.preflight(ctx)),
      copy: wrap((ctx) => this.copy(ctx)),
      finalize: wrap((ctx) => this.finalize(ctx)),
    };
  }

  /** 오류를 큐가 이해하는 종류로 바꾸고 기록별 상태·사유를 남긴다. 서버 원본과 Drive 파일은 어떤 경우에도 건드리지 않는다(AC-3). */
  private async onFailure(ctx: StageContext, e: unknown): Promise<Error> {
    let reason: BackupReason;
    let out: Error;
    if (e instanceof DriveAuthError) { reason = e.code; out = e.code === 'DRIVE_NOT_CONNECTED' ? new PermissionDeniedError(e.code) : new PermissionDeniedError(e.code); }
    else if (e instanceof DriveQuotaError) { reason = 'DRIVE_QUOTA_INSUFFICIENT'; out = new NonRetryableError(e.code); }
    else if (e instanceof NonRetryableError) { reason = KNOWN_REASONS.has(e.code) ? (e.code as BackupReason) : 'COPY_FAILED'; out = e; }
    else if (e instanceof DriveRequestError) { reason = 'COPY_FAILED'; out = new NonRetryableError(e.code); }
    else if (e instanceof DriveTransientError) {
      // 자동 재시도(작업당 1회)가 남아 있으면 대기로, 없으면 실패로 표시한다.
      const used = Number((await this.d.pool.query('SELECT auto_retries_used FROM jobs WHERE id=$1', [ctx.jobId])).rows[0]?.auto_retries_used ?? 1);
      reason = used < 1 ? 'RETRYING' : 'COPY_FAILED';
      out = e;
    } else { reason = 'COPY_FAILED'; out = e instanceof Error ? e : new Error('UNKNOWN'); }
    const plan = await this.stateFor(ctx.subjectId);
    if (plan) await this.setState(plan, stateOf(reason), reason, ctx.jobId).catch(() => {});
    return out;
  }

  private async stateFor(interviewId: string) {
    const r = (await this.d.pool.query('SELECT owner_id FROM interviews WHERE id=$1', [interviewId])).rows[0];
    if (!r) return null;
    const fp = (await this.d.pool.query('SELECT fingerprint FROM backup_states WHERE interview_id=$1', [interviewId])).rows[0]?.fingerprint as string | undefined;
    return { interviewId, ownerId: r.owner_id as string, fingerprint: fp ?? '' };
  }

  private async loadPlan(interviewId: string): Promise<BackupPlan> {
    const plan = await buildBackupPlan(this.d.pool, this.d.fileStorageDir, interviewId);
    if (!plan) throw new NonRetryableError('RECORD_GONE');
    return plan;
  }

  /** 1단계: 연결 확인 → 목록 구성(음성 제외) → 여유 용량 검사. 용량이 모자라면 아무것도 올리지 않는다. */
  private async preflight(ctx: StageContext) {
    const plan = await this.loadPlan(ctx.subjectId);
    const drive = await this.d.drive(plan.ownerId); // 미연결·만료는 여기서 권한 대기
    await this.setState(plan, 'PENDING', null, ctx.jobId);
    const pending = await this.pendingItems(plan);
    const need = pending.reduce((n, i) => n + i.size, 0);
    if (need > 0) {
      const q = await drive.quota();
      // limit 이 없으면(무제한 계정) 검사할 한도가 없다. 있으면 남은 용량이 필요한 만큼 있어야 한다.
      if (q.limit !== null && q.limit - q.usage < need) throw new DriveQuotaError();
    }
    for (const i of pending) {
      await this.d.pool.query(
        `INSERT INTO backup_items (owner_id, interview_id, life_date, item_kind, item_key, version_label, content_sha256, size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (owner_id, interview_id, item_kind, item_key, content_sha256) DO NOTHING`,
        [plan.ownerId, plan.interviewId, plan.lifeDate, i.kind, i.key, i.label, i.sha256, i.size]);
    }
    return { fingerprint: plan.fingerprint, pending: pending.length, bytes: need, problems: plan.problems };
  }

  /** 2단계: 항목별 복사 + 올린 직후 크기·MD5 대조. 이미 검증된 항목은 건너뛰고, 응답 유실에 대비해 올리기 전에 같은 항목 키의 파일을 찾는다. */
  private async copy(ctx: StageContext) {
    const plan = await this.loadPlan(ctx.subjectId);
    const drive = await this.d.drive(plan.ownerId);
    const pending = await this.pendingItems(plan);
    let copied = 0;
    const problems: { key: string; code: string }[] = [];
    if (pending.length) {
      const dayFolder = await this.dayFolder(drive, plan);
      for (const item of pending) {
        await ctx.heartbeat();
        try {
          await this.copyOne(drive, plan, item, dayFolder);
          copied++;
        } catch (e) {
          // 원본 문제는 해당 항목만 실패로 남기고 나머지는 계속 올린다. 그 외(Drive 오류)는 즉시 중단해 큐 규칙을 따른다.
          if (e instanceof NonRetryableError && (e.code === 'SOURCE_FILE_MISSING' || e.code === 'SOURCE_CORRUPT')) {
            problems.push({ key: item.key, code: e.code });
            await this.d.pool.query(`UPDATE backup_items SET status='FAILED', error_code=$5, updated_at=now() WHERE interview_id=$1 AND item_kind=$2 AND item_key=$3 AND content_sha256=$4`, [plan.interviewId, item.kind, item.key, item.sha256, e.code]);
          } else throw e;
        }
      }
    }
    // 원본 문제가 있는 항목은 완료로 칠하지 않는다: 나머지를 올린 뒤 실패로 끝낸다.
    if (problems.length) throw new NonRetryableError('SOURCE_INCOMPLETE');
    return { copied };
  }

  private async dayFolder(drive: DriveApi, plan: BackupPlan): Promise<string> {
    let root = await this.d.connections.rootFolder(plan.ownerId);
    if (!root || !(await drive.get(root).catch(() => null)) || (await drive.get(root))?.trashed) {
      root = await drive.ensureFolder(ROOT_FOLDER_NAME, null);
      await this.d.connections.setRootFolder(plan.ownerId, root);
    }
    return drive.ensureFolder(plan.lifeDate, root);
  }

  private async copyOne(drive: DriveApi, plan: BackupPlan, item: PlanItem, folder: string) {
    let bytes: Buffer;
    let md5: string;
    if ('bytes' in item.source) {
      bytes = item.source.bytes;
      md5 = createHash('md5').update(bytes).digest('hex');
    } else {
      if (!item.source.available) throw new NonRetryableError('SOURCE_FILE_MISSING');
      const h = await hashFile(item.source.file).catch(() => null);
      if (!h) throw new NonRetryableError('SOURCE_FILE_MISSING');
      // 서버 파일이 기록된 해시와 다르면(손상·교체) 잘못된 내용을 백업으로 표시하지 않는다.
      if (h.sha256 !== item.sha256) throw new NonRetryableError('SOURCE_CORRUPT');
      md5 = h.md5;
      bytes = await readFile(item.source.file);
    }
    let file: DriveFile | null = await drive.findByItemKey(item.itemKey);
    if (file && (file.trashed || file.size !== bytes.length || file.md5 !== md5)) file = null; // 쓸 수 없는 파일은 재사용하지 않는다(덮어쓰기·삭제 없이 새로 올림)
    file ??= await drive.upload({
      name: item.driveName, parentId: folder, mime: item.mime, bytes,
      appProperties: { dlItemKey: item.itemKey, dlInterview: plan.interviewId, dlKind: item.kind, dlVersion: item.label, dlSha256: item.sha256.slice(0, 64) },
    });
    const check = await drive.get(file.id);
    const good = !!check && !check.trashed && check.size === bytes.length && check.md5 === md5;
    if (!good) {
      await this.d.pool.query(`UPDATE backup_items SET status='FAILED', drive_file_id=$5, error_code='VERIFY_MISMATCH', updated_at=now() WHERE interview_id=$1 AND item_kind=$2 AND item_key=$3 AND content_sha256=$4`, [plan.interviewId, item.kind, item.key, item.sha256, file.id]);
      throw new NonRetryableError('VERIFY_MISMATCH');
    }
    await this.d.pool.query(
      `UPDATE backup_items SET status='VERIFIED', drive_file_id=$5, drive_name=$6, drive_md5=$7, verified_at=now(), error_code=NULL, updated_at=now()
        WHERE interview_id=$1 AND item_kind=$2 AND item_key=$3 AND content_sha256=$4`,
      [plan.interviewId, item.kind, item.key, item.sha256, check.id, check.name, md5]);
  }

  /** 3단계: 현재 목록의 모든 항목이 Drive 에서 다시 확인되면(삭제·휴지통·변조 없음) VERIFIED. 원본 문제가 남았으면 완료로 표시하지 않는다. */
  private async finalize(ctx: StageContext) {
    const plan = await this.loadPlan(ctx.subjectId);
    if (plan.problems.length) throw new NonRetryableError('SOURCE_INCOMPLETE');
    const live = await this.liveCheck(plan);
    if (live !== 'OK') throw live instanceof DriveAuthError || live instanceof DriveTransientError ? live : new NonRetryableError(live);
    await this.setState(plan, 'VERIFIED', null, ctx.jobId);
    return { verified: plan.items.length };
  }

  /** 현재 목록의 각 항목이 DB 에 검증 기록이 있고 Drive 에 같은 크기·MD5 로 남아 있는지 확인. */
  private async liveCheck(plan: BackupPlan): Promise<'OK' | 'BACKUP_INCOMPLETE' | 'VERIFY_MISMATCH' | DriveAuthError | DriveTransientError> {
    const drive = await this.d.drive(plan.ownerId);
    const rows = (await this.d.pool.query(`SELECT item_kind, item_key, content_sha256, drive_file_id, drive_md5, size_bytes, status FROM backup_items WHERE interview_id=$1`, [plan.interviewId])).rows;
    for (const i of plan.items) {
      const row = rows.find((r: Row) => r.item_kind === i.kind && r.item_key === i.key && r.content_sha256 === i.sha256);
      if (!row || row.status !== 'VERIFIED') return 'BACKUP_INCOMPLETE';
      const f = await drive.get(row.drive_file_id as string);
      if (!f || f.trashed || f.size !== Number(row.size_bytes) || f.md5 !== row.drive_md5) return 'VERIFY_MISMATCH';
    }
    return 'OK';
  }

  /** 사용자의 수동 재시도 요청. 현재 내용의 작업이 실패·대기 상태일 때만 받으며 자동 재시도 사용 횟수는 계승된다. */
  async requestRetry(ownerId: string, interviewId: string, commandId: string) {
    const plan = await buildBackupPlan(this.d.pool, this.d.fileStorageDir, interviewId);
    if (!plan || plan.ownerId !== ownerId) return { ok: false as const, code: 'NOT_FOUND' as const };
    const j = (await this.d.pool.query('SELECT id FROM jobs WHERE idempotency_key=$1', [`${BACKUP_KIND}:${interviewId}:${plan.fingerprint}`])).rows[0];
    if (!j) return { ok: false as const, code: 'NOT_FOUND' as const };
    return this.d.queue.requestManualRetry(j.id as string, { commandId, actor: `owner:${ownerId}` });
  }

  /** 권한 대기 작업을 다시 시작해도 되는지: 해당 소유자의 Drive 연결이 다시 살아 있을 때. */
  async permissionRestored(job: JobRow): Promise<boolean> {
    if (job.kind !== BACKUP_KIND) return false;
    const o = (await this.d.pool.query('SELECT owner_id FROM interviews WHERE id=$1', [job.subjectId])).rows[0];
    return !!o && (await this.d.connections.state(o.owner_id as string)) === 'CONNECTED';
  }

  // ---- 조회: 상태와 서버 원본 정리 가능 여부 ----
  /** 화면용 요약. 연결 상태와 기록별 백업 상태·사유·버전을 돌려준다. 파일 내용은 포함하지 않는다. */
  async status(ownerId: string) {
    const conn = await this.d.connections.state(ownerId);
    const rows = (await this.d.pool.query(
      `SELECT to_char(i.life_date,'YYYY-MM-DD') AS life_date, i.id, s.state, s.reason, s.verified_at, s.fingerprint,
              (SELECT count(*) FROM backup_items b WHERE b.interview_id=i.id AND b.status='VERIFIED')::int AS verified_items
         FROM interviews i LEFT JOIN backup_states s ON s.interview_id=i.id WHERE i.owner_id=$1 ORDER BY i.life_date DESC LIMIT 200`, [ownerId])).rows;
    return {
      drive: conn === 'NONE' ? 'NOT_CONNECTED' : conn === 'CONNECTED' ? 'CONNECTED' : 'AUTH_EXPIRED',
      records: rows.map((r) => ({
        id: r.id as string, lifeDate: r.life_date as string, backup: (r.state as BackupStateName | null) ?? 'NONE', reason: (r.reason as BackupReason | null) ?? null,
        verifiedAt: (r.verified_at as Date | null)?.toISOString() ?? null, verifiedItems: r.verified_items as number,
      })),
    };
  }

  /**
   * 서버 원본(텍스트·첨부)을 정리해도 되는지. 최신 목록의 모든 항목이 검증 기록을 갖고(backedUp) Drive 에서 지금도 같은 크기·MD5 로 확인될 때만 ready.
   * 확인 불가(미연결·만료·네트워크)이면 ready=false 와 사유를 돌려주고 원본을 유지하게 한다. 이 함수는 어떤 것도 삭제하지 않는다.
   */
  async cleanupReadiness(ownerId: string, interviewId: string, opts: { live: boolean }): Promise<
    { found: false } | { found: true; backedUp: boolean; ready: boolean | null; reason: string | null; latestVersion: string | null; verifiedAt: string | null; items: { kind: string; key: string; version: string; status: string }[] }> {
    const plan = await buildBackupPlan(this.d.pool, this.d.fileStorageDir, interviewId);
    if (!plan || plan.ownerId !== ownerId) return { found: false };
    const rows = (await this.d.pool.query(`SELECT item_kind, item_key, content_sha256, version_label, status, verified_at FROM backup_items WHERE interview_id=$1`, [interviewId])).rows;
    const items = plan.items.map((i) => {
      const r = rows.find((x: Row) => x.item_kind === i.kind && x.item_key === i.key && x.content_sha256 === i.sha256);
      return { kind: i.kind, key: i.key, version: i.label, status: r ? (r.status as string) : 'NONE', verifiedAt: (r?.verified_at as Date | undefined) ?? null };
    });
    const backedUp = plan.problems.length === 0 && items.every((i) => i.status === 'VERIFIED');
    const record = items.find((i) => i.kind === 'RECORD');
    const base = { found: true as const, backedUp, latestVersion: record?.version ?? null, verifiedAt: backedUp ? (items.map((i) => i.verifiedAt as Date).sort((a, b) => +a - +b)[0]?.toISOString() ?? null) : null, items: items.map(({ kind, key, version, status }) => ({ kind, key, version, status })) };
    if (!backedUp) return { ...base, ready: false, reason: plan.problems.length ? 'SOURCE_INCOMPLETE' : 'BACKUP_NOT_CURRENT' };
    if (!opts.live) return { ...base, ready: null, reason: 'LIVE_CHECK_REQUIRED' };
    try {
      const r = await this.liveCheck(plan);
      return r === 'OK' ? { ...base, ready: true, reason: null } : { ...base, ready: false, reason: typeof r === 'string' ? r : r instanceof DriveAuthError ? r.code : 'DRIVE_UNREACHABLE' };
    } catch (e) {
      return { ...base, ready: false, reason: e instanceof DriveAuthError ? e.code : 'DRIVE_UNREACHABLE' };
    }
  }
}
