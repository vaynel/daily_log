import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { AttachmentService } from '../attachments/service.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { RecordStore } from '../records/store.js';
import { createTempSchema } from '../records/db.testutil.js';
import { RetentionService } from '../retention/service.js';
import { buildBackupPlan } from './plan.js';
import { startFakeDrive } from './fakeDrive.testutil.js';
import { GoogleDriveClient } from './drive.js';
import { restoreDrill, type RestoreManifest } from './restore.js';

const hash = (b: Buffer, alg = 'sha256') => createHash(alg).update(b).digest('hex');
const secret = 'unit-test-session-secret-0123456789';
const owner = 'synthetic-restore-owner';
const root = path.resolve('../../data/task31');
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('TASK-31 isolated restore drill', () => {
  let source: Awaited<ReturnType<typeof createTempSchema>>;
  let sourcePool: pg.Pool;
  let drive: Awaited<ReturnType<typeof startFakeDrive>>;
  let dir: string;
  let targets: string;
  let manifest: RestoreManifest;
  let snapshot: Buffer;
  let attachment: Buffer;
  let video: Buffer;
  let sourceBefore: string;
  const restored: Awaited<ReturnType<typeof restoreDrill>>[] = [];
  const sourceState = async () => JSON.stringify(await Promise.all(['interviews', 'conversation_items', 'attachment_refs', 'record_versions', 'audio_segments', 'pipeline_states', 'result_version_marks'].map(async table => (await sourcePool.query(`SELECT row_to_json(i) AS row FROM ${table} i ORDER BY row_to_json(i)::text`)).rows)));
  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    source = await createTempSchema(url!); sourcePool = source.pool();
    drive = await startFakeDrive();
    dir = await mkdtemp(path.join(root, 'source-'));
    targets = await mkdtemp(path.join(root, 'targets-'));
    const store = new RecordStore(sourcePool);
    const at = new Date('2026-01-31T01:00:00Z');
    const { interview } = await store.startInterview(owner, at);
    const item = await store.saveItem(owner, interview.id, 'question', 'QUESTION', 'Synthetic question', at);
    await store.saveItem(owner, interview.id, 'answer', 'ANSWER', 'Synthetic answer', at);
    attachment = Buffer.from('# Synthetic restoration note\nNo personal data.');
    await new AttachmentService(store, dir).upload({ ownerId: owner, interviewId: interview.id, itemId: item.id, key: 'attachment', kind: 'MARKDOWN', name: 'note.md', bytes: attachment, now: at });
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: 'Synthetic diary', learning: [] }, at);
    await mkdir(path.join(dir, 'videos'));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'videos', 'synthetic.mp4')]);
    video = await readFile(path.join(dir, 'videos', 'synthetic.mp4'));
    await writeFile(path.join(root, 'synthetic.mp4'), video);
    await store.appendVersion(owner, interview.id, 'RESULT', { file: 'synthetic.mp4', sha256: hash(video), bytes: video.length }, at);
    await store.confirm(owner, interview.id, at);
    await sourcePool.query("UPDATE pipeline_states SET production='DONE', review='PASSED' WHERE interview_id=$1", [interview.id]);
    await store.saveAudioSegment(owner, interview.id, 'never-backed-up', at);
    const plan = (await buildBackupPlan(sourcePool, dir, interview.id))!;
    expect(plan.problems).toEqual([]);
    const client = new GoogleDriveClient({ accessToken: async () => 'mock-access-restore', apiBase: drive.apiBase, uploadBase: drive.uploadBase });
    manifest = { ownerId: owner, interviewId: interview.id, items: [] };
    for (const i of plan.items) {
      const bytes = 'bytes' in i.source ? i.source.bytes : await readFile(i.source.file);
      const file = await client.upload({ name: i.driveName, parentId: 'synthetic-folder', mime: i.mime, bytes, appProperties: { dlInterview: interview.id, dlKind: i.kind, dlVersion: i.label, dlSha256: i.sha256 } });
      manifest.items.push({ kind: i.kind, key: i.key, version: i.label, sha256: i.sha256, md5: file.md5!, size: i.size, fileId: file.id });
      if (i.kind === 'RECORD') snapshot = bytes;
    }
    sourceBefore = await sourceState();
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }, 20000);
  afterAll(async () => {
    for (const r of restored) {
      const admin = new pg.Pool({ connectionString: url, max: 1 });
      await admin.query(`DROP SCHEMA "${r.schema}" CASCADE`); await admin.end();
    }
    await sourcePool?.end(); await source?.drop(); await drive?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (targets) await rm(targets, { recursive: true, force: true });
  });
  const run = (m = manifest, overrides = {}) => restoreDrill({ databaseUrl: url!, targetParent: targets, sourceFileStorageDir: dir, manifest: m, driveApiBase: drive.apiBase, ...overrides });
  const schemaList = async () => (await sourcePool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_drill_%' ORDER BY nspname")).rows;

  it('backs up stable item links, timestamps and review state without audio or mutable backup status', async () => {
    const s = JSON.parse(snapshot.toString());
    expect(s.schema).toBe(2);
    expect(s.items[0].id).toBe(s.attachments[0].itemId);
    expect(s.pipeline).toEqual({ production: 'DONE', review: 'PASSED' });
    expect(s.startedAt).toBe('2026-01-31T01:00:00.000Z');
    expect(s).not.toHaveProperty('audio');
    await sourcePool.query("UPDATE pipeline_states SET backup='VERIFIED'");
    const again = (await buildBackupPlan(sourcePool, dir, manifest.interviewId))!;
    expect(again.items[0]!.sha256).toBe(hash(snapshot));
    sourceBefore = await sourceState();
  });

  it('restores into a fresh schema/directory; real app APIs return content and identical file bytes, rejecting strangers', async () => {
    const r = await run(); restored.push(r);
    expect(r.schema).not.toBe(source.schema);
    expect(r.fileStorageDir.startsWith(targets + path.sep)).toBe(true);
    expect(await readFile(path.join(r.fileStorageDir, 'record.json'))).toEqual(snapshot);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${r.schema}` });
    const app = buildApp({ records: new RecordStore(pool), fileStorageDir: r.fileStorageDir, sessionSecret: secret,
      auth: loadAuthConfig({ GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret-value', ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })! });
    const headers = (sub = owner) => { const iat = Math.floor(Date.now() / 1000); return { cookie: `dl_session=${sign({ sub, email: 'owner@example.test', iat, exp: iat + 3600 }, secret, 'session')}` }; };
    try {
      const base = `/api/records/${manifest.interviewId}`;
      const detail = await app.inject({ url: base, headers: headers() });
      expect(detail.statusCode).toBe(200);
      const d = detail.json();
      expect(d.conversation.map((i: { body: string }) => i.body)).toEqual(['Synthetic question', 'Synthetic answer']);
      expect(d.summary.diary).toBe('Synthetic diary');
      expect(d.attachments[0].itemId).toBe(d.conversation[0].id);
      const attUrl = `${base}/attachments/${d.attachments[0].id}/file`;
      const videoUrl = `${base}/result/file`;
      for (const [u, bytes] of [[attUrl, attachment], [videoUrl, video]] as const) {
        const response = await app.inject({ url: u, headers: headers() });
        expect(response.statusCode).toBe(200); expect(hash(response.rawPayload)).toBe(hash(bytes));
      }
      for (const u of [base, attUrl, videoUrl]) {
        expect((await app.inject({ url: u })).statusCode).toBe(401);
        expect((await app.inject({ url: u, headers: headers('stranger') })).statusCode).toBe(404);
      }
      expect((await pool.query('SELECT count(*) FROM audio_segments')).rows[0].count).toBe('0');
      expect(await sourceState()).toBe(sourceBefore);
      expect(await readFile(path.join(dir, 'videos', 'synthetic.mp4'))).toEqual(video);
      const attFile = manifest.items.find(i => i.kind === 'ATTACHMENT')!;
      expect(await readFile(path.join(dir, 'attachments', attFile.key))).toEqual(attachment);
      const evidence = { result: 'PASS', sourceSchema: source.schema, restoredSchema: r.schema, sourceDir: dir, restoredDir: r.fileStorageDir, api: { record: 200, attachment: 200, video: 200, unauthenticated: 401, wrongOwner: 404 }, hashes: { record: hash(snapshot), attachment: hash(attachment), video: hash(video), sourceDatabaseBefore: hash(Buffer.from(sourceBefore)), sourceDatabaseAfter: hash(Buffer.from(await sourceState())) }, sourceUnchanged: true, video: 'ffmpeg 64x64 blue 0.2s H.264, no audio', manifest };
      await writeFile(path.join(root, 'drill.json'), JSON.stringify(evidence, null, 2));
      console.log('DRILL', JSON.stringify(evidence));
    } finally { await app.close(); await pool.end(); }
  });

  it.each(['missing', 'truncated', 'short-download', 'corrupt-download', 'md5', 'sha256'] as const)('fails closed for %s backup; no successful target remains', async (fault) => {
    const item = manifest.items.find(i => i.kind === 'ATTACHMENT')!;
    const file = drive.files.get(item.fileId)!;
    const original = Buffer.from(file.bytes);
    const before = await schemaList(); const dirs = await readdir(targets);
    try {
      if (fault === 'missing') drive.files.delete(file.id);
      if (fault === 'truncated') file.bytes = file.bytes.subarray(0, 3);
      if (fault === 'short-download') file.mediaOverride = file.bytes.subarray(0, 3);
      if (fault === 'corrupt-download') file.mediaOverride = Buffer.alloc(file.bytes.length, 0);
      if (fault === 'md5') file.md5Override = '0'.repeat(32);
      const m = structuredClone(manifest);
      if (fault === 'sha256') { m.items.find(i => i.kind === 'ATTACHMENT')!.sha256 = '0'.repeat(64); file.appProperties.dlSha256 = '0'.repeat(64); }
      await expect(run(m)).rejects.toMatchObject({ code: { missing: 'BACKUP_MISSING', truncated: 'SIZE_MISMATCH', 'short-download': 'SIZE_MISMATCH', 'corrupt-download': 'MD5_MISMATCH', md5: 'MD5_MISMATCH', sha256: 'SHA256_MISMATCH' }[fault] });
      expect(await schemaList()).toEqual(before); expect(await readdir(targets)).toEqual(dirs);
      expect(await sourceState()).toBe(sourceBefore);
    } finally { file.bytes = original; delete file.md5Override; delete file.mediaOverride; file.appProperties.dlSha256 = item.sha256; drive.files.set(file.id, file); }
  });

  it('rejects missing manifest dependencies, unsafe paths, source overlap and real Drive', async () => {
    await expect(run({ ...manifest, items: manifest.items.filter(i => i.kind !== 'ATTACHMENT') })).rejects.toMatchObject({ code: 'MANIFEST_INCOMPLETE' });
    const bad = structuredClone(manifest); bad.items[1]!.key = '../outside';
    await expect(run(bad)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await expect(run(manifest, { targetParent: dir })).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
    await expect(run(manifest, { driveApiBase: 'https://www.googleapis.com/drive/v3' })).rejects.toMatchObject({ code: 'LOCAL_DRIVE_REQUIRED' });
  });

  it.each([['legacy', 'UNSUPPORTED_SNAPSHOT'], ['invalid-date', 'RESTORE_WRITE_FAILED']] as const)('rejects %s snapshots and rolls back schemas/files on write failure', async (fault, code) => {
    const m = structuredClone(manifest); const i = m.items.find(i => i.kind === 'RECORD')!;
    const f = drive.files.get(i.fileId)!; const original = Buffer.from(f.bytes); const props = { ...f.appProperties };
    const s = JSON.parse(original.toString());
    if (fault === 'legacy') s.schema = 1; else s.lifeDate = '2026-99-99';
    f.bytes = Buffer.from(JSON.stringify(s)); i.sha256 = hash(f.bytes); i.md5 = hash(f.bytes, 'md5'); i.size = f.bytes.length;
    f.appProperties.dlSha256 = i.sha256;
    const before = await schemaList(); const dirs = await readdir(targets);
    try {
      await expect(run(m)).rejects.toMatchObject({ code });
      expect(await schemaList()).toEqual(before); expect(await readdir(targets)).toEqual(dirs);
      expect(await sourceState()).toBe(sourceBefore);
    } finally { f.bytes = original; f.appProperties = props; }
  });

  it.each(['rejected', 'superseded'] as const)('preserves %s video restrictions instead of approving restored results', async (state) => {
    const m = structuredClone(manifest); const i = m.items.find(i => i.kind === 'RECORD')!;
    const f = drive.files.get(i.fileId)!; const original = Buffer.from(f.bytes); const props = { ...f.appProperties };
    const s = JSON.parse(original.toString());
    if (state === 'rejected') s.pipeline.review = 'REJECTED';
    else s.resultMarks = [{ version: 1, was_passed: true, superseded_at: '2026-02-01T00:00:00Z', superseded_by_revision: 2 }];
    f.bytes = Buffer.from(JSON.stringify(s)); i.sha256 = hash(f.bytes); i.md5 = hash(f.bytes, 'md5'); i.size = f.bytes.length; f.appProperties.dlSha256 = i.sha256;
    try {
      const r = await run(m); restored.push(r);
      const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${r.schema}` });
      const app = buildApp({ records: new RecordStore(pool), fileStorageDir: r.fileStorageDir, sessionSecret: secret,
        auth: loadAuthConfig({ GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret-value', ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })! });
      try {
        const iat = Math.floor(Date.now() / 1000);
        const response = await app.inject({ url: `/api/records/${manifest.interviewId}/result/file`, headers: { cookie: `dl_session=${sign({ sub: owner, email: 'owner@example.test', iat, exp: iat + 3600 }, secret, 'session')}` } });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toBe('NOT_DOWNLOADABLE');
      } finally { await app.close(); await pool.end(); }
    } finally { f.bytes = original; f.appProperties = props; }
  });

  it('restores only the drill after real source purge; leaves source deletion and Drive/video hashes intact', async () => {
    const store = new RecordStore(sourcePool);
    const retention = new RetentionService({ pool: sourcePool, fileStorageDir: dir, backup: { cleanupReadiness: async () => ({ found: false }) } });
    const before = new Map(drive.uploaded().map(f => [f.id, hash(f.bytes)]));
    await retention.purgeNow(owner, { scope: 'RECORD', interviewId: manifest.interviewId }, new Date());
    const purged = await sourceState();
    expect(await store.loadById(owner, manifest.interviewId, new Date())).toBeNull();
    const r = await run(); restored.push(r);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${r.schema}` });
    try {
      expect((await new RecordStore(pool).loadById(owner, manifest.interviewId, new Date()))!.items).toHaveLength(2);
      expect(await sourceState()).toBe(purged);
      expect(await store.loadById(owner, manifest.interviewId, new Date())).toBeNull();
      expect(await readFile(path.join(dir, 'videos', 'synthetic.mp4'))).toEqual(video);
      for (const f of drive.uploaded()) expect(hash(f.bytes)).toBe(before.get(f.id));
      expect(drive.log.filter(l => l.method === 'DELETE' || l.method === 'PATCH')).toEqual([]);
    } finally { await pool.end(); }
  });
});
