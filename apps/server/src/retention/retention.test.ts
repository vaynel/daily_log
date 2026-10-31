import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { AttachmentService } from '../attachments/service.js';
import { loadAuthConfig, type AuthConfig } from '../auth/config.js';
import { startMockIssuer } from '../auth/mock-issuer.js';
import { OidcClient } from '../auth/oidc.js';
import { sign } from '../auth/session.js';
import { PgDriveConnections } from '../backup/connections.js';
import { createDriveFactory } from '../backup/drive.js';
import { startFakeDrive } from '../backup/fakeDrive.testutil.js';
import { buildBackupPlan } from '../backup/plan.js';
import { BACKUP_KIND, BackupService } from '../backup/service.js';
import { TokenVault } from '../backup/vault.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue } from '../jobs/queue.js';
import { createTempSchema } from '../records/db.testutil.js';
import { RecordError, RecordStore } from '../records/store.js';
import { addCalendarMonthSeoul, addTrashPeriod } from '../records/time.js';
import { RetentionService } from './service.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret-value';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DAY = 24 * 3600 * 1000;
const iso = (s: string) => new Date(s);

describe.skipIf(!url)('휴지통·복구·영구 삭제·보관 수명 (실제 PostgreSQL 임시 스키마 + 가짜 Drive)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let drive: Awaited<ReturnType<typeof startFakeDrive>>;
  let issuer: Awaited<ReturnType<typeof startMockIssuer>>;
  let dir: string;
  let cfg: AuthConfig;
  let seq = 0;

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    drive = await startFakeDrive();
    issuer = await startMockIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-retention-'));
    cfg = loadAuthConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
  });
  afterAll(async () => {
    await pool.end();
    await t.drop();
    await drive.close();
    await issuer.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => { // 훑기는 스키마 전체를 대상으로 하므로 시험마다 비운다(Drive 쪽 가짜 파일은 기록 id 로 구분된다)
    await pool.query('DELETE FROM jobs');
    await pool.query('DELETE FROM purge_file_queue');
    await pool.query('DELETE FROM interviews');
  });
  afterEach(() => {
    Object.assign(drive.state, { limit: null, usage: 0, failUploads: 0, loseUploadResponse: false, corruptNextUpload: false, unauthorized: false, rejectQuota: false });
    issuer.state.refreshServerError = false;
    for (const f of drive.files.values()) delete f.md5Override;
  });

  /** 소유자 한 명 분량의 기록(대화·요약·첨부·영상·음성)과 백업·보존 서비스. at 은 기록 최초 저장 시각이다. */
  async function world(o: { at?: Date; connect?: boolean; attachment?: Buffer; owner?: string } = {}) {
    const n = ++seq;
    const at = o.at ?? new Date();
    const owner = o.owner ?? `owner-${n}`;
    const store = new RecordStore(pool);
    const connections = new PgDriveConnections(pool, new TokenVault(SECRET));
    if (o.connect !== false) {
      const refresh = `mock-refresh-${randomUUID()}`;
      issuer.state.refreshTokens.add(refresh);
      await connections.save(owner, 'owner@example.test', refresh, DRIVE_SCOPE);
    }
    const handlers: ConstructorParameters<typeof JobQueue>[0]['handlers'] = {};
    const queue: JobQueue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers, leaseMs: 60000, permissionRestored: (j) => backup.permissionRestored(j) });
    const backup: BackupService = new BackupService({
      pool, queue, fileStorageDir: dir, connections,
      drive: createDriveFactory({ connections, oidc: new OidcClient(cfg), apiBase: drive.apiBase, uploadBase: drive.uploadBase }),
    });
    handlers[BACKUP_KIND] = backup.handlers();
    const retention = new RetentionService({ pool, fileStorageDir: dir, backup });
    const { interview } = await store.startInterview(owner, at, o.at ? undefined : undefined);
    const item = await store.saveItem(owner, interview.id, 'q1', 'QUESTION', `질문 ${n}`, at);
    await store.saveItem(owner, interview.id, 'a1', 'ANSWER', `답변 ${n}`, at);
    const attBytes = o.attachment ?? Buffer.from(`# 메모 ${n}\n내용`);
    const att = await new AttachmentService(store, dir).upload({ ownerId: owner, interviewId: interview.id, key: 'att1', kind: 'MARKDOWN', name: 'note.md', bytes: attBytes, itemId: item.id, now: at });
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: `요약 ${n}`, learning: [] }, at);
    const videoBytes = Buffer.from(`fake-mp4-bytes-${n}-`.repeat(50));
    const videoName = `day-${n}.mp4`;
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    await writeFile(path.join(dir, 'videos', videoName), videoBytes);
    await store.appendVersion(owner, interview.id, 'RESULT', { file: videoName }, at);
    const audio = await store.saveAudioSegment(owner, interview.id, 'audio1', at);
    const drain = async () => { for (let i = 0; i < 10 && (await queue.tick()); i++); };
    const runBackup = async () => { await backup.enqueueInterview(interview.id); await drain(); };
    const attFile = path.join(dir, 'attachments', att.storageKey);
    return { n, owner, at, store, connections, queue, backup, retention, interview, item, att, attFile, attBytes, videoBytes, videoName, audio, drain, runBackup };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const count = async (table: string, w: World, extra = '') => Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE interview_id=$1 ${extra}`, [w.interview.id])).rows[0].n);
  const exists = (f: string) => stat(f).then(() => true, () => false);
  const interviewRow = async (w: World) => (await pool.query('SELECT * FROM interviews WHERE id=$1', [w.interview.id])).rows[0];

  describe('AC-1/AC-6 음성 수명', () => {
    it('전사·요약이 저장된 PROCESSED 음성은 바로 삭제되고, 처리 전 음성은 달력 한 달 전에는 남는다', async () => {
      const w = await world();
      await w.store.setAudioStatus(w.owner, w.interview.id, w.audio.id, 'PROCESSED', w.at);
      const w2 = await world();
      const r = await w.retention.sweepAudio(new Date(w.at.getTime() + 60_000));
      expect(r.early).toBe(1);
      expect((await pool.query('SELECT status, delete_reason FROM audio_segments WHERE id=$1', [w.audio.id])).rows[0]).toEqual({ status: 'DELETED', delete_reason: 'EARLY_PROCESSED' });
      expect((await pool.query('SELECT status FROM audio_segments WHERE id=$1', [w2.audio.id])).rows[0].status).toBe('UNPROCESSED');
    });
    it('PROCESSED 라도 요약이 없으면 조기 삭제하지 않는다', async () => {
      const w = await world();
      await pool.query("DELETE FROM record_versions WHERE interview_id=$1 AND kind='SUMMARY'", [w.interview.id]);
      await w.store.setAudioStatus(w.owner, w.interview.id, w.audio.id, 'PROCESSED', w.at);
      expect((await w.retention.sweepAudio(new Date(w.at.getTime() + 60_000))).early).toBe(0);
    });
    it.each([
      ['말일 1/31 → 2/28', '2026-01-31T10:00:00+09:00', '2026-02-28T10:00:00+09:00'],
      ['윤년 1/31 → 2/29', '2028-01-31T10:00:00+09:00', '2028-02-29T10:00:00+09:00'],
      ['12/31 → 1/31', '2026-12-31T23:30:00+09:00', '2027-01-31T23:30:00+09:00'],
      ['일반 10/15 → 11/15', '2026-10-15T09:00:00+09:00', '2026-11-15T09:00:00+09:00'],
    ])('미변환 음성 %s: 만료 1ms 전에는 남고 만료 시각에 삭제된다', async (_n, saved, expiry) => {
      const w = await world({ at: iso(saved), connect: false });
      expect(w.audio.expiresAt.toISOString()).toBe(iso(expiry).toISOString());
      expect((await w.retention.sweepAudio(new Date(iso(expiry).getTime() - 1))).expired).toBe(0);
      expect((await w.retention.sweepAudio(iso(expiry))).expired).toBe(1);
      expect((await pool.query('SELECT status, delete_reason FROM audio_segments WHERE id=$1', [w.audio.id])).rows[0]).toEqual({ status: 'DELETED', delete_reason: 'MONTH_EXPIRED' });
    });
    it('재접속(이어하기)해도 만료 시각은 늘어나지 않고, Drive 미연결이어도 Drive 확인 없이 삭제된다', async () => {
      const w = await world({ at: iso('2026-03-10T09:00:00+09:00'), connect: false });
      await w.store.startInterview(w.owner, iso('2026-04-09T09:00:00+09:00'), w.interview.lifeDate); // 만료 1일 전 재접속
      const a = await w.store.saveAudioSegment(w.owner, w.interview.id, 'audio1', iso('2026-04-09T09:00:00+09:00'));
      expect(a.expiresAt.toISOString()).toBe(w.audio.expiresAt.toISOString());
      const spy = vi.spyOn(w.backup, 'cleanupReadiness');
      const r = await w.retention.sweepAudio(iso('2026-04-10T09:00:00+09:00'));
      expect(r.expired).toBe(1);
      expect(spy).not.toHaveBeenCalled();
      expect(drive.log.filter((l) => l.method !== 'GET' && l.method !== 'POST' && l.method !== 'PUT')).toEqual([]);
    });
    it('처리 중인 작업이 그 기록을 참조하는 동안은 미루고 종료 후 정리한다', async () => {
      const w = await world({ at: iso('2026-05-01T09:00:00+09:00'), connect: false });
      const job = await pool.query("INSERT INTO jobs (kind, subject_id, stages, idempotency_key, state) VALUES ('video', $1, ARRAY['render'], $2, 'RUNNING') RETURNING id", [w.interview.id, `k-${randomUUID()}`]);
      const late = iso('2026-06-02T09:00:00+09:00');
      expect(await w.retention.sweepAudio(late)).toMatchObject({ expired: 0, deferred: 1 });
      expect((await pool.query('SELECT status FROM audio_segments WHERE id=$1', [w.audio.id])).rows[0].status).toBe('UNPROCESSED');
      await pool.query("UPDATE jobs SET state='SUCCEEDED' WHERE id=$1", [job.rows[0].id]);
      expect(await w.retention.sweepAudio(late)).toMatchObject({ expired: 1, deferred: 0 });
    });
    it('삭제된 음성은 처리 상태를 바꿀 수 없고, 백업 대상 목록에는 어떤 상태의 음성도 없다', async () => {
      const w = await world();
      const plan = await buildBackupPlan(pool, dir, w.interview.id);
      expect(plan!.items.map((i) => i.kind).sort()).toEqual(['ATTACHMENT', 'RECORD', 'VIDEO']);
      const snap = Buffer.from((plan!.items.find((i) => i.kind === 'RECORD')!.source as { bytes: Buffer }).bytes).toString();
      expect(snap).not.toMatch(/audio/i);
      await w.retention.sweepAudio(new Date(w.at.getTime() + 40 * DAY));
      await expect(w.store.setAudioStatus(w.owner, w.interview.id, w.audio.id, 'PROCESSED', new Date(w.at.getTime() + 41 * DAY))).rejects.toMatchObject({ code: 'AUDIO_EXPIRED' });
      await w.runBackup();
      expect(drive.uploaded().filter((f) => f.appProperties.dlInterview === w.interview.id).map((f) => f.appProperties.dlKind).sort()).toEqual(['ATTACHMENT', 'RECORD', 'VIDEO']);
    });
  });

  describe('AC-2 휴지통 30일 복구 (주입 시계)', () => {
    it('삭제 후 30일 − 1ms 까지 복구되고 정확히 30일에는 복구되지 않는다. 재삭제는 보관 기간을 늘리지 않는다', async () => {
      const w = await world({ connect: false });
      const T = iso('2026-02-01T12:00:00+09:00');
      const first = await w.store.trashRecord(w.owner, w.interview.id, T);
      expect(first.purgeAt.toISOString()).toBe(addTrashPeriod(T).toISOString());
      expect(first.purgeAt.getTime() - T.getTime()).toBe(30 * DAY);
      const again = await w.store.trashRecord(w.owner, w.interview.id, new Date(T.getTime() + 10 * DAY));
      expect(again).toMatchObject({ duplicate: true });
      expect(again.purgeAt.getTime()).toBe(first.purgeAt.getTime());
      await expect(w.store.restoreRecord(w.owner, w.interview.id, new Date(T.getTime() + 30 * DAY))).rejects.toMatchObject({ code: 'TRASH_EXPIRED' });
      await w.store.restoreRecord(w.owner, w.interview.id, new Date(T.getTime() + 30 * DAY - 1));
      expect((await interviewRow(w)).deleted_at).toBeNull();
      expect((await w.store.load(w.owner, w.interview.lifeDate, T))!.items).toHaveLength(2);
      await expect(w.store.restoreRecord(w.owner, w.interview.id, T)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });
    it('휴지통의 기록은 목록·상세·쓰기·재시작에서 막히고 타 소유자는 만질 수 없다', async () => {
      const w = await world({ connect: false });
      await w.store.trashRecord(w.owner, w.interview.id, w.at);
      expect((await w.store.listRecords(w.owner, { limit: 50 })).rows.find((r) => r.id === w.interview.id)).toBeUndefined();
      expect(await w.store.loadById(w.owner, w.interview.id, w.at)).toBeNull();
      await expect(w.store.saveItem(w.owner, w.interview.id, 'k9', 'ANSWER', 'x', w.at)).rejects.toMatchObject({ code: 'RECORD_IN_TRASH' });
      await expect(w.store.startInterview(w.owner, w.at, w.interview.lifeDate)).rejects.toMatchObject({ code: 'RECORD_IN_TRASH' });
      await expect(w.store.trashRecord('someone-else', w.interview.id, w.at)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(w.store.restoreRecord('someone-else', w.interview.id, w.at)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const trash = await w.store.listTrash(w.owner, w.at);
      expect(trash).toMatchObject([{ scope: 'RECORD', id: w.interview.id, canRestore: true }]);
      expect(await w.store.listTrash(w.owner, new Date(w.at.getTime() + 31 * DAY))).toMatchObject([{ canRestore: false }]);
    });
    it('항목을 지우면 연결된 첨부도 함께 지워지고, 항목 복구 때 같이 돌아온다. 일부 삭제는 하루 기록을 그대로 둔다', async () => {
      const w = await world({ connect: false });
      const T = iso('2026-03-01T09:00:00+09:00');
      await w.store.trashItem(w.owner, w.interview.id, w.item.id, T);
      const snap = await w.store.load(w.owner, w.interview.lifeDate, T);
      expect(snap!.items.map((i) => i.id)).not.toContain(w.item.id);
      expect(snap!.attachments).toHaveLength(0);
      await expect(w.store.restoreAttachment(w.owner, w.interview.id, w.att.id, T)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(w.store.restoreItem(w.owner, w.interview.id, w.item.id, new Date(T.getTime() + 30 * DAY))).rejects.toMatchObject({ code: 'TRASH_EXPIRED' });
      await w.store.restoreItem(w.owner, w.interview.id, w.item.id, new Date(T.getTime() + 29 * DAY));
      const back = await w.store.load(w.owner, w.interview.lifeDate, T);
      expect(back!.items).toHaveLength(2);
      expect(back!.attachments).toHaveLength(1);
      // 첨부 하나만 삭제·복구
      await w.store.trashAttachment(w.owner, w.interview.id, w.att.id, T);
      expect((await w.store.listAttachments(w.owner, w.interview.id))).toHaveLength(0);
      expect((await w.store.listTrash(w.owner, T)).map((e) => e.scope)).toEqual(['ATTACHMENT']);
      await w.store.restoreAttachment(w.owner, w.interview.id, w.att.id, T);
      expect((await w.store.listAttachments(w.owner, w.interview.id))).toHaveLength(1);
    });
  });

  describe('AC-3/AC-5 삭제 반영 범위 (데이터 추적)', () => {
    /** 서버 사본이 지워진 뒤에도 남아야 하는 것: 완성 영상 파일·RESULT 버전·Drive 파일과 백업 기록. */
    async function expectKept(w: World, drive0: Map<string, Buffer>, backupRows: unknown[]) {
      expect(await readFile(path.join(dir, 'videos', w.videoName))).toEqual(w.videoBytes);
      expect((await pool.query("SELECT version FROM record_versions WHERE interview_id=$1 AND kind='RESULT'", [w.interview.id])).rows).toEqual([{ version: 1 }]);
      for (const [id, bytes] of drive0) { expect(drive.files.get(id)?.bytes.equals(bytes)).toBe(true); expect(drive.files.get(id)?.trashed).toBe(false); }
      expect((await pool.query('SELECT id, status, drive_file_id, drive_md5 FROM backup_items WHERE interview_id=$1 ORDER BY id', [w.interview.id])).rows).toEqual(backupRows);
      expect(drive.log.filter((l) => l.method === 'DELETE' || l.method === 'PATCH')).toEqual([]);
    }
    const driveSnapshot = () => new Map(drive.uploaded().map((f) => [f.id, f.bytes]));
    const backupRowsOf = async (w: World) => (await pool.query('SELECT id, status, drive_file_id, drive_md5 FROM backup_items WHERE interview_id=$1 ORDER BY id', [w.interview.id])).rows;

    it('즉시 영구 삭제: 대화·첨부·요약·음성은 지우고 완성 영상·Drive 백업·백업 기록은 그대로 둔다', async () => {
      const w = await world();
      await w.runBackup();
      const d0 = driveSnapshot();
      const rows = await backupRowsOf(w);
      expect(rows).toHaveLength(3);
      await w.store.trashRecord(w.owner, w.interview.id, w.at);
      await w.retention.purgeNow(w.owner, { scope: 'RECORD', interviewId: w.interview.id }, new Date(w.at.getTime() + DAY));
      expect(await count('conversation_items', w)).toBe(0);
      expect(await count('attachment_refs', w)).toBe(0);
      expect(await count('audio_segments', w)).toBe(0);
      expect(await count('record_versions', w, "AND kind IN ('SUMMARY','PRODUCTION_PLAN')")).toBe(0);
      expect(await exists(w.attFile)).toBe(false);
      expect((await interviewRow(w)).server_purged_at).not.toBeNull();
      expect(await w.store.loadById(w.owner, w.interview.id, w.at)).toBeNull();
      expect(await w.store.listTrash(w.owner, w.at)).toEqual([]);
      await expectKept(w, d0, rows);
      // 백업 훑기는 지워진 기록을 빈 스냅샷으로 다시 올리지 않는다
      const up = drive.state.uploads;
      await w.backup.sweep(); await w.drain();
      expect(drive.state.uploads).toBe(up);
      // 같은 생활일을 다시 시작할 수 있다
      const fresh = await w.store.startInterview(w.owner, w.at, w.interview.lifeDate);
      expect(fresh.interview.id).not.toBe(w.interview.id);
    });
    it('30일 만료 삭제: 29일 23시간에는 남고 30일에 같은 범위가 지워진다', async () => {
      const w = await world();
      await w.runBackup();
      const d0 = driveSnapshot();
      const rows = await backupRowsOf(w);
      const T = iso('2026-04-01T09:00:00+09:00');
      await w.store.trashRecord(w.owner, w.interview.id, T);
      expect(await w.retention.sweepTrash(new Date(T.getTime() + 30 * DAY - 1))).toEqual({ records: 0, items: 0, attachments: 0 });
      expect(await count('conversation_items', w)).toBe(2);
      expect(await exists(w.attFile)).toBe(true);
      expect((await w.retention.sweepTrash(new Date(T.getTime() + 30 * DAY))).records).toBe(1);
      expect(await count('conversation_items', w)).toBe(0);
      expect(await exists(w.attFile)).toBe(false);
      await expectKept(w, d0, rows);
    });
    it('항목 만료 삭제: 지운 항목과 그 첨부만 사라지고 나머지는 남는다', async () => {
      const w = await world({ connect: false });
      const T = iso('2026-04-01T09:00:00+09:00');
      await w.store.trashItem(w.owner, w.interview.id, w.item.id, T);
      expect((await w.retention.sweepTrash(new Date(T.getTime() + 30 * DAY))).items).toBe(1);
      expect(await count('conversation_items', w)).toBe(1);
      expect(await count('attachment_refs', w)).toBe(0);
      expect(await exists(w.attFile)).toBe(false);
    });
    it('복구 경쟁: 잠금 뒤 복구된 기록은 만료 훑기가 지우지 않는다', async () => {
      const w = await world({ connect: false });
      const T = iso('2026-04-01T09:00:00+09:00');
      await w.store.trashRecord(w.owner, w.interview.id, T);
      await w.store.restoreRecord(w.owner, w.interview.id, new Date(T.getTime() + DAY));
      expect((await w.retention.sweepTrash(new Date(T.getTime() + 31 * DAY))).records).toBe(0);
      expect(await count('conversation_items', w)).toBe(2);
    });
  });

  describe('AC-4 공유 첨부', () => {
    it('같은 파일을 두 기록이 가리킬 때 한쪽을 지워도 다른 기록의 첨부 파일은 남고, 마지막 참조가 사라지면 파일도 지워진다', async () => {
      const shared = Buffer.from(`공유 첨부 ${randomUUID()}`);
      const a = await world({ connect: false, attachment: shared });
      const b = await world({ connect: false, attachment: shared, owner: a.owner, at: new Date(a.at.getTime() + 2 * DAY) });
      expect(b.att.storageKey).toBe(a.att.storageKey);
      await a.retention.purgeNow(a.owner, { scope: 'RECORD', interviewId: a.interview.id }, a.at);
      expect(await exists(a.attFile)).toBe(true);
      expect(await readFile(a.attFile)).toEqual(shared);
      expect((await b.store.load(b.owner, b.interview.lifeDate, b.at))!.attachments).toHaveLength(1);
      // 휴지통의 참조도 참조다
      await b.store.trashAttachment(b.owner, b.interview.id, b.att.id, b.at);
      await b.retention.drainFileQueue();
      expect(await exists(b.attFile)).toBe(true);
      await b.retention.purgeNow(b.owner, { scope: 'ATTACHMENT', interviewId: b.interview.id, id: b.att.id }, b.at);
      expect(await exists(b.attFile)).toBe(false);
    });
    it('삭제하려는 사이 같은 내용이 새로 첨부되면 파일을 지우지 않는다(대기열 재확인)', async () => {
      const bytes = Buffer.from(`경쟁 첨부 ${randomUUID()}`);
      const a = await world({ connect: false, attachment: bytes });
      await a.retention.purgeNow(a.owner, { scope: 'ATTACHMENT', interviewId: a.interview.id, id: a.att.id }, a.at);
      expect(await exists(a.attFile)).toBe(false);
      // 대기열에 키가 남아 있는 상태에서 같은 내용을 새로 올린다
      await pool.query('INSERT INTO purge_file_queue (storage_key) VALUES ($1) ON CONFLICT DO NOTHING', [a.att.storageKey]);
      const again = await new AttachmentService(a.store, dir).upload({ ownerId: a.owner, interviewId: a.interview.id, key: 'att-again', kind: 'MARKDOWN', name: 'note.md', bytes, now: a.at });
      expect(again.storageKey).toBe(a.att.storageKey);
      await a.retention.drainFileQueue();
      expect(await readFile(a.attFile)).toEqual(bytes);
      expect(Number((await pool.query('SELECT count(*) AS n FROM purge_file_queue WHERE storage_key=$1', [a.att.storageKey])).rows[0].n)).toBe(0);
    });
    it('파일 삭제가 실패하면 대기열에 남겨 다음 훑기에서 다시 시도한다', async () => {
      const a = await world({ connect: false, attachment: Buffer.from(`삭제 실패 ${randomUUID()}`) });
      await rm(a.attFile);
      await mkdir(a.attFile); // 같은 이름의 디렉터리: 파일 삭제가 실패한다
      await a.retention.purgeNow(a.owner, { scope: 'ATTACHMENT', interviewId: a.interview.id, id: a.att.id }, a.at);
      const q = (await pool.query('SELECT attempts, last_error FROM purge_file_queue WHERE storage_key=$1', [a.att.storageKey])).rows[0];
      expect(q.attempts).toBe(1);
      expect(q.last_error).toBeTruthy();
      await rm(a.attFile, { recursive: true });
      await writeFile(a.attFile, 'x');
      expect(await a.retention.drainFileQueue()).toMatchObject({ deleted: 1 });
      expect(await exists(a.attFile)).toBe(false);
    });
  });

  describe('AC-5 한 달 서버 사본 정리', () => {
    const afterMonth = (w: World) => new Date(addCalendarMonthSeoul(w.at).getTime() + 1000);
    const serverCopy = async (w: World) => ({
      items: (await pool.query('SELECT seq, body FROM conversation_items WHERE interview_id=$1 ORDER BY seq', [w.interview.id])).rows,
      atts: (await pool.query('SELECT storage_key, checksum FROM attachment_refs WHERE interview_id=$1', [w.interview.id])).rows,
      versions: (await pool.query('SELECT kind, version FROM record_versions WHERE interview_id=$1 ORDER BY kind', [w.interview.id])).rows,
      file: await readFile(w.attFile).catch(() => null),
    });
    const reason = async (w: World) => (await interviewRow(w)).cleanup_blocked_reason as string | null;

    it('최신 백업이 검증되면 서버 텍스트·첨부 사본만 정리하고 Drive 파일 해시·완성 영상은 그대로다', async () => {
      const w = await world();
      await w.runBackup();
      const d0 = new Map(drive.uploaded().map((f) => [f.id, sha(f.bytes)]));
      const attSha = sha(w.attBytes);
      expect([...d0.values()]).toContain(attSha); // Drive 의 첨부 사본 = 서버 첨부와 같은 해시
      expect(await w.retention.sweepMonthly(new Date(afterMonth(w).getTime() - 2000))).toEqual({ cleaned: 0, blocked: 0 }); // 한 달 전에는 후보가 아님
      expect(await w.retention.sweepMonthly(afterMonth(w))).toEqual({ cleaned: 1, blocked: 0 });
      expect(await serverCopy(w)).toEqual({ items: [], atts: [], versions: [{ kind: 'RESULT', version: 1 }], file: null });
      const row = await interviewRow(w);
      expect(row.server_cleaned_at).not.toBeNull();
      expect(row.cleanup_blocked_reason).toBeNull();
      expect(await readFile(path.join(dir, 'videos', w.videoName))).toEqual(w.videoBytes);
      for (const [id, h] of d0) expect(sha(drive.files.get(id)!.bytes)).toBe(h);
      expect(drive.log.filter((l) => l.method === 'DELETE' || l.method === 'PATCH')).toEqual([]);
      expect((await pool.query("SELECT count(*) AS n FROM backup_items WHERE interview_id=$1 AND status='VERIFIED'", [w.interview.id])).rows[0].n).toBe('3');
      // 정리된 기록은 쓰기·재시작이 거부되고, 백업 훑기가 빈 스냅샷을 올리지 않는다
      await expect(w.store.saveItem(w.owner, w.interview.id, 'k-late', 'ANSWER', 'x', afterMonth(w))).rejects.toMatchObject({ code: 'SERVER_CLEANED' });
      const up = drive.state.uploads;
      await w.backup.sweep(); await w.drain();
      expect(drive.state.uploads).toBe(up);
    });
    it('백업이 없거나 최신이 아니면 원본을 보존하고 대기 사유를 남긴다', async () => {
      const w = await world();
      const before = await serverCopy(w);
      expect(await w.retention.sweepMonthly(afterMonth(w))).toEqual({ cleaned: 0, blocked: 1 });
      expect(await serverCopy(w)).toEqual(before);
      expect(await reason(w)).toBe('BACKUP_NOT_CURRENT');
      await w.runBackup();
      await w.store.appendVersion(w.owner, w.interview.id, 'SUMMARY', { diary: '백업 뒤에 바뀐 요약', learning: [] }, w.at); // 새 revision 은 아직 백업 전
      const changed = await serverCopy(w);
      expect(await w.retention.sweepMonthly(afterMonth(w))).toEqual({ cleaned: 0, blocked: 1 });
      expect(await serverCopy(w)).toEqual(changed);
      expect(await reason(w)).toBe('BACKUP_NOT_CURRENT');
      await w.runBackup(); // 최신 버전을 백업하면 정리된다
      expect(await w.retention.sweepMonthly(afterMonth(w))).toEqual({ cleaned: 1, blocked: 0 });
    });
    it('Drive 파일이 변조되거나 접근할 수 없으면(백업 장애) 원본을 보존한다', async () => {
      const w = await world();
      await w.runBackup();
      const before = await serverCopy(w);
      const file = drive.uploaded().find((f) => f.appProperties.dlInterview === w.interview.id && f.appProperties.dlKind === 'ATTACHMENT')!;
      file.md5Override = '0'.repeat(32);
      await w.retention.sweepMonthly(afterMonth(w));
      expect(await reason(w)).toBe('VERIFY_MISMATCH');
      delete file.md5Override;
      drive.state.unauthorized = true;
      await w.retention.sweepMonthly(afterMonth(w));
      expect(await reason(w)).toMatch(/^DRIVE_/);
      expect(await serverCopy(w)).toEqual(before);
      expect((await interviewRow(w)).server_cleaned_at).toBeNull();
      drive.state.unauthorized = false;
      await w.connections.markExpired(w.owner, 'TEST');
      await w.retention.sweepMonthly(afterMonth(w));
      expect(await reason(w)).toBe('DRIVE_AUTH_EXPIRED');
      expect(await serverCopy(w)).toEqual(before);
    });
    it('Drive 미연결이면 정리하지 않는다', async () => {
      const w = await world({ connect: false });
      const before = await serverCopy(w);
      expect((await w.retention.sweepMonthly(afterMonth(w))).blocked).toBe(1);
      expect(await serverCopy(w)).toEqual(before);
      expect(await reason(w)).toBeTruthy();
    });
    it('진행 중인 작업이 있거나 휴지통에 있는 기록은 정리하지 않는다', async () => {
      const w = await world();
      await w.runBackup();
      await pool.query("INSERT INTO jobs (kind, subject_id, stages, idempotency_key, state) VALUES ('video', $1, ARRAY['render'], $2, 'QUEUED')", [w.interview.id, `k-${randomUUID()}`]);
      expect(await w.retention.sweepMonthly(afterMonth(w))).toEqual({ cleaned: 0, blocked: 1 });
      expect(await reason(w)).toBe('PROCESSING');
      await pool.query("UPDATE jobs SET state='SUCCEEDED' WHERE subject_id=$1", [w.interview.id]);
      await w.store.trashRecord(w.owner, w.interview.id, w.at);
      expect(await w.retention.sweepMonthly(afterMonth(w))).toEqual({ cleaned: 0, blocked: 0 });
      expect(await count('conversation_items', w)).toBe(2);
      expect(await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true })).toMatchObject({ ready: false, reason: 'IN_TRASH' });
    });
    it('확인하는 사이 내용이 바뀌면 지우지 않는다', async () => {
      const w = await world();
      await w.runBackup();
      const real = w.backup.cleanupReadiness.bind(w.backup);
      vi.spyOn(w.backup, 'cleanupReadiness').mockImplementation(async (...a) => {
        const r = await real(...a);
        await w.store.appendVersion(w.owner, w.interview.id, 'SUMMARY', { diary: '확인 중 변경', learning: [] }, w.at);
        return r;
      });
      expect((await w.retention.sweepMonthly(afterMonth(w))).cleaned).toBe(0);
      expect(await reason(w)).toBe('CHANGED_DURING_CHECK');
      expect(await count('conversation_items', w)).toBe(2);
    });
  });

  describe('HTTP 명령', () => {
    let app: FastifyInstance;
    let w: World;
    const cookie = (sub: string) => { const iat = Math.floor(Date.now() / 1000); return `dl_session=${sign({ sub, email: 'owner@example.test', iat, exp: iat + 3600 }, SECRET, 'session')}`; };
    const call = (method: 'GET' | 'POST', u: string, owner: string, payload?: object) => app.inject({ method, url: u, headers: { cookie: cookie(owner) }, ...(payload ? { payload } : {}) });
    beforeAll(async () => {
      const store = new RecordStore(pool);
      app = buildApp({ auth: cfg, sessionSecret: SECRET, fileStorageDir: dir, records: store, retention: new RetentionService({ pool, fileStorageDir: dir, backup: { cleanupReadiness: async () => ({ found: false }) } }) });
      await app.ready();
    });
    afterAll(() => app.close());
    it('삭제 → 목록에서 사라짐 → 휴지통 목록(범위 안내) → 복구, 영구 삭제는 확인이 있어야 하며 타 소유자는 404', async () => {
      w = await world({ connect: false });
      const id = w.interview.id;
      const del = await call('POST', `/api/records/${id}/trash`, w.owner);
      expect(del.statusCode).toBe(200);
      expect(del.json().notice).toContain('Google Drive 백업과 완성 영상은 지워지지 않습니다');
      expect((await call('GET', '/api/records', w.owner)).json().records.map((r: { id: string }) => r.id)).not.toContain(id);
      expect((await call('GET', `/api/records/${id}`, w.owner)).statusCode).toBe(404);
      const trash = (await call('GET', '/api/trash', w.owner)).json();
      expect(trash.entries).toMatchObject([{ scope: 'RECORD', id, canRestore: true }]);
      expect((await call('GET', '/api/trash', 'owner-other')).json().entries).toEqual([]);
      expect((await call('POST', `/api/records/${id}/restore`, 'owner-other')).statusCode).toBe(404);
      expect((await call('POST', `/api/records/${id}/purge`, w.owner, {})).statusCode).toBe(422);
      expect((await call('POST', `/api/records/${id}/restore`, w.owner)).statusCode).toBe(200);
      expect((await call('GET', `/api/records/${id}`, w.owner)).statusCode).toBe(200);
      const item = await call('POST', `/api/records/${id}/items/${w.item.id}/trash`, w.owner);
      expect(item.statusCode).toBe(200);
      expect((await call('GET', `/api/records/${id}`, w.owner)).json().conversation.map((c: { id: string }) => c.id)).not.toContain(w.item.id);
      expect((await call('POST', `/api/records/${id}/items/${w.item.id}/purge`, w.owner, { confirm: true })).statusCode).toBe(200);
      expect((await call('POST', `/api/records/${id}/purge`, w.owner, { confirm: true })).statusCode).toBe(200);
      expect((await call('POST', `/api/records/${id}/restore`, w.owner)).statusCode).toBe(404);
    });
    it('RecordError 코드는 상태 코드로 구분된다', () => {
      expect(new RecordError('TRASH_EXPIRED', 'x').code).toBe('TRASH_EXPIRED');
    });
  });
});
