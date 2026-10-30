import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { RecordStore } from '../records/store.js';
import { addCalendarMonthSeoul, addTrashPeriod } from '../records/time.js';
import { RetentionService, type Readiness } from './service.js';
import { retentionNotice } from './view.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const DAY = 86_400_000;
const T0 = new Date('2025-01-31T01:00:00Z'); // 2025-01-31 10:00 KST
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const exists = (p: string) => stat(p).then(() => true, () => false);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('달력 한 달·휴지통 기간 계산(주입 시계)', () => {
  it('Asia/Seoul 달력 한 달: 1/31→2/28, 윤년 2/29, 연말 12/31→1/31, 31일→30일 달', () => {
    expect(addCalendarMonthSeoul(new Date('2025-01-31T01:00:00Z')).toISOString()).toBe('2025-02-28T01:00:00.000Z');
    expect(addCalendarMonthSeoul(new Date('2024-01-31T01:00:00Z')).toISOString()).toBe('2024-02-29T01:00:00.000Z');
    expect(addCalendarMonthSeoul(new Date('2024-12-31T01:00:00Z')).toISOString()).toBe('2025-01-31T01:00:00.000Z');
    expect(addCalendarMonthSeoul(new Date('2025-03-31T01:00:00Z')).toISOString()).toBe('2025-04-30T01:00:00.000Z');
    // UTC 로는 전날이지만 서울로는 말일: 1/30 16:00Z = 1/31 01:00 KST
    expect(addCalendarMonthSeoul(new Date('2025-01-30T16:00:00Z')).toISOString()).toBe('2025-02-27T16:00:00.000Z');
  });
  it('휴지통 기간은 삭제 시각 + 정확히 30일', () => {
    expect(addTrashPeriod(T0).getTime() - T0.getTime()).toBe(30 * DAY);
  });
});

describe('서버 사본 안내 문구', () => {
  const base = { trashPurgeAt: new Date('2025-03-02T01:00:00Z'), cleanupDueAt: new Date('2025-02-28T01:00:00Z'), cleanupBlockedReason: null };
  it('서버 삭제와 Drive 백업·완성 영상 보존을 구분하고 전체 삭제라고 말하지 않는다', () => {
    for (const serverCopy of ['TRASHED', 'CLEANED', 'PURGED'] as const) {
      const n = retentionNotice({ ...base, serverCopy }, T0);
      expect(n.message).toMatch(/Drive 백업과 완성 영상은 .*유지/);
      expect(n.message).not.toMatch(/모두 삭제|전체 삭제|완전히 삭제/);
      expect(n.backupKept).toBe(true);
    }
  });
  it('한 달이 지났지만 백업 미확인이면 정리 대기 사유를 보여 준다', () => {
    const n = retentionNotice({ ...base, serverCopy: 'PRESENT', cleanupBlockedReason: 'BACKUP_NOT_CURRENT' }, at(base.cleanupDueAt, 1));
    expect(n.cleanupPending).toMatch(/백업/);
    expect(retentionNotice({ ...base, serverCopy: 'PRESENT', cleanupBlockedReason: 'BACKUP_NOT_CURRENT' }, at(base.cleanupDueAt, -1)).cleanupPending).toBeNull();
  });
});

