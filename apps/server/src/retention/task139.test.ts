import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { AttachmentService } from '../attachments/service.js';
import { createTempSchema } from '../records/db.testutil.js';
import { RecordStore } from '../records/store.js';
import { RetentionService } from './service.js';

const secret = 'task139-local-session-secret-for-tests';
const now = new Date();
let db: Awaited<ReturnType<typeof createTempSchema>>;
let pool: ReturnType<typeof db.pool>;
let store: RecordStore;
let dir: string;
let seq = 0;
beforeAll(async () => {
  db = await createTempSchema(process.env.DATABASE_URL!);
  pool = db.pool(); store = new RecordStore(pool);
  dir = await mkdtemp('/workspace/data/task139-');
  await mkdir(path.join(dir, 'videos'));
  await mkdir(path.join(dir, 'live-sessions'));
});
afterAll(async () => { await pool?.end(); await db?.drop(); if (dir) await rm(dir, { recursive: true, force: true }); });
const cookie = (sub: string) => ({ cookie: `dl_session=${sign({ sub, email: `${sub}@example.test`, name: sub, drive: false, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 }, secret, 'session')}` });
async function fixture() {
  const owner = `owner${++seq}`;
  const { interview } = await store.startInterview(owner, now);
  const att = await new AttachmentService(store, dir).upload({ ownerId: owner, interviewId: interview.id, key: 'att', kind: 'MARKDOWN', name: 'note.md', bytes: Buffer.from(`synthetic-${seq}`), now });
  const name = `result-${seq}.mp4`;
  await writeFile(path.join(dir, 'videos', name), 'synthetic-video');
  await store.appendVersion(owner, interview.id, 'RESULT', { file: name }, now);
  await pool.query("UPDATE interviews SET status='CONFIRMED' WHERE id=$1", [interview.id]);
  await store.setPipeline(owner, interview.id, { production: 'DONE', review: 'PASSED' }, now);
  const app = buildApp({ records: store, fileStorageDir: dir, sessionSecret: secret, auth: loadAuthConfig({ GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', ALLOWED_EMAILS: `${owner}@example.test,other@example.test`, PUBLIC_BASE_URL: 'http://localhost:3000' }) });
  app.log.level = 'silent';
  return { owner, interview, att, name, app };
}
it('TASK139 AC1: other allowed account cannot read four file paths', async () => {
  const w = await fixture();
  try {
    for (const url of [`/api/attachments/${w.att.storageKey}`, `/api/videos/${w.name}`, `/api/records/${w.interview.id}/attachments/${w.att.id}/file`, `/api/records/${w.interview.id}/result/file`]) {
      const r = await w.app.inject({ url, headers: cookie('other') });
      expect.soft(r.statusCode, url).toBe(404);
      expect.soft(r.body, url).not.toContain('synthetic');
      if (!url.startsWith('/api/records/')) expect.soft(r.body, url).toBe('');
    }
  } finally { await w.app.close(); }
});
it('TASK139 AC2: owner approved files work; rejected video is blocked', async () => {
  const w = await fixture();
  try {
    for (const url of [`/api/attachments/${w.att.storageKey}`, `/api/videos/${w.name}`]) expect((await w.app.inject({ url, headers: cookie(w.owner) })).statusCode).toBe(200);
    await store.setPipeline(w.owner, w.interview.id, { review: 'REJECTED' }, now);
    const r = await w.app.inject({ url: `/api/videos/${w.name}`, headers: cookie(w.owner) });
    expect([404,409]).toContain(r.statusCode);
    expect(r.body).not.toContain('synthetic-video');
  } finally { await w.app.close(); }
});
for (const mode of ['immediate', 'expired'] as const) it(`TASK139 AC3: ${mode} purge removes only ended matching transcripts`, async () => {
  const w = await fixture(); await w.app.close();
  const files = ['ended', 'active', 'other'].map(k => path.join(dir, 'live-sessions', `live-${mode}-${k}.json`));
  for (let i=0;i<files.length;i++) await writeFile(files[i]!, JSON.stringify({ interviewId: i===2 ? 'other-record' : w.interview.id, endedAt: i===1 ? null : now.toISOString(), turns: [{ userText: 'synthetic-transcript' }] }));
  const retention = new RetentionService({ pool, fileStorageDir: dir, backup: { cleanupReadiness: async () => ({ found: false }) } });
  if (mode === 'immediate') await retention.purgeNow(w.owner, { scope: 'RECORD', interviewId: w.interview.id });
  else { await store.trashRecord(w.owner, w.interview.id, new Date(now.getTime()-31*86400000)); await retention.sweepTrash(now); }
  expect.soft(await stat(files[0]!).then(()=>true,()=>false)).toBe(false);
  for (const f of files.slice(1)) expect(await stat(f).then(()=>true,()=>false)).toBe(true);
});

it('TASK139 AC3: processing job/session deferred then retried, custom session directory', async () => {
  const w = await fixture(); await w.app.close();
  const sessionDir = path.join(dir, 'custom-sessions'); await mkdir(sessionDir);
  const file = path.join(sessionDir, 'live-deferred.json');
  const session = { interviewId: w.interview.id, endedAt: now.toISOString(), processing: true, turns: [{ userText: 'synthetic' }] };
  await writeFile(file, JSON.stringify(session));
  const retention = new RetentionService({ pool, fileStorageDir: dir, sessionDir, backup: { cleanupReadiness: async () => ({ found: false }) } });
  await retention.purgeNow(w.owner, { scope: 'RECORD', interviewId: w.interview.id });
  expect(await stat(file).then(()=>true,()=>false)).toBe(true);
  session.processing = false; await writeFile(file, JSON.stringify(session));
  const job = await pool.query("INSERT INTO jobs (kind, subject_id, stages, idempotency_key, state) VALUES ('video', $1, ARRAY['render'], 'task139-job', 'RUNNING') RETURNING id", [w.interview.id]);
  await retention.drainFileQueue();
  expect(await stat(file).then(()=>true,()=>false)).toBe(true);
  await pool.query('DELETE FROM jobs WHERE id=$1', [job.rows[0].id]);
  await retention.drainFileQueue();
  expect(await stat(file).then(()=>true,()=>false)).toBe(false);
});
it('TASK139: stale/rejected previous versions and trashed files cannot bypass record routes', async () => {
  const w = await fixture();
  try {
    await store.appendVersion(w.owner, w.interview.id, 'RESULT', { file: 'new-result.mp4' }, now);
    const url = `/api/videos/${w.name}`;
    expect((await w.app.inject({ url, headers: cookie(w.owner) })).statusCode).toBe(404);
    await pool.query('INSERT INTO result_version_marks (interview_id, version, was_passed, superseded_at, superseded_by_revision) VALUES ($1,1,false,$2,2)', [w.interview.id, now]);
    expect((await w.app.inject({ url, headers: cookie(w.owner) })).statusCode).toBe(404);
    await pool.query('UPDATE result_version_marks SET was_passed=true WHERE interview_id=$1', [w.interview.id]);
    expect((await w.app.inject({ url, headers: cookie(w.owner) })).statusCode).toBe(200);
    await store.trashRecord(w.owner, w.interview.id, now);
    for (const u of [url, `/api/attachments/${w.att.storageKey}`]) expect((await w.app.inject({ url: u, headers: cookie(w.owner) })).statusCode).toBe(404);
  } finally { await w.app.close(); }
});
