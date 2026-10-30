import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue } from '../jobs/queue.js';
import { RecordStore } from '../records/store.js';
import { createTempSchema } from '../records/db.testutil.js';
import { PgDriveConnections } from './connections.js';
import { createDriveFactory, GoogleDriveClient } from './drive.js';
import { startFakeDrive } from './fakeDrive.testutil.js';
import { buildBackupPlan } from './plan.js';
import { BACKUP_KIND, BackupService } from './service.js';
import { TokenVault } from './vault.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret-value';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const md5 = (b: Buffer | string) => createHash('md5').update(b).digest('hex');

describe('TokenVault', () => {
  it('갱신 토큰은 암호화되고 다른 키·다른 소유자 문맥·변조로는 복호화되지 않는다', () => {
    const v = new TokenVault(SECRET);
    const blob = v.encrypt('1//refresh-secret', 'drive:u1');
    expect(blob).not.toContain('refresh-secret');
    expect(v.decrypt(blob, 'drive:u1')).toBe('1//refresh-secret');
    expect(v.decrypt(blob, 'drive:u2')).toBeNull();
    expect(new TokenVault('another-secret-0123456789').decrypt(blob, 'drive:u1')).toBeNull();
    expect(v.decrypt(blob.slice(0, -2) + 'AA', 'drive:u1')).toBeNull();
    expect(v.decrypt('garbage', 'drive:u1')).toBeNull();
  });
});