describe.skipIf(!url)('휴지통·수명 정리 (실제 PostgreSQL 임시 스키마)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let dir: string;
  let readinessCalls: string[];
  let readinessImpl: (owner: string, id: string) => Promise<Readiness>;
  let svc: RetentionService;
  let attachments: AttachmentService;
  let seq = 0;

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-retention-'));
    attachments = new AttachmentService(store, dir);
    svc = new RetentionService({ pool, fileStorageDir: dir, readiness: async (o, i) => { readinessCalls.push(i); return readinessImpl(o, i); } });
  });
  afterAll(async () => {
    await pool.end();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });
  // 정리 훑기는 전체 기록을 대상으로 하므로 시험마다 비우고 시작한다(정확한 건수를 검증하기 위해).
  afterEach(async () => {
    readinessCalls = [];
    readinessImpl = async () => ({ found: true, ready: false, reason: 'BACKUP_NOT_CURRENT' });
    await pool.query('TRUNCATE interviews, purge_file_queue, jobs CASCADE');
  });
  readinessCalls = [];
  readinessImpl = async () => ({ found: true, ready: false, reason: 'BACKUP_NOT_CURRENT' });

  /** 소유자 한 명 분량의 기록. 파일 내용은 인자로 받아 같은 내용을 여러 기록이 공유할 수 있다. */
  async function world(opts: { now?: Date; attBytes?: Buffer; video?: boolean; audio?: boolean } = {}) {
    const now = opts.now ?? T0;
    const n = ++seq;
    const owner = `ret-owner-${n}`;
    const { interview } = await store.startInterview(owner, now);
    const q = await store.saveItem(owner, interview.id, 'q1', 'QUESTION', `질문 ${n}`, now);
    await store.saveItem(owner, interview.id, 'a1', 'ANSWER', `답변 ${n}`, now);
    const att = await attachments.upload({ ownerId: owner, interviewId: interview.id, key: 'att1', kind: 'MARKDOWN', name: 'note.md', bytes: opts.attBytes ?? Buffer.from(`# 메모 ${n}`), itemId: q.id, now });
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: `요약 ${n}`, learning: [] }, now);
    let videoName: string | null = null;
    if (opts.video !== false) {
      videoName = `ret-${n}.mp4`;
      await mkdir(path.join(dir, 'videos'), { recursive: true });
      await writeFile(path.join(dir, 'videos', videoName), Buffer.from(`video-${n}`.repeat(20)));
      await store.appendVersion(owner, interview.id, 'RESULT', { file: videoName }, now);
    }
    let audioId: string | null = null; let audioFile: string | null = null;
    if (opts.audio !== false) {
      const a = await store.saveAudioSegment(owner, interview.id, 'audio1', now);
      audioId = a.id; audioFile = `aud-${n}.webm`;
      await mkdir(path.join(dir, 'audio'), { recursive: true });
      await writeFile(path.join(dir, 'audio', audioFile), Buffer.from(`raw-audio-${n}`));
      await store.attachAudioFile(owner, interview.id, a.id, audioFile);
    }
    return { n, owner, id: interview.id, itemId: q.id, att, videoName, audioId, audioFile, attPath: path.join(dir, 'attachments', att.storageKey) };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const row = async (id: string) => (await pool.query('SELECT * FROM interviews WHERE id=$1', [id])).rows[0];
  const count = async (table: string, id: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE interview_id=$1`, [id])).rows[0].n);

  // ---------------------------------------------------------------- AC-2
  describe('AC-2 휴지통 30일 복구(시계 제어)', () => {
    it('삭제 후 30일 직전까지 복구되고 정확히 30일부터는 복구되지 않는다', async () => {
      const w = await world();
      const del = at(T0, 2 * DAY);
      const r = await store.trashRecord(w.owner, w.id, del);
      expect(r.purgeAt.getTime()).toBe(del.getTime() + 30 * DAY);
      // 목록·상세에서 사라지고 휴지통에 나타난다
      expect((await store.listRecords(w.owner, { limit: 10 })).rows.find((x) => x.id === w.id)).toBeUndefined();
      expect(await store.loadById(w.owner, w.id, del)).toBeNull();
      const trash = await store.listTrash(w.owner, at(del, 29 * DAY));
      expect(trash.records).toMatchObject([{ id: w.id, daysLeft: 1, restorable: true }]);
      // 만료 1ms 전 복구 성공, 내용 그대로
      const ok = await store.restoreRecord(w.owner, w.id, at(del, 30 * DAY - 1));
      expect(ok.restored).toBe(true);
      const snap = await store.loadById(w.owner, w.id, del);
      expect(snap!.items.map((i) => i.body)).toEqual([`질문 ${w.n}`, `답변 ${w.n}`]);
      expect(snap!.attachments).toHaveLength(1);
      expect(await exists(w.attPath)).toBe(true);
    });
    it('정확히 30일(만료 시각)부터는 TRASH_EXPIRED 이고, 하루 29일째는 가능하다', async () => {
      const w = await world();
      const del = at(T0, DAY);
      await store.trashRecord(w.owner, w.id, del);
      await expect(store.restoreRecord(w.owner, w.id, at(del, 30 * DAY))).rejects.toMatchObject({ code: 'TRASH_EXPIRED' });
      await expect(store.restoreRecord(w.owner, w.id, at(del, 31 * DAY))).rejects.toMatchObject({ code: 'TRASH_EXPIRED' });
      expect((await store.restoreRecord(w.owner, w.id, at(del, 29 * DAY))).restored).toBe(true);
    });
    it('이미 삭제한 기록을 다시 삭제해도 보관 시작 시각이 늘어나지 않고, 복구한 기록을 다시 복구해도 안전하다', async () => {
      const w = await world();
      const first = await store.trashRecord(w.owner, w.id, T0);
      const again = await store.trashRecord(w.owner, w.id, at(T0, 10 * DAY));
      expect(again.duplicate).toBe(true);
      expect(again.purgeAt.getTime()).toBe(first.purgeAt.getTime());
      await store.restoreRecord(w.owner, w.id, at(T0, DAY));
      expect((await store.restoreRecord(w.owner, w.id, at(T0, DAY))).duplicate).toBe(true);
    });
    it('휴지통 기록에는 쓰기가 거부되고 같은 날짜로 새 기록을 시작할 수 없으며 타 소유자는 접근할 수 없다', async () => {
      const w = await world({ video: false, audio: false });
      await store.trashRecord(w.owner, w.id, T0);
      await expect(store.saveItem(w.owner, w.id, 'k2', 'ANSWER', 'x', T0)).rejects.toMatchObject({ code: 'IN_TRASH' });
      await expect(store.startInterview(w.owner, T0)).rejects.toMatchObject({ code: 'IN_TRASH' });
      await expect(store.trashRecord('someone-else', w.id, T0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.restoreRecord('someone-else', w.id, T0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await store.listTrash('someone-else', T0)).records).toEqual([]);
    });
    it('기록 일부(대화 항목+연결 첨부, 첨부 한 건) 삭제와 복구도 30일 경계를 따른다', async () => {
      const w = await world({ video: false, audio: false });
      const del = at(T0, DAY);
      await store.trashItem(w.owner, w.id, w.itemId, del);
      let snap = (await store.loadById(w.owner, w.id, del))!;
      expect(snap.items.map((i) => i.body)).toEqual([`답변 ${w.n}`]);
      expect(snap.attachments).toHaveLength(0); // 연결 첨부도 함께
      expect((await store.listTrash(w.owner, del)).parts.map((p) => p.kind).sort()).toEqual(['ITEM']);
      await expect(store.restoreItem(w.owner, w.id, w.itemId, at(del, 30 * DAY))).rejects.toMatchObject({ code: 'TRASH_EXPIRED' });
      await store.restoreItem(w.owner, w.id, w.itemId, at(del, 30 * DAY - 1));
      snap = (await store.loadById(w.owner, w.id, del))!;
      expect(snap.items).toHaveLength(2);
      expect(snap.attachments).toHaveLength(1);
      await store.trashAttachment(w.owner, w.id, w.att.id, del);
      expect((await store.loadById(w.owner, w.id, del))!.attachments).toHaveLength(0);
      await store.restoreAttachment(w.owner, w.id, w.att.id, del);
      expect((await store.loadById(w.owner, w.id, del))!.attachments).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- AC-3
  describe('AC-3 즉시 삭제·30일 만료 삭제의 데이터 추적', () => {
    async function trace(w: W) {
      return {
        items: await count('conversation_items', w.id), atts: await count('attachment_refs', w.id),
        summary: Number((await pool.query("SELECT count(*) AS n FROM record_versions WHERE interview_id=$1 AND kind IN ('SUMMARY','PRODUCTION_PLAN')", [w.id])).rows[0].n),
        result: Number((await pool.query("SELECT count(*) AS n FROM record_versions WHERE interview_id=$1 AND kind='RESULT'", [w.id])).rows[0].n),
        audioPending: Number((await pool.query('SELECT count(*) AS n FROM audio_segments WHERE interview_id=$1 AND file_deleted_at IS NULL', [w.id])).rows[0].n),
        attFile: await exists(w.attPath), audioFile: w.audioFile ? await exists(path.join(dir, 'audio', w.audioFile)) : null,
        video: w.videoName ? await exists(path.join(dir, 'videos', w.videoName)) : null,
      };
    }
    it('즉시 삭제: 항목·첨부·요약·음성·첨부 파일이 서버에서 사라지고 완성 영상(파일+결과 메타)은 남는다', async () => {
      const w = await world();
      expect(await trace(w)).toMatchObject({ items: 2, atts: 1, summary: 1, result: 1, attFile: true, audioFile: true, video: true });
      const r = await svc.purgeNow(w.owner, w.id, at(T0, DAY));
      expect(r.already).toBe(false);
      expect(await trace(w)).toEqual({ items: 0, atts: 0, summary: 0, result: 1, audioPending: 0, attFile: false, audioFile: false, video: true });
      const iv = await row(w.id);
      expect(iv.server_purged_at).not.toBeNull();
      expect(iv.deleted_at).not.toBeNull();
      // 영구 삭제된 기록은 복구·조회·재기록 모두 불가, 휴지통에도 나오지 않는다
      await expect(store.restoreRecord(w.owner, w.id, at(T0, DAY))).rejects.toMatchObject({ code: 'RECORD_PURGED' });
      await expect(store.startInterview(w.owner, T0)).rejects.toMatchObject({ code: 'RECORD_PURGED' });
      expect(await store.loadById(w.owner, w.id, T0)).toBeNull();
      expect((await store.listTrash(w.owner, T0)).records).toEqual([]);
      expect((await svc.purgeNow(w.owner, w.id, at(T0, 2 * DAY))).already).toBe(true);
      expect(await svc.pendingFiles()).toEqual([]);
    });
    it('보존할 영상·백업 메타데이터가 없으면 기록 행도 지워 같은 날짜에 다시 기록할 수 있다', async () => {
      const w = await world({ video: false, audio: false });
      await svc.purgeNow(w.owner, w.id, T0);
      expect(await row(w.id)).toBeUndefined();
      const again = await store.startInterview(w.owner, T0);
      expect(again.interview.id).not.toBe(w.id);
    });
    it('30일 만료 삭제: 만료 직전에는 아무것도 지우지 않고 정확히 30일에 지운다', async () => {
      const w = await world();
      const del = at(T0, 3 * DAY);
      await store.trashRecord(w.owner, w.id, del);
      expect(await svc.sweepTrash(at(del, 30 * DAY - 1))).toEqual({ records: 0, parts: 0 });
      expect(await trace(w)).toMatchObject({ items: 2, atts: 1, attFile: true });
      await svc.drainFileQueue();
      expect(await exists(w.attPath)).toBe(true);
      expect(await svc.sweepTrash(at(del, 30 * DAY))).toEqual({ records: 1, parts: 0 });
      await svc.drainFileQueue();
      expect(await trace(w)).toMatchObject({ items: 0, atts: 0, summary: 0, result: 1, attFile: false, video: true });
      // 두 번째 훑기는 아무 일도 하지 않는다(멱등)
      expect(await svc.sweepTrash(at(del, 31 * DAY))).toEqual({ records: 0, parts: 0 });
    });
    it('일부 삭제 항목은 30일 뒤 지워지고 복구된 항목은 지워지지 않는다', async () => {
      const w = await world({ video: false, audio: false });
      const del = at(T0, DAY);
      await store.trashItem(w.owner, w.id, w.itemId, del);
      await store.trashAttachment(w.owner, w.id, w.att.id, del).catch(() => {}); // 항목과 함께 이미 삭제됨(중복)
      expect(await svc.sweepTrash(at(del, 30 * DAY - 1))).toEqual({ records: 0, parts: 0 });
      expect((await svc.sweepTrash(at(del, 30 * DAY))).parts).toBe(1);
      await svc.drainFileQueue();
      expect(await count('conversation_items', w.id)).toBe(1);
      expect(await count('attachment_refs', w.id)).toBe(0);
      expect(await exists(w.attPath)).toBe(false);
    });
    it('파일 삭제 실패는 부분 실패로 남고(행 유지) 다음 훑기에서 이어서 지운다', async () => {
      const w = await world({ video: false });
      await svc.purgeNow(w.owner, w.id, T0);
      // 큐에 불안전한 키를 직접 넣어 실패를 재현하고, 정상 키는 영향받지 않는지 본다
      await pool.query("INSERT INTO purge_file_queue (kind, storage_key, queued_at) VALUES ('ATTACHMENT','../escape',$1)", [T0]);
      const res = await svc.drainFileQueue();
      expect(res.failed).toBe(1);
      expect(await svc.pendingFiles()).toEqual([{ kind: 'ATTACHMENT', storageKey: '../escape', attempts: 1, lastError: 'UNSAFE_KEY' }]);
      await pool.query("DELETE FROM purge_file_queue WHERE storage_key='../escape'");
    });
  });

  // ---------------------------------------------------------------- AC-4
  describe('AC-4 공유 첨부 삭제가 다른 기록의 첨부를 잃지 않는다', () => {
    it('같은 파일을 두 기록이 참조할 때 한쪽 영구 삭제는 파일을 지우지 않고, 마지막 참조가 사라질 때만 지운다', async () => {
      const shared = Buffer.from('shared-attachment-content');
      const a = await world({ attBytes: shared, video: false, audio: false });
      const b = await world({ attBytes: shared, video: false, audio: false });
      expect(a.att.storageKey).toBe(b.att.storageKey);
      await svc.purgeNow(a.owner, a.id, T0);
      expect(await exists(a.attPath)).toBe(true);
      expect(await count('attachment_refs', b.id)).toBe(1);
      const snap = (await store.loadById(b.owner, b.id, T0))!;
      expect(snap.attachments).toHaveLength(1);
      expect(await readFile(a.attPath)).toEqual(shared); // 내용도 그대로
      await svc.purgeNow(b.owner, b.id, T0);
      expect(await exists(a.attPath)).toBe(false);
    });
    it('다른 기록이 휴지통에 있어도(복구 가능) 그 기록의 참조 때문에 파일을 유지한다', async () => {
      const shared = Buffer.from('shared-with-trash');
      const a = await world({ attBytes: shared, video: false, audio: false });
      const b = await world({ attBytes: shared, video: false, audio: false });
      await store.trashRecord(b.owner, b.id, T0);
      await svc.purgeNow(a.owner, a.id, T0);
      expect(await exists(a.attPath)).toBe(true);
      await store.restoreRecord(b.owner, b.id, at(T0, DAY));
      expect((await store.loadById(b.owner, b.id, T0))!.attachments).toHaveLength(1);
      expect((await readFile(b.attPath)).equals(shared)).toBe(true);
    });
    it('한 기록 안의 첨부 한 건 삭제 만료도 다른 기록이 쓰는 파일을 지우지 않는다', async () => {
      const shared = Buffer.from('shared-partial');
      const a = await world({ attBytes: shared, video: false, audio: false });
      const b = await world({ attBytes: shared, video: false, audio: false });
      await store.trashAttachment(a.owner, a.id, a.att.id, T0);
      await svc.sweepTrash(at(T0, 30 * DAY));
      await svc.drainFileQueue();
      expect(await count('attachment_refs', a.id)).toBe(0);
      expect(await exists(a.attPath)).toBe(true);
      expect((await store.loadById(b.owner, b.id, T0))!.attachments).toHaveLength(1);
    });
    it('정리 직후 같은 파일을 새로 올려도(업로드 중 경합) 파일이 복원되어 참조가 끊기지 않는다', async () => {
      const bytes = Buffer.from('race-attachment');
      const a = await world({ attBytes: bytes, video: false, audio: false });
      await svc.purgeNow(a.owner, a.id, T0);
      expect(await exists(a.attPath)).toBe(false);
      const c = await world({ attBytes: bytes, video: false, audio: false });
      expect(await exists(c.attPath)).toBe(true);
    });
  });

  // ---------------------------------------------------------------- AC-6 / AC-1(음성)
  describe('AC-6 음성 수명(Asia/Seoul 달력 한 달)과 AC-1 조기 삭제', () => {
    const audioExists = (w: W) => exists(path.join(dir, 'audio', w.audioFile!));
    const audioRow = async (w: W) => (await pool.query('SELECT * FROM audio_segments WHERE id=$1', [w.audioId])).rows[0];

    it.each([
      ['말일 1/31 → 2/28', '2025-01-31T01:00:00Z', '2025-02-28T01:00:00Z'],
      ['윤년 1/31 → 2/29', '2024-01-31T01:00:00Z', '2024-02-29T01:00:00Z'],
      ['연말 12/31 → 1/31', '2024-12-31T01:00:00Z', '2025-01-31T01:00:00Z'],
    ])('%s: 만료 1ms 전에는 남고 만료 시각에 삭제된다', async (_name, saved, due) => {
      const w = await world({ now: new Date(saved), video: false });
      const dueAt = new Date(due);
      expect((await audioRow(w)).expires_at.toISOString()).toBe(dueAt.toISOString());
      expect(await svc.sweepAudio(at(dueAt, -1))).toEqual({ expired: 0, processed: 0, deferred: 0 });
      expect(await audioExists(w)).toBe(true);
      expect(await svc.sweepAudio(dueAt)).toEqual({ expired: 1, processed: 0, deferred: 0 });
      await svc.drainFileQueue();
      expect(await audioExists(w)).toBe(false);
      expect(await audioRow(w)).toMatchObject({ status: 'EXPIRED', deleted_reason: 'EXPIRED', file_key: null });
    });
    it('재접속(이어하기)·재저장은 만료 시각을 연장하지 않는다', async () => {
      const w = await world({ video: false });
      const before = (await audioRow(w)).expires_at as Date;
      const later = at(T0, 20 * DAY);
      await store.resumeInterview(w.owner, (await store.loadById(w.owner, w.id, later))!.interview.lifeDate, later);
      await store.saveAudioSegment(w.owner, w.id, 'audio1', later);
      expect(((await audioRow(w)).expires_at as Date).getTime()).toBe(before.getTime());
      await svc.sweepAudio(before);
      await svc.drainFileQueue();
      expect(await audioExists(w)).toBe(false);
    });
    it('Drive 미연결·백업 확인과 무관하게 지운다(백업 확인 함수를 호출하지 않는다)', async () => {
      const w = await world({ video: false });
      readinessImpl = async () => { throw new Error('DRIVE_NOT_CONNECTED'); };
      await svc.sweepAudio(at(T0, 40 * DAY));
      await svc.drainFileQueue();
      expect(readinessCalls).toEqual([]);
      expect(await audioExists(w)).toBe(false);
    });
    it('처리 중 참조가 있으면 만료되어도 종료 확인 전까지 두고, 종료 후 다음 훑기에서 지운다', async () => {
      const w = await world({ video: false });
      await store.setAudioProcessing(w.owner, w.id, w.audioId!, true);
      const due = new Date((await audioRow(w)).expires_at);
      expect(await svc.sweepAudio(at(due, DAY))).toEqual({ expired: 0, processed: 0, deferred: 1 });
      await svc.drainFileQueue();
      expect(await audioExists(w)).toBe(true);
      await store.setAudioProcessing(w.owner, w.id, w.audioId!, false);
      expect(await svc.sweepAudio(at(due, 2 * DAY))).toMatchObject({ expired: 1, deferred: 0 });
      await svc.drainFileQueue();
      expect(await audioExists(w)).toBe(false);
    });
    it('AC-1 전사·요약이 저장된 정상 처리(PROCESSED) 음성은 만료 전에도 즉시 삭제하고, 미변환·중단 음성은 그대로 둔다', async () => {
      const done = await world({ video: false });
      await store.setAudioStatus(done.owner, done.id, done.audioId!, 'PROCESSED', at(T0, 1000));
      const unprocessed = await world({ video: false });
      const interrupted = await world({ video: false });
      await store.setAudioStatus(interrupted.owner, interrupted.id, interrupted.audioId!, 'INTERRUPTED', at(T0, 1000));
      const res = await svc.sweepAudio(at(T0, DAY));
      expect(res.processed).toBe(1);
      await svc.drainFileQueue();
      expect(await audioExists(done)).toBe(false);
      expect(await audioRow(done)).toMatchObject({ status: 'PROCESSED', deleted_reason: 'PROCESSED' });
      expect(await audioExists(unprocessed)).toBe(true);
      expect(await audioExists(interrupted)).toBe(true);
    });
    it('AC-1 요약(정정 저장 포함)이 없으면 PROCESSED 라도 조기 삭제하지 않는다', async () => {
      const w = await world({ video: false });
      await pool.query("DELETE FROM record_versions WHERE interview_id=$1 AND kind='SUMMARY'", [w.id]);
      await store.setAudioStatus(w.owner, w.id, w.audioId!, 'PROCESSED', T0);
      expect((await svc.sweepAudio(at(T0, DAY))).processed).toBe(0);
      expect(await audioExists(w)).toBe(true);
    });
    it('AC-1 음성은 백업 대상 목록·스냅샷에 어떤 상태에서도 나타나지 않는다', async () => {
      const statuses: ('UNPROCESSED' | 'INTERRUPTED' | 'PROCESSED')[] = ['UNPROCESSED', 'INTERRUPTED', 'PROCESSED'];
      for (const st of statuses) {
        const w = await world({ video: true });
        await store.setAudioStatus(w.owner, w.id, w.audioId!, st, T0);
        const plan = (await buildBackupPlan(pool, dir, w.id))!;
        const text = JSON.stringify(plan.items.map((i) => [i.kind, i.key, i.driveName, 'file' in i.source ? i.source.file : '', 'bytes' in i.source ? i.source.bytes.toString() : '']));
        expect(plan.items.map((i) => i.kind).sort()).toEqual(['ATTACHMENT', 'RECORD', 'VIDEO']);
        expect(text).not.toContain(w.audioFile!);
        expect(text).not.toMatch(/audio|raw-audio|\.webm/i);
      }
    });
  });

  // ---------------------------------------------------------------- AC-5
  describe('AC-5 한 달 자동 정리는 최신 백업 검증 때만, 영상·백업은 유지', () => {
    const due = (w: { now?: Date }) => addCalendarMonthSeoul(w.now ?? T0);

    it('한 달 전에는 백업 확인조차 하지 않고 아무것도 지우지 않는다', async () => {
      const w = await world();
      readinessImpl = async () => ({ found: true, ready: true, reason: null });
      expect(await svc.sweepMonthly(at(due({}), -1))).toEqual({ cleaned: 0, blocked: 0, skipped: 0 });
      expect(readinessCalls).not.toContain(w.id);
      expect(await row(w.id)).toMatchObject({ server_cleaned_at: null });
    });
    it('백업이 확인되면 서버의 텍스트·첨부만 정리하고 영상 파일·결과 메타·음성 규칙은 그대로다', async () => {
      const w = await world();
      readinessImpl = async () => ({ found: true, ready: true, reason: null });
      const res = await svc.sweepMonthly(due({}));
      expect(res.cleaned).toBeGreaterThanOrEqual(1);
      await svc.drainFileQueue();
      expect(readinessCalls).toContain(w.id);
      expect(await count('conversation_items', w.id)).toBe(0);
      expect(await count('attachment_refs', w.id)).toBe(0);
      expect(await exists(w.attPath)).toBe(false);
      expect(await exists(path.join(dir, 'videos', w.videoName!))).toBe(true);
      expect(Number((await pool.query("SELECT count(*) AS n FROM record_versions WHERE interview_id=$1 AND kind='RESULT'", [w.id])).rows[0].n)).toBe(1);
      expect(await row(w.id)).toMatchObject({ cleanup_blocked_reason: null });
      expect((await store.retentionOf(w.owner, w.id, due({})))?.serverCopy).toBe('CLEANED');
      // 정리된 기록은 목록·상세에 남아 있고(영상 연결 유지) 더는 쓸 수 없다
      expect((await store.listRecords(w.owner, { limit: 5 })).rows.map((r) => r.id)).toContain(w.id);
      await expect(store.saveItem(w.owner, w.id, 'later', 'ANSWER', 'x', due({}))).rejects.toMatchObject({ code: 'SERVER_CLEANED' });
      // 백업 대상에서도 빠져(빈 스냅샷을 새 버전으로 올리지 않음) 두 번 정리하지 않는다
      expect(await buildBackupPlan(pool, dir, w.id)).toBeNull();
      const second = await svc.sweepMonthly(at(due({}), DAY));
      expect(readinessCalls.filter((x) => x === w.id)).toHaveLength(1);
      expect(second.cleaned).toBe(0);
    });
    it.each([
      ['최신 백업 미완료', async () => ({ found: true, ready: false, reason: 'BACKUP_NOT_CURRENT' }), 'BACKUP_NOT_CURRENT'],
      ['Drive 접근 불가', async () => ({ found: true, ready: false, reason: 'DRIVE_UNREACHABLE' }), 'DRIVE_UNREACHABLE'],
      ['MD5 불일치', async () => ({ found: true, ready: false, reason: 'VERIFY_MISMATCH' }), 'VERIFY_MISMATCH'],
      ['실시간 확인 대기(null)', async () => ({ found: true, ready: null, reason: 'LIVE_CHECK_REQUIRED' }), 'LIVE_CHECK_REQUIRED'],
      ['확인 중 예외(미연결·장애)', async () => { throw new Error('boom'); }, 'DRIVE_UNREACHABLE'],
    ] as [string, () => Promise<Readiness>, string][])('%s: 원본을 모두 보존하고 정리 대기 사유를 남긴다', async (_n, impl, reason) => {
      const w = await world();
      readinessImpl = impl;
      const res = await svc.sweepMonthly(due({}));
      expect(res.blocked).toBeGreaterThanOrEqual(1);
      expect(await count('conversation_items', w.id)).toBe(2);
      expect(await count('attachment_refs', w.id)).toBe(1);
      expect(await exists(w.attPath)).toBe(true);
      expect(await row(w.id)).toMatchObject({ server_cleaned_at: null, cleanup_blocked_reason: reason });
      const notice = retentionNotice((await store.retentionOf(w.owner, w.id, due({})))!, due({}));
      expect(notice.cleanupPending).toBeTruthy();
    });
    it('백업 확인 뒤 지우기 전에 기록이 바뀌면 지우지 않는다', async () => {
      const w = await world({ video: false, audio: false });
      readinessImpl = async (owner, id) => {
        await pool.query("UPDATE interviews SET updated_at = updated_at + interval '1 second' WHERE id=$1", [id]);
        void owner;
        return { found: true, ready: true, reason: null };
      };
      const res = await svc.sweepMonthly(due({}));
      expect(res.skipped).toBeGreaterThanOrEqual(1);
      expect(await count('conversation_items', w.id)).toBe(2);
      expect(await row(w.id)).toMatchObject({ server_cleaned_at: null, cleanup_blocked_reason: 'CHANGED_DURING_CHECK' });
    });
    it('진행 중인 작업(제작·백업)이 있으면 확인도 하지 않고 기다린다', async () => {
      const w = await world({ video: false, audio: false });
      await pool.query("INSERT INTO jobs (kind, subject_id, stages, idempotency_key, state) VALUES ('video', $1, ARRAY['render'], $2, 'RUNNING')", [w.id, `k-${randomUUID()}`]);
      readinessImpl = async () => ({ found: true, ready: true, reason: null });
      await svc.sweepMonthly(due({}));
      expect(readinessCalls).not.toContain(w.id);
      expect(await row(w.id)).toMatchObject({ server_cleaned_at: null, cleanup_blocked_reason: 'JOB_IN_PROGRESS' });
      expect(await count('conversation_items', w.id)).toBe(2);
    });
    it('휴지통의 기록은 한 달 정리 대상이 아니다(휴지통 30일 규칙이 따로 적용)', async () => {
      const w = await world({ video: false, audio: false });
      await store.trashRecord(w.owner, w.id, at(T0, 5 * DAY));
      readinessImpl = async () => ({ found: true, ready: true, reason: null });
      await svc.sweepMonthly(at(due({}), DAY));
      expect(readinessCalls).not.toContain(w.id);
      expect(await count('conversation_items', w.id)).toBe(2);
    });
  });
});

// ---------------------------------------------------------------- AC-1/AC-5 실제 BackupService + 가짜 Drive
describe.skipIf(!url)('서버 정리 후 Drive 백업 유지·해시 검증 (실제 BackupService + 가짜 Drive)', () => {
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
    issuer = await startMockIssuer({ clientId: 'cid', clientSecret: 'csecret-value-1234' });
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-retention-bk-'));
    cfg = loadAuthConfig({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret-value-1234', GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
  });
  afterAll(async () => {
    await pool.end();
    await t.drop();
    await drive.close();
    await issuer.close();
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => { Object.assign(drive.state, { failUploads: 0, unauthorized: false }); });

  async function world() {
    const n = ++seq;
    const owner = `bk-owner-${n}`;
    const store = new RecordStore(pool);
    const connections = new PgDriveConnections(pool, new TokenVault(SECRET));
    const refresh = `mock-refresh-${randomUUID()}`;
    issuer.state.refreshTokens.add(refresh);
    await connections.save(owner, 'owner@example.test', refresh, 'https://www.googleapis.com/auth/drive.file');
    const handlers: ConstructorParameters<typeof JobQueue>[0]['handlers'] = {};
    const queue: JobQueue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers, leaseMs: 60000, permissionRestored: (j) => backup.permissionRestored(j) });
    const backup: BackupService = new BackupService({ pool, queue, fileStorageDir: dir, connections, drive: createDriveFactory({ connections, oidc: new OidcClient(cfg), apiBase: drive.apiBase, uploadBase: drive.uploadBase }) });
    handlers[BACKUP_KIND] = backup.handlers();
    const svc = new RetentionService({ pool, fileStorageDir: dir, readiness: (o, i) => backup.cleanupReadiness(o, i, { live: true }) });
    const { interview } = await store.startInterview(owner, T0);
    await store.saveItem(owner, interview.id, 'a1', 'ANSWER', `백업 답변 ${n}`, T0);
    const attBytes = Buffer.from(`# 백업 메모 ${n}`);
    const att = await new AttachmentService(store, dir).upload({ ownerId: owner, interviewId: interview.id, key: 'att1', kind: 'MARKDOWN', name: 'note.md', bytes: attBytes, now: T0 });
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: `요약 ${n}`, learning: [] }, T0);
    const videoBytes = Buffer.from(`fake-mp4-${n}-`.repeat(40));
    const videoName = `bk-${n}.mp4`;
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    await writeFile(path.join(dir, 'videos', videoName), videoBytes);
    await store.appendVersion(owner, interview.id, 'RESULT', { file: videoName }, T0);
    const a = await store.saveAudioSegment(owner, interview.id, 'audio1', T0);
    await mkdir(path.join(dir, 'audio'), { recursive: true });
    await writeFile(path.join(dir, 'audio', `bk-${n}.webm`), Buffer.from('raw'));
    await store.attachAudioFile(owner, interview.id, a.id, `bk-${n}.webm`);
    await store.confirm(owner, interview.id, T0);
    const drain = async () => { for (let i = 0; i < 10 && (await queue.tick()); i++); };
    const runBackup = async () => { await backup.enqueueInterview(interview.id); await drain(); };
    return { n, owner, store, backup, svc, id: interview.id, att, attBytes, videoBytes, videoName, runBackup };
  }
  type BW = Awaited<ReturnType<typeof world>>;
  const driveOf = (w: BW) => drive.uploaded().filter((f) => f.appProperties.dlInterview === w.id);
  const dueOf = addCalendarMonthSeoul(T0);

  it('AC-1/AC-5 백업 완료 후 한 달 정리: 서버 텍스트·첨부는 사라지고 Drive 파일(영상 포함)은 같은 해시로 남으며 음성은 업로드되지 않았다', async () => {
    const w = await world();
    await w.runBackup();
    const before = driveOf(w).map((f) => ({ id: f.id, name: f.name, sha: sha(f.bytes) }));
    expect(before.length).toBe(3); // 기록 스냅샷 + 첨부 + 영상
    expect(driveOf(w).some((f) => /audio|webm|raw/i.test(f.name) || f.bytes.toString().includes('raw'))).toBe(false);
    expect(driveOf(w).find((f) => f.name.includes('video'))!.bytes.equals(w.videoBytes)).toBe(true);
    const deletesBefore = drive.log.filter((l) => l.method === 'DELETE' || l.method === 'PATCH').length;

    const res = await w.svc.sweepMonthly(dueOf);
    expect(res.cleaned).toBeGreaterThanOrEqual(1);
    await w.svc.drainFileQueue();
    expect((await pool.query('SELECT count(*)::int AS n FROM conversation_items WHERE interview_id=$1', [w.id])).rows[0].n).toBe(0);
    expect(await exists(path.join(dir, 'attachments', w.att.storageKey))).toBe(false);
    expect(await exists(path.join(dir, 'videos', w.videoName))).toBe(true);
    // Drive: 같은 파일 id·이름·내용 해시, 삭제·수정 호출 없음
    expect(driveOf(w).map((f) => ({ id: f.id, name: f.name, sha: sha(f.bytes) }))).toEqual(before);
    expect(driveOf(w).every((f) => !f.trashed)).toBe(true);
    expect(drive.log.filter((l) => l.method === 'DELETE' || l.method === 'PATCH').length).toBe(deletesBefore);
    const bi = (await pool.query("SELECT status, count(*)::int AS n FROM backup_items WHERE interview_id=$1 GROUP BY status", [w.id])).rows;
    expect(bi).toEqual([{ status: 'VERIFIED', n: 3 }]);
    // 백업 재실행도 빈 스냅샷을 올리지 않는다
    await w.backup.sweep();
    await w.runBackup();
    expect(driveOf(w)).toHaveLength(3);
  });

  it('AC-5 Drive 파일이 변조(내용 해시 불일치)되면 서버 원본을 정리하지 않는다', async () => {
    const w = await world();
    await w.runBackup();
    const attFile = driveOf(w).find((f) => f.name.includes('attachment'))!;
    attFile.md5Override = 'f'.repeat(32);
    const res = await w.svc.sweepMonthly(dueOf);
    expect(res.cleaned).toBe(0);
    expect(res.blocked).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM conversation_items WHERE interview_id=$1', [w.id])).rows[0].n).toBe(1);
    expect(await exists(path.join(dir, 'attachments', w.att.storageKey))).toBe(true);
    expect((await pool.query('SELECT cleanup_blocked_reason AS r FROM interviews WHERE id=$1', [w.id])).rows[0].r).toBe('VERIFY_MISMATCH');
  });

  it('AC-5 백업 이후 새 revision 이 생기면(최신 checksum 미백업) 정리하지 않는다', async () => {
    const w = await world();
    await w.runBackup();
    await pool.query("UPDATE interviews SET status='IN_PROGRESS' WHERE id=$1", [w.id]); // 확정 해제(시험용) 후 새 항목 저장
    await w.store.saveItem(w.owner, w.id, 'a2', 'ANSWER', '백업 이후 새 답변', dueOf);
    const res = await w.svc.sweepMonthly(dueOf);
    expect(res.cleaned).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM conversation_items WHERE interview_id=$1', [w.id])).rows[0].n).toBe(2);
    expect((await pool.query('SELECT cleanup_blocked_reason AS r FROM interviews WHERE id=$1', [w.id])).rows[0].r).toBe('BACKUP_NOT_CURRENT');
  });

  it('AC-5 Drive 인증 만료·장애 중에도 원본을 보존한다', async () => {
    const w = await world();
    await w.runBackup();
    drive.state.unauthorized = true;
    const res = await w.svc.sweepMonthly(dueOf);
    expect(res.cleaned).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM conversation_items WHERE interview_id=$1', [w.id])).rows[0].n).toBe(1);
    expect(await exists(path.join(dir, 'attachments', w.att.storageKey))).toBe(true);
  });

  it('AC-3/AC-5 사용자 즉시 삭제·휴지통 만료 뒤에도 Drive 백업 파일은 그대로이고 삭제 요청이 가지 않는다', async () => {
    const w = await world();
    await w.runBackup();
    const before = driveOf(w).map((f) => ({ id: f.id, sha: sha(f.bytes), trashed: f.trashed }));
    const callsBefore = drive.log.length;
    await w.store.trashRecord(w.owner, w.id, dueOf);
    await w.svc.sweepTrash(at(dueOf, 30 * DAY));
    await w.svc.drainFileQueue();
    expect((await pool.query('SELECT server_purged_at FROM interviews WHERE id=$1', [w.id])).rows[0].server_purged_at).not.toBeNull();
    expect(await exists(path.join(dir, 'videos', w.videoName))).toBe(true);
    expect(driveOf(w).map((f) => ({ id: f.id, sha: sha(f.bytes), trashed: f.trashed }))).toEqual(before);
    expect(drive.log.slice(callsBefore).filter((l) => l.method !== 'GET')).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM backup_items WHERE interview_id=$1 AND status='VERIFIED'", [w.id])).rows[0].n).toBe(3);
    // 백업 대상 목록에서도 빠져 서버 정리 후 빈 내용이 새 버전으로 올라가지 않는다
    await w.backup.sweep();
    expect(driveOf(w)).toHaveLength(3);
  });
});