describe.skipIf(!url)('Google Drive 일일 백업 (실제 PostgreSQL 임시 스키마 + 가짜 Drive/발급자)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let drive: Awaited<ReturnType<typeof startFakeDrive>>;
  let issuer: Awaited<ReturnType<typeof startMockIssuer>>;
  let dir: string;
  let cfg: AuthConfig;
  let seq = 0;
  const NOW = new Date();

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    drive = await startFakeDrive();
    issuer = await startMockIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-backup-'));
    cfg = loadAuthConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
  });
  afterAll(async () => {
    await pool.end();
    await t.drop();
    await drive.close();
    await issuer.close();
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    Object.assign(drive.state, { limit: null, usage: 0, failUploads: 0, loseUploadResponse: false, corruptNextUpload: false, unauthorized: false, rejectQuota: false });
    issuer.state.refreshServerError = false;
  });

  const vault = () => new TokenVault(SECRET);

  /** 소유자 한 명 분량의 기록(대화·요약·첨부·영상·음성)과 백업 서비스를 만든다. */
  async function world(opts: { connect?: boolean } = {}) {
    const n = ++seq;
    const owner = `owner-${n}`;
    const store = new RecordStore(pool);
    const connections = new PgDriveConnections(pool, vault());
    const refresh = `mock-refresh-${randomUUID()}`;
    if (opts.connect !== false) {
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
    const { interview } = await store.startInterview(owner, NOW);
    await store.saveItem(owner, interview.id, 'q1', 'QUESTION', `오늘 무슨 일이 있었나요? #${n}`, NOW);
    await store.saveItem(owner, interview.id, 'a1', 'ANSWER', `테스트 답변 ${n}`, NOW);
    const att = await new AttachmentService(store, dir).upload({ ownerId: owner, interviewId: interview.id, key: 'att1', kind: 'MARKDOWN', name: 'note.md', bytes: Buffer.from(`# 메모 ${n}\n내용`), now: NOW });
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: `요약 ${n}`, learning: [] }, NOW);
    const videoBytes = Buffer.from(`fake-mp4-bytes-${n}-`.repeat(50));
    const videoName = `day-${n}.mp4`;
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    await writeFile(path.join(dir, 'videos', videoName), videoBytes);
    await store.appendVersion(owner, interview.id, 'RESULT', { file: videoName }, NOW);
    await store.saveAudioSegment(owner, interview.id, 'audio1', NOW);
    await store.confirm(owner, interview.id, NOW);
    const drain = async () => { for (let i = 0; i < 10 && (await queue.tick()); i++); };
    const run = async () => {
      const r = (await backup.enqueueInterview(interview.id))!;
      await drain();
      return { ...r, now: r.job ? (await queue.get(r.job.id))! : null };
    };
    return { n, owner, store, connections, queue, backup, interview, att, videoBytes, videoName, refresh, drain, run };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const stateOf = async (w: World) => (await pool.query('SELECT state, reason FROM backup_states WHERE interview_id=$1', [w.interview.id])).rows[0] as { state: string; reason: string | null };
  const pipelineBackup = async (w: World) => (await pool.query('SELECT backup FROM pipeline_states WHERE interview_id=$1', [w.interview.id])).rows[0].backup as string;
  const driveFilesOf = (w: World) => drive.uploaded().filter((f) => f.appProperties.dlInterview === w.interview.id);
  /** 이 세계의 기록·첨부·영상 원본 상태(삭제·변경 여부 비교용). */
  const serverSnapshot = async (w: World) => ({
    items: (await pool.query('SELECT seq, body FROM conversation_items WHERE interview_id=$1 ORDER BY seq', [w.interview.id])).rows,
    atts: (await pool.query('SELECT storage_key, checksum FROM attachment_refs WHERE interview_id=$1', [w.interview.id])).rows,
    attFile: await readFile(path.join(dir, 'attachments', w.att.storageKey)),
    video: await readFile(path.join(dir, 'videos', w.videoName)),
    status: (await pool.query('SELECT production, review FROM pipeline_states WHERE interview_id=$1', [w.interview.id])).rows[0],
  });

  it('AC-1 기록·첨부·완성 영상이 대응 버전 정보와 함께 Drive 에 올라가고 크기·MD5 가 일치한다', async () => {
    const w = await world();
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0 });
    const files = driveFilesOf(w).filter((f) => f.appProperties.dlKind);
    expect(files.map((f) => f.appProperties.dlKind).sort()).toEqual(['ATTACHMENT', 'RECORD', 'VIDEO']);
    const byKind = Object.fromEntries(files.map((f) => [f.appProperties.dlKind, f]));
    // 내용 대조
    expect(byKind.VIDEO!.bytes.equals(w.videoBytes)).toBe(true);
    expect(byKind.ATTACHMENT!.bytes.equals(await readFile(path.join(dir, 'attachments', w.att.storageKey)))).toBe(true);
    const snap = JSON.parse(byKind.RECORD!.bytes.toString('utf8'));
    expect(snap).toMatchObject({ interviewId: w.interview.id, lifeDate: w.interview.lifeDate, status: 'CONFIRMED' });
    expect(snap.items.map((i: { body: string }) => i.body)).toEqual([`오늘 무슨 일이 있었나요? #${w.n}`, `테스트 답변 ${w.n}`]);
    expect(snap.versions.map((v: { kind: string; version: number }) => `${v.kind}:${v.version}`).sort()).toEqual(['RESULT:1', 'SUMMARY:1']);
    // 대응 버전 정보: 파일 속성과 DB 행
    expect(byKind.RECORD!.appProperties.dlVersion).toMatch(/^rev\d+\.s1\.p0\.r1$/);
    expect(byKind.VIDEO!.appProperties.dlVersion).toBe('result.v1');
    expect(byKind.ATTACHMENT!.appProperties.dlVersion).toMatch(/^sha[a-f0-9]{12}$/);
    const rows = (await pool.query(`SELECT item_kind, version_label, status, drive_md5, size_bytes, content_sha256 FROM backup_items WHERE interview_id=$1 ORDER BY item_kind`, [w.interview.id])).rows;
    expect(rows.map((x) => x.status)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED']);
    expect(rows.find((x) => x.item_kind === 'VIDEO')).toMatchObject({ drive_md5: md5(w.videoBytes), size_bytes: String(w.videoBytes.length), content_sha256: createHash('sha256').update(w.videoBytes).digest('hex') });
    // 날짜 폴더 구조
    const folders = [...drive.files.values()].filter((f) => f.mimeType.includes('folder'));
    expect(folders.some((f) => f.name === w.interview.lifeDate)).toBe(true);
    expect(await stateOf(w)).toEqual({ state: 'VERIFIED', reason: null });
    expect(await pipelineBackup(w)).toBe('VERIFIED');
  });

  it('AC-1 같은 내용은 다시 올리지 않고(중복 방지), 내용이 바뀌면 새 버전 파일을 추가하며 이전 버전은 유지한다', async () => {
    const w = await world();
    await w.run();
    const before = drive.state.uploads;
    const again = await w.backup.sweep();
    expect(again.enqueued).toBe(0);
    await w.drain();
    const second = await w.run(); // 같은 내용: 작업 없이 VERIFIED
    expect(second.job).toBeNull();
    expect(drive.state.uploads).toBe(before);
    // 기록 수정(확정 후에는 새 revision 만 가능하므로 요약 버전을 추가)
    await w.store.appendVersion(w.owner, w.interview.id, 'SUMMARY', { diary: '수정된 요약', learning: ['a'] }, NOW);
    const third = await w.run();
    expect(third.now).toMatchObject({ state: 'SUCCEEDED' });
    expect(drive.state.uploads).toBe(before + 1); // 기록 스냅샷만 새 버전. 첨부·영상은 그대로
    const records = driveFilesOf(w).filter((f) => f.appProperties.dlKind === 'RECORD');
    expect(records.map((f) => f.appProperties.dlVersion).sort()).toEqual([expect.stringMatching(/\.s1\./), expect.stringMatching(/\.s2\./)]);
    expect(records[0]!.id).not.toBe(records[1]!.id);
  });

  it('AC-2 음성은 대상 목록·스냅샷·Drive 파일·DB 어디에도 없다', async () => {
    const w = await world();
    expect((await pool.query('SELECT count(*)::int AS c FROM audio_segments WHERE interview_id=$1', [w.interview.id])).rows[0].c).toBe(1);
    const plan = (await buildBackupPlan(pool, dir, w.interview.id))!;
    expect(plan.items.map((i) => i.kind).sort()).toEqual(['ATTACHMENT', 'RECORD', 'VIDEO']);
    expect(plan.items.some((i) => /audio|voice|wav|mp3|m4a/i.test(i.key))).toBe(false);
    await w.run();
    for (const f of driveFilesOf(w)) expect(`${f.name} ${JSON.stringify(f.appProperties)}`).not.toMatch(/audio/i);
    const snap = driveFilesOf(w).find((f) => f.appProperties.dlKind === 'RECORD')!.bytes.toString('utf8');
    expect(snap).not.toMatch(/audio|segment|first_saved|expires/i);
    // 스키마 수준에서도 음성 종류는 거부된다.
    await expect(pool.query(`INSERT INTO backup_items (owner_id, interview_id, life_date, item_kind, item_key, version_label, content_sha256, size_bytes) VALUES ('o', $1, '2031-01-01', 'AUDIO', 'a', 'v', 'h', 1)`, [w.interview.id])).rejects.toThrow();
  });

  it('AC-3 Drive 가 계속 실패해도 서버 원본·기록 상태·영상 열람은 그대로다', async () => {
    const w = await world();
    const before = await serverSnapshot(w);
    drive.state.failUploads = 99;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1 });
    const after = await serverSnapshot(w);
    expect(after.items).toEqual(before.items);
    expect(after.atts).toEqual(before.atts);
    expect(after.attFile.equals(before.attFile)).toBe(true);
    expect(after.video.equals(before.video)).toBe(true);
    expect(after.status).toEqual(before.status);
    expect(await pipelineBackup(w)).toBe('FAILED');
    // 영상 열람(로그인한 소유자)은 막히지 않는다.
    const app = buildApp({ auth: cfg, sessionSecret: SECRET, fileStorageDir: dir, drive: w.connections, backup: w.backup, records: w.store });
    const iat = Math.floor(Date.now() / 1000);
    const cookie = `dl_session=${sign({ sub: w.owner, email: 'owner@example.test', iat, exp: iat + 600 }, SECRET, 'session')}`;
    const video = await app.inject({ url: `/api/videos/${w.videoName}`, headers: { cookie } });
    expect(video.statusCode).toBe(200);
    expect(video.rawPayload.equals(w.videoBytes)).toBe(true);
    await app.close();
  });

  it('AC-3 인증 만료·원본 파일 문제에서도 서버 쪽 파일은 지워지지 않고 Drive 쪽 삭제 요청도 없다', async () => {
    const w = await world();
    drive.state.unauthorized = true;
    await w.run();
    expect((await serverSnapshot(w)).video.equals(w.videoBytes)).toBe(true);
    expect(drive.log.some((l) => l.method === 'DELETE' || l.method === 'PATCH' || l.method === 'PUT' && !l.path.startsWith('/upload/session/'))).toBe(false);
  });

  it('AC-4 Drive 미연결은 권한 대기이며 완료로 표시되지 않고 아무것도 올리지 않는다. 연결하면 이어서 완료된다', async () => {
    const w = await world({ connect: false });
    const up = drive.state.uploads;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'WAITING', waitReason: 'PERMISSION', errorCode: 'DRIVE_NOT_CONNECTED', autoRetriesUsed: 0 });
    expect(await stateOf(w)).toEqual({ state: 'PENDING', reason: 'DRIVE_NOT_CONNECTED' });
    expect(await pipelineBackup(w)).toBe('PENDING');
    expect(drive.state.uploads).toBe(up);
    const st = await w.backup.status(w.owner);
    expect(st.drive).toBe('NOT_CONNECTED');
    expect(st.records.find((x) => x.id === w.interview.id)).toMatchObject({ backup: 'PENDING', reason: 'DRIVE_NOT_CONNECTED' });
    // 아직 연결 전이므로 이 작업은 깨우지 않는다.
    await w.queue.wakeWaiting();
    expect(await w.queue.get(r.job!.id)).toMatchObject({ state: 'WAITING' });
    // 연결 후에는 대기 작업이 이어져 완료(자동 재시도 횟수 소모 없음)
    issuer.state.refreshTokens.add(w.refresh);
    await w.connections.save(w.owner, 'owner@example.test', w.refresh, DRIVE_SCOPE);
    await w.queue.wakeWaiting();
    expect(await w.queue.get(r.job!.id)).toMatchObject({ state: 'QUEUED' });
    await w.drain();
    expect(await w.queue.get(r.job!.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 0 });
    expect(await pipelineBackup(w)).toBe('VERIFIED');
  });

  it('AC-4 인증 철회·만료(invalid_grant)는 연결을 AUTH_EXPIRED 로 바꾸고 완료로 표시하지 않는다', async () => {
    const w = await world();
    issuer.state.revoked.add(w.refresh);
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'WAITING', waitReason: 'PERMISSION', errorCode: 'DRIVE_AUTH_EXPIRED' });
    expect(await w.connections.state(w.owner)).toBe('AUTH_EXPIRED');
    expect(await stateOf(w)).toEqual({ state: 'FAILED', reason: 'DRIVE_AUTH_EXPIRED' });
    expect(await pipelineBackup(w)).toBe('FAILED');
    expect(driveFilesOf(w).length).toBe(0);
    // 토큰 갱신 서버 오류(일시)는 만료로 취급하지 않는다.
    const w2 = await world();
    issuer.state.refreshServerError = true;
    const r2 = await w2.run();
    expect(r2.now).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1, errorCode: 'TRANSIENT_ERROR' });
    expect(await w2.connections.state(w2.owner)).toBe('CONNECTED');
  });

  it('AC-4/AC-6 여유 용량이 부족하면 하나도 올리지 않고 실패로 남기며 기존 백업을 지우지 않는다', async () => {
    const first = await world();
    await first.run(); // 기존 백업이 있는 상태
    const existing = drive.uploaded().length;
    const w = await world();
    const used = (await (new GoogleDriveClient({ accessToken: async () => 'mock-access', apiBase: drive.apiBase, uploadBase: drive.uploadBase })).quota()).usage;
    drive.state.limit = used + 10; // 필요량보다 작은 여유
    const up = drive.state.uploads;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'FAILED', errorCode: 'DRIVE_QUOTA_INSUFFICIENT', autoRetriesUsed: 0 });
    expect(await stateOf(w)).toEqual({ state: 'FAILED', reason: 'DRIVE_QUOTA_INSUFFICIENT' });
    expect(await pipelineBackup(w)).toBe('FAILED');
    expect(drive.state.uploads).toBe(up);
    expect(drive.uploaded().length).toBe(existing);
    expect(drive.log.filter((l) => l.method === 'DELETE' || l.method === 'PATCH')).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS c FROM backup_items WHERE interview_id=$1 AND status='VERIFIED'`, [w.interview.id])).rows[0].c).toBe(0);
    // 용량을 확보하고 수동 재시도하면 완료된다(자동 재시도 아님).
    drive.state.limit = null;
    const retry = await w.backup.requestRetry(w.owner, w.interview.id, `cmd-${randomUUID()}`);
    expect(retry).toMatchObject({ ok: true });
    await w.drain();
    expect(await pipelineBackup(w)).toBe('VERIFIED');
  });

  it('AC-4/AC-6 업로드 중 Drive 가 용량 초과(403)로 거절해도 실패로 남고 기존 파일은 유지된다', async () => {
    const w = await world();
    drive.state.rejectQuota = true;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'FAILED', errorCode: 'DRIVE_QUOTA_INSUFFICIENT', autoRetriesUsed: 0 });
    expect(await pipelineBackup(w)).toBe('FAILED');
    expect(drive.log.filter((l) => l.method === 'DELETE')).toEqual([]);
  });

  it('AC-4 Drive 에 올린 파일이 원본과 다르면(MD5 불일치) 완료로 표시하지 않는다', async () => {
    const w = await world();
    drive.state.corruptNextUpload = true;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'FAILED', errorCode: 'VERIFY_MISMATCH' });
    expect(await pipelineBackup(w)).toBe('FAILED');
    expect((await pool.query(`SELECT count(*)::int AS c FROM backup_items WHERE interview_id=$1 AND status='VERIFIED'`, [w.interview.id])).rows[0].c).toBeLessThan(3);
    const readiness = await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true });
    expect(readiness).toMatchObject({ found: true, backedUp: false, ready: false });
  });

  it('AC-4 서버 파일이 기록된 해시와 다르면(손상) 그 항목은 백업하지 않고 나머지는 올리되 완료로 표시하지 않는다', async () => {
    const w = await world();
    await writeFile(path.join(dir, 'attachments', w.att.storageKey), 'tampered');
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'FAILED', errorCode: 'SOURCE_INCOMPLETE' });
    expect(await stateOf(w)).toEqual({ state: 'FAILED', reason: 'SOURCE_INCOMPLETE' });
    expect(driveFilesOf(w).map((f) => f.appProperties.dlKind).sort()).toEqual(['RECORD', 'VIDEO']);
  });

  it('AC-5 일시 오류는 작업당 자동 재시도 1회만: 계속 실패하면 업로드 시도 2번 후 FAILED', async () => {
    const w = await world();
    drive.state.failUploads = 99;
    const before = drive.log.filter((l) => l.path.startsWith('/upload/session/')).length;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'FAILED', autoRetriesUsed: 1, errorCode: 'TRANSIENT_ERROR' });
    expect(drive.log.filter((l) => l.path.startsWith('/upload/session/')).length - before).toBe(2);
    expect(await w.queue.tick()).toBeNull(); // 더 이상 자동으로 돌지 않는다
    expect(await stateOf(w)).toEqual({ state: 'FAILED', reason: 'COPY_FAILED' });
    // 수동 재시도는 사용자 명령으로만, 자동 재시도 사용 횟수는 계승(초기화 없음)
    drive.state.failUploads = 0;
    expect(await w.backup.requestRetry(w.owner, w.interview.id, `cmd-${randomUUID()}`)).toMatchObject({ ok: true });
    await w.drain();
    expect(await w.queue.get(r.job!.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1, manualRequests: 1 });
  });

  it('AC-5 첫 일시 오류는 재시도 대기(RETRYING)로 표시되고 재시도에서 성공하면 완료된다', async () => {
    const w = await world();
    drive.state.failUploads = 1;
    const queued = (await w.backup.enqueueInterview(w.interview.id))!;
    await w.queue.tick(); // 첫 실행 실패
    expect(await w.queue.get(queued.job!.id)).toMatchObject({ state: 'QUEUED', autoRetriesUsed: 1 });
    expect(await stateOf(w)).toEqual({ state: 'PENDING', reason: 'RETRYING' });
    expect(await pipelineBackup(w)).toBe('PENDING');
    await w.drain();
    expect(await w.queue.get(queued.job!.id)).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1 });
    expect(await pipelineBackup(w)).toBe('VERIFIED');
  });

  it('AC-5 응답이 유실된 업로드는 재시도에서 같은 파일을 찾아 이어받고 중복 파일을 만들지 않는다', async () => {
    const w = await world();
    drive.state.loseUploadResponse = true;
    const r = await w.run();
    expect(r.now).toMatchObject({ state: 'SUCCEEDED', autoRetriesUsed: 1 });
    const keys = driveFilesOf(w).map((f) => f.appProperties.dlItemKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(3);
  });

  it('AC-6 정리 가능 여부: 최신 버전 백업·무결성 확인 후에만 ready, 새 버전·Drive 변조가 생기면 다시 false', async () => {
    const w = await world();
    let r = await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true });
    expect(r).toMatchObject({ found: true, backedUp: false, ready: false, reason: 'BACKUP_NOT_CURRENT' });
    await w.run();
    r = await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: false });
    expect(r).toMatchObject({ backedUp: true, ready: null, reason: 'LIVE_CHECK_REQUIRED' }); // 정리 직전에는 Drive 에서 다시 확인해야 한다
    r = await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true });
    expect(r).toMatchObject({ backedUp: true, ready: true, reason: null });
    expect((r as { latestVersion: string }).latestVersion).toMatch(/^rev\d+\./);
    expect((r as { items: unknown[] }).items).toHaveLength(3);
    // 새 버전이 생기면 최신 버전이 백업되기 전까지 정리 불가
    await w.store.appendVersion(w.owner, w.interview.id, 'SUMMARY', { diary: '새 요약', learning: [] }, NOW);
    expect(await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true })).toMatchObject({ backedUp: false, ready: false });
    await w.run();
    expect(await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true })).toMatchObject({ backedUp: true, ready: true });
    // Drive 파일이 휴지통으로 가면 정리 불가
    const video = driveFilesOf(w).find((f) => f.appProperties.dlKind === 'VIDEO')!;
    video.trashed = true;
    expect(await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true })).toMatchObject({ ready: false, reason: 'VERIFY_MISMATCH' });
    video.trashed = false;
    // 인증이 만료되면 확인할 수 없으므로 정리 불가(원본 유지)
    await w.connections.markExpired(w.owner, 'TEST');
    expect(await w.backup.cleanupReadiness(w.owner, w.interview.id, { live: true })).toMatchObject({ ready: false, reason: 'DRIVE_AUTH_EXPIRED' });
    // 타 소유자는 조회할 수 없다
    expect(await w.backup.cleanupReadiness('someone-else', w.interview.id, { live: false })).toEqual({ found: false });
  });

  it('AC-6 서버 원본이 사라져도(만료·사용자 삭제) Drive 백업과 백업 기록은 유지되고 삭제로 전파되지 않는다', async () => {
    const w = await world();
    await w.run();
    const filesBefore = new Map(drive.uploaded().map((f) => [f.id, f.bytes]));
    const itemsBefore = (await pool.query('SELECT id, status FROM backup_items WHERE interview_id=$1', [w.interview.id])).rows;
    // 서버 사본 정리·사용자 삭제를 흉내: 첨부 파일·영상·기록 행 삭제
    await rm(path.join(dir, 'attachments', w.att.storageKey));
    await rm(path.join(dir, 'videos', w.videoName));
    await pool.query('DELETE FROM interviews WHERE id=$1', [w.interview.id]);
    await w.backup.sweep();
    await w.drain();
    for (const [id, bytes] of filesBefore) expect(drive.files.get(id)?.bytes.equals(bytes)).toBe(true);
    expect(drive.files.get([...filesBefore.keys()][0]!)?.trashed).toBe(false);
    expect((await pool.query('SELECT id, status FROM backup_items WHERE interview_id=$1', [w.interview.id])).rows).toEqual(itemsBefore);
    expect(drive.log.filter((l) => l.method === 'DELETE' || l.method === 'PATCH')).toEqual([]);
    // 백업 클라이언트에는 삭제·갱신 기능 자체가 없다.
    const client = new GoogleDriveClient({ accessToken: async () => 'x' }) as unknown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((m) => /delete|trash|remove|update|patch/i.test(m))).toEqual([]);
  });

  it('AC-6 서버 원본이 이미 정리됐어도 검증된 백업이 있으면 같은 내용으로 다시 올리지 않는다', async () => {
    const w = await world();
    await w.run();
    const up = drive.state.uploads;
    await rm(path.join(dir, 'attachments', w.att.storageKey));
    await rm(path.join(dir, 'videos', w.videoName));
    const r = await w.backup.enqueueInterview(w.interview.id);
    expect(r?.job).toBeNull(); // 첨부는 DB 의 해시·크기, 영상은 검증된 백업 기록의 해시·크기로 목록을 구성한다
    expect(drive.state.uploads).toBe(up);
  });

  it('GoogleDriveClient: 폴더는 재사용하고 429/5xx 는 일시, 401 은 인증, 400 은 재시도 불가로 분류한다', async () => {
    const c = new GoogleDriveClient({ accessToken: async () => 'mock-access', apiBase: drive.apiBase, uploadBase: drive.uploadBase });
    const a = await c.ensureFolder('폴더-테스트', null);
    expect(await c.ensureFolder('폴더-테스트', null)).toBe(a);
    drive.state.unauthorized = true;
    await expect(c.quota()).rejects.toMatchObject({ code: 'DRIVE_AUTH_EXPIRED' });
  });

  it('Drive 연결(로그인과 분리): 동의하면 갱신 토큰이 암호화 저장되고, 해제하면 토큰만 지워지며 백업은 남는다', async () => {
    const connections = new PgDriveConnections(pool, vault());
    const app = buildApp({ auth: cfg, sessionSecret: SECRET, fileStorageDir: dir, drive: connections });
    const cookieOf = (sc: string | string[] | undefined, name: string) => ([] as string[]).concat(sc ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1) ?? '';
    // 로그인
    issuer.state.account = { sub: 'drive-owner', email: 'owner@example.test', email_verified: true, name: 'O' };
    const start = await app.inject('/auth/login');
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(authz.headers.get('location')!);
    const login = await app.inject({ url: cb.pathname + cb.search, headers: { cookie: `dl_flow=${cookieOf(start.headers['set-cookie'], 'dl_flow')}` } });
    const session = cookieOf(login.headers['set-cookie'], 'dl_session');
    expect((await app.inject({ url: '/auth/session', headers: { cookie: `dl_session=${session}` } })).json()).toMatchObject({ driveConnected: false, driveState: 'NONE' });
    // Drive 동의
    const dstart = await app.inject({ url: '/auth/drive/connect', headers: { cookie: `dl_session=${session}` } });
    expect(new URL(dstart.headers.location as string).searchParams.get('scope')).toBe(DRIVE_SCOPE);
    const dz = await fetch(dstart.headers.location as string, { redirect: 'manual' });
    const dcb = new URL(dz.headers.get('location')!);
    const done = await app.inject({ url: dcb.pathname + dcb.search, headers: { cookie: `dl_session=${session}; dl_flow=${cookieOf(dstart.headers['set-cookie'], 'dl_flow')}` } });
    expect(done.headers.location).toBe('/?drive=connected');
    const row = (await pool.query(`SELECT refresh_token_enc, status, scope FROM drive_connections WHERE owner_id='drive-owner'`)).rows[0];
    expect(row).toMatchObject({ status: 'CONNECTED', scope: DRIVE_SCOPE });
    expect(row.refresh_token_enc).not.toContain('mock-refresh');
    expect(row.refresh_token_enc).toMatch(/^v1\./);
    const session2 = cookieOf(done.headers['set-cookie'], 'dl_session');
    expect((await app.inject({ url: '/auth/session', headers: { cookie: `dl_session=${session2}` } })).json()).toMatchObject({ driveConnected: true, driveState: 'CONNECTED' });
    // 해제: 토큰 삭제 + Google 철회, 백업 항목은 유지
    await pool.query(`INSERT INTO backup_items (owner_id, interview_id, life_date, item_kind, item_key, version_label, content_sha256, size_bytes) VALUES ('drive-owner', $1, '2031-01-01', 'RECORD', 'record.json', 'v', 'h', 1)`, [randomUUID()]);
    const stored = (await new PgDriveConnections(pool, vault()).refreshToken('drive-owner')) as { token: string };
    const off = await app.inject({ method: 'POST', url: '/auth/drive/disconnect', headers: { cookie: `dl_session=${session2}` } });
    expect(off.json()).toMatchObject({ ok: true, driveConnected: false, revoked: true, backupsKept: true });
    expect(issuer.state.revoked.has(stored.token)).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS c FROM drive_connections WHERE owner_id='drive-owner'`)).rows[0].c).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS c FROM backup_items WHERE owner_id='drive-owner'`)).rows[0].c).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/auth/drive/disconnect' })).statusCode).toBe(401);
    // 갱신 토큰이 오지 않고 기존 연결도 없으면 연결 완료로 보지 않는다.
    issuer.state.omitRefreshToken = true;
    const s3 = await app.inject({ url: '/auth/drive/connect', headers: { cookie: `dl_session=${session2}` } });
    const z3 = await fetch(s3.headers.location as string, { redirect: 'manual' });
    const c3 = new URL(z3.headers.get('location')!);
    const r3 = await app.inject({ url: c3.pathname + c3.search, headers: { cookie: `dl_session=${session2}; dl_flow=${cookieOf(s3.headers['set-cookie'], 'dl_flow')}` } });
    issuer.state.omitRefreshToken = false;
    expect(r3.headers.location).toBe('/?drive=failed');
    expect((await pool.query(`SELECT count(*)::int AS c FROM drive_connections WHERE owner_id='drive-owner'`)).rows[0].c).toBe(0);
    await app.close();
  });

  it('API: 상태·정리 가능 여부·수동 재시도(명령 키 필수·소유자 확인)', async () => {
    const w = await world();
    const app = buildApp({ auth: cfg, sessionSecret: SECRET, fileStorageDir: dir, drive: w.connections, backup: w.backup, records: w.store });
    const iat = Math.floor(Date.now() / 1000);
    const cookieFor = (sub: string) => `dl_session=${sign({ sub, email: 'owner@example.test', iat, exp: iat + 600 }, SECRET, 'session')}`;
    const h = { cookie: cookieFor(w.owner) };
    expect((await app.inject('/api/backup/status')).statusCode).toBe(401);
    drive.state.failUploads = 99;
    await w.run();
    const st = (await app.inject({ url: '/api/backup/status', headers: h })).json();
    expect(st.drive).toBe('CONNECTED');
    expect(st.records.find((r: { id: string }) => r.id === w.interview.id)).toMatchObject({ backup: 'FAILED', reason: 'COPY_FAILED', guidance: expect.stringContaining('기록과 영상은 그대로') });
    const ready = (await app.inject({ url: `/api/backup/records/${w.interview.id}/readiness?live=1`, headers: h })).json();
    expect(ready).toMatchObject({ backedUp: false, ready: false, serverDeleteIsNotPropagatedToDrive: true });
    expect((await app.inject({ url: `/api/backup/records/${w.interview.id}/readiness`, headers: { cookie: cookieFor('stranger') } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/backup/records/${w.interview.id}/retry`, headers: h })).statusCode).toBe(400);
    drive.state.failUploads = 0;
    const key = { ...h, 'idempotency-key': `retry-${randomUUID()}` };
    const first = await app.inject({ method: 'POST', url: `/api/backup/records/${w.interview.id}/retry`, headers: key });
    expect(first.statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: `/api/backup/records/${w.interview.id}/retry`, headers: key })).json()).toMatchObject({ duplicate: true });
    expect((await app.inject({ method: 'POST', url: `/api/backup/records/${w.interview.id}/retry`, headers: { cookie: cookieFor('stranger'), 'idempotency-key': 'abcdefgh1234' } })).statusCode).toBe(404);
    await w.drain();
    expect(await pipelineBackup(w)).toBe('VERIFIED');
    await app.close();
  });
});