describe.skipIf(!url)('HTTP 라우트: 휴지통·복구·즉시 삭제', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let app: ReturnType<typeof buildApp>;
  let dir: string;
  let clock = T0;
  const cookie = (sub: string, email: string) => { const iat = Math.floor(Date.now() / 1000); return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 }, SECRET, 'session')}`; };
  const A = cookie('http-a', 'a@example.test');
  const B = cookie('http-b', 'b@example.test');
  const call = (method: 'GET' | 'POST', u: string, c = A, payload?: object) => app.inject({ method, url: u, headers: { cookie: c }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-retention-http-'));
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test,b@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    app = buildApp({
      auth, sessionSecret: SECRET, fileStorageDir: dir, records: store, now: () => clock,
      retention: new RetentionService({ pool, fileStorageDir: dir, readiness: async () => ({ found: true, ready: false, reason: 'BACKUP_NOT_CURRENT' }), now: () => clock }),
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await pool.end(); await t.drop(); await rm(dir, { recursive: true, force: true }); });

  it('삭제 → 휴지통 목록 → 복구, 즉시 삭제는 확인 없이는 지우지 않으며 응답이 Drive 백업 보존을 알린다', async () => {
    clock = T0;
    const { interview } = await store.startInterview('http-a', T0);
    await store.saveItem('http-a', interview.id, 'k1', 'ANSWER', '오늘 기록', T0);
    const id = interview.id;
    expect((await call('POST', `/api/records/${id}/trash`, B)).statusCode).toBe(404); // 타 소유자
    const del = await call('POST', `/api/records/${id}/trash`);
    expect(del.statusCode).toBe(200);
    expect(del.json().message).toMatch(/Drive 백업과 완성 영상은 .*유지/);
    expect((await call('GET', `/api/records/${id}`)).statusCode).toBe(404);
    const trash = (await call('GET', '/api/trash')).json();
    expect(trash.records).toHaveLength(1);
    expect(trash.backupNote).toMatch(/Drive/);
    expect((await call('GET', '/api/trash', B)).json().records).toEqual([]);
    clock = at(T0, 31 * DAY);
    expect((await call('POST', `/api/records/${id}/restore`)).statusCode).toBe(410); // 만료
    clock = at(T0, 10 * DAY);
    expect((await call('POST', `/api/records/${id}/restore`)).statusCode).toBe(200);
    const detail = await call('GET', `/api/records/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().retention).toMatchObject({ serverCopy: 'PRESENT', backupKept: true });
    // 즉시 삭제: 확인 필수
    const noConfirm = await call('POST', `/api/records/${id}/purge`, A, {});
    expect(noConfirm.statusCode).toBe(422);
    expect(await store.loadById('http-a', id, clock)).not.toBeNull();
    const purge = await call('POST', `/api/records/${id}/purge`, A, { confirm: true });
    expect(purge.statusCode).toBe(200);
    expect(purge.json()).toMatchObject({ serverCopy: 'PURGED' });
    expect(purge.json().message).toMatch(/Drive 백업과 완성 영상은 .*유지/);
    // 영상·백업 메타가 없는 기록은 행째 지워져 더는 존재하지 않는다(보존 대상이 있으면 RECORD_PURGED 410 — 저장소 시험 참고).
    expect((await call('POST', `/api/records/${id}/restore`)).statusCode).toBe(404);
    expect((await call('POST', '/api/records/not-a-uuid/trash')).statusCode).toBe(404);
  });
});
