import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from '../../apps/server/src/app.js';
import { AttachmentService } from '../../apps/server/src/attachments/service.js';
import { loadAuthConfig, DRIVE_SCOPE } from '../../apps/server/src/auth/config.js';
import { startMockIssuer } from '../../apps/server/src/auth/mock-issuer.js';
import { OidcClient } from '../../apps/server/src/auth/oidc.js';
import { PgDriveConnections } from '../../apps/server/src/backup/connections.js';
import { createDriveFactory } from '../../apps/server/src/backup/drive.js';
import { startFakeDrive, type FakeFile } from '../../apps/server/src/backup/fakeDrive.testutil.js';
import { buildBackupPlan } from '../../apps/server/src/backup/plan.js';
import { BACKUP_KIND, BackupService } from '../../apps/server/src/backup/service.js';
import { TokenVault } from '../../apps/server/src/backup/vault.js';
import { MonthlyLedger } from '../../apps/server/src/budget/ledger.js';
import { JobQueue } from '../../apps/server/src/jobs/queue.js';
import { RecordStore } from '../../apps/server/src/records/store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = (b: Buffer, algorithm = 'sha256') => createHash(algorithm).update(b).digest('hex');
const emit = (check: string, evidence: unknown) => console.log(JSON.stringify({ check, evidence }));
let stage = 'prerequisites';

async function verify() {
  if (process.argv.slice(2).join(' ') !== '--fake' || !process.env.DATABASE_URL || process.env.TASK101_TEST_DB !== '1') {
    emit('NOT_RUN', { reason: 'REQUIRES_FAKE_MODE_INJECTED_DATABASE_AND_TASK101_TEST_DB_1', actualGoogleDrive: 'NOT_RUN' });
    process.exitCode = 2;
    return;
  }
  // The only DB source is the injected isolated service. No application env/config is loaded.
  const schema = `task101_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000, options: `-c search_path=${schema}` });
  let drive: Awaited<ReturnType<typeof startFakeDrive>> | undefined;
  let issuer: Awaited<ReturnType<typeof startMockIssuer>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  const originalFetch = globalThis.fetch;
  const allowed = new Set<string>();
  let blockedRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowed.has(url.origin)) { blockedRequests++; throw new Error('NETWORK_TARGET_BLOCKED'); }
    return originalFetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  };
  try {
    stage = 'isolated-schema';
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations = path.join(root, 'apps/server/src/db/migrations');
    for (const name of (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort()) {
      await pool.query(await readFile(path.join(migrations, name), 'utf8'));
    }
    await mkdir(path.join(root, 'data/task101'), { recursive: true });
    const dir = await mkdtemp(path.join(root, 'data/task101/run-'));
    drive = await startFakeDrive();
    issuer = await startMockIssuer({ clientId: 'task101-fake-client', clientSecret: 'task101-fake-client-secret' });
    allowed.add(drive.base); allowed.add(issuer.issuer);
    const cfg = loadAuthConfig({ GOOGLE_CLIENT_ID: 'task101-fake-client', GOOGLE_CLIENT_SECRET: 'task101-fake-client-secret', GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://127.0.0.1:3000' })!;
    const secret = randomBytes(32).toString('hex');
    const connections = new PgDriveConnections(pool, new TokenVault(secret));
    const store = new RecordStore(pool);
    const handlers: ConstructorParameters<typeof JobQueue>[0]['handlers'] = {};
    const queue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers });
    const backup = new BackupService({ pool, queue, fileStorageDir: dir, connections, drive: createDriveFactory({ connections, oidc: new OidcClient(cfg), apiBase: drive.apiBase, uploadBase: drive.uploadBase }) });
    handlers[BACKUP_KIND] = backup.handlers();
    app = buildApp({ auth: cfg, sessionSecret: secret, fileStorageDir: dir, records: store, drive: connections, backup });
    // Existing app logs request URLs (OAuth code/state). Silence before ANY injection.
    app.log.level = 'silent';
    const cookieOf = (sc: string | string[] | undefined, name: string) => ([] as string[]).concat(sc ?? []).find(c => c.startsWith(`${name}=`))?.split(';')[0] ?? '';
    let cookie = '';
    async function oauth(route: string) {
      const start = await app!.inject({ url: route, headers: { cookie } });
      assert.equal(start.statusCode, 302);
      if (route.includes('drive')) assert.equal(new URL(String(start.headers.location)).searchParams.get('scope'), DRIVE_SCOPE);
      const authz = await fetch(String(start.headers.location));
      const cb = new URL(authz.headers.get('location')!);
      const done = await app!.inject({ url: cb.pathname + cb.search, headers: { cookie: [cookie, cookieOf(start.headers['set-cookie'], 'dl_flow')].filter(Boolean).join('; ') } });
      assert.equal(done.statusCode, 302);
      cookie = cookieOf(done.headers['set-cookie'], 'dl_session') || cookie;
      return done;
    }
    stage = 'oauth-routes';
    await oauth('/auth/login');
    assert.equal((await app.inject({ url: '/auth/session', headers: { cookie } })).json().driveConnected, false);
    assert.equal((await oauth('/auth/drive/connect')).headers.location, '/?drive=connected');
    assert.equal((await app.inject({ url: '/auth/session', headers: { cookie } })).json().driveState, 'CONNECTED');
    emit('fakeOAuth', { result: 'PASS', loginAndSeparateDriveConsent: true, scope: 'drive.file' });
    stage = 'synthetic-inputs';
    const owner = issuer.state.account.sub;
    const now = new Date();
    const { interview } = await store.startInterview(owner, now);
    await store.saveItem(owner, interview.id, 'synthetic-q', 'QUESTION', '합성 질문', now);
    await store.saveItem(owner, interview.id, 'synthetic-a', 'ANSWER', '검증 전용 합성 답변', now);
    const attachment = await new AttachmentService(store, dir).upload({ ownerId: owner, interviewId: interview.id, key: 'synthetic-attachment', kind: 'MARKDOWN', name: 'synthetic.md', bytes: Buffer.from('# TASK101 합성 첨부\n비공개 실제 기록 없음'), now });
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: '합성 요약', learning: [] }, now);
    await mkdir(path.join(dir, 'videos'));
    const source = path.join(root, 'scripts/video-spike/out/sample.mp4');
    const original = await readFile(source);
    assert.ok(original.length > 0 && original.length < 5_000_000);
    assert.equal(original.subarray(4, 8).toString(), 'ftyp');
    await copyFile(source, path.join(dir, 'videos/synthetic.mp4'));
    await store.appendVersion(owner, interview.id, 'RESULT', { file: 'synthetic.mp4' }, now);
    await store.saveAudioSegment(owner, interview.id, 'synthetic-audio-excluded', now);
    await store.confirm(owner, interview.id, now);
    const plan = (await buildBackupPlan(pool, dir, interview.id))!;
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.items.map(x => x.kind).sort(), ['ATTACHMENT', 'RECORD', 'VIDEO']);
    const headers = { cookie };
    const route = `/api/backup/records/${interview.id}`;
    const readiness = async (live = true) => {
      const r = await app!.inject({ url: `${route}/readiness${live ? '?live=1' : ''}`, headers });
      assert.equal(r.statusCode, 200);
      return r.json();
    };
    assert.equal((await readiness()).ready, false);
    assert.equal((await app.inject({ method: 'POST', url: `${route}/run` })).statusCode, 401);
    stage = 'backup-run-route';
    const run = await app.inject({ method: 'POST', url: `${route}/run`, headers });
    assert.equal(run.statusCode, 202); assert.equal(run.json().queued, true);
    for (let n = 0; n < 20 && await queue.tick(); n++); // bounded, no scheduler/daemon
    const rows = (await pool.query('SELECT item_kind, version_label, status, drive_md5, size_bytes, content_sha256 FROM backup_items WHERE interview_id=$1 ORDER BY item_kind', [interview.id])).rows;
    assert.equal(rows.length, 3);
    assert.equal(drive.uploaded().length, 3);
    for (const item of plan.items) {
      const file: FakeFile = drive.uploaded().find(f => f.appProperties.dlKind === item.kind)!;
      assert.ok(file);
      const bytes = 'bytes' in item.source ? item.source.bytes : await readFile(item.source.file);
      assert.deepEqual(file.bytes, bytes);
      assert.equal(file.appProperties.dlVersion, item.label);
      const row = rows.find(r => r.item_kind === item.kind)!;
      assert.equal(row.status, 'VERIFIED'); assert.equal(row.version_label, item.label);
      assert.equal(Number(row.size_bytes), item.size); assert.equal(file.bytes.length, item.size);
      assert.equal(row.content_sha256, hash(bytes)); assert.equal(row.content_sha256, item.sha256);
      assert.equal(row.drive_md5, hash(file.bytes, 'md5'));
    }
    const snap = drive.uploaded().find(f => f.appProperties.dlKind === 'RECORD')!.bytes.toString();
    assert.doesNotMatch(snap, /audio|segment|expires/i);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM audio_segments WHERE interview_id=$1', [interview.id])).rows[0].n, 1);
    emit('versionSizeHashAndAudioExclusion', { result: 'PASS', rows });
    stage = 'live-readiness';
    assert.equal((await readiness(false)).ready, null);
    const live = await readiness(); assert.equal(live.ready, true);
    emit('readinessLive', { result: 'PASS', response: live });
    stage = 'duplicate-run';
    const uploaded = drive.uploaded().length;
    assert.equal((await app.inject({ method: 'POST', url: `${route}/run`, headers })).json().alreadyBackedUp, true);
    assert.equal(drive.uploaded().length, uploaded);
    stage = 'corrupted-remote';
    drive.uploaded()[0]!.md5Override = '0'.repeat(32);
    assert.equal((await readiness()).ready, false);
    drive.uploaded()[0]!.md5Override = undefined;
    stage = 'new-version';
    await store.appendVersion(owner, interview.id, 'SUMMARY', { diary: '합성 요약 v2' }, now);
    assert.equal((await readiness()).ready, false);
    await app.inject({ method: 'POST', url: `${route}/run`, headers });
    for (let n = 0; n < 20 && await queue.tick(); n++);
    assert.equal(drive.uploaded().length, uploaded + 1);
    assert.equal((await readiness()).ready, true);
    assert.equal(drive.uploaded().filter(f => f.appProperties.dlKind === 'RECORD').length, 2);
    stage = 'unauthorized-remote';
    drive.state.unauthorized = true;
    assert.equal((await readiness()).ready, false);
    stage = 'source-preservation';
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await readFile(path.join(dir, 'videos/synthetic.mp4')), original);
    assert.equal(hash(await readFile(path.join(dir, 'attachments', attachment.storageKey))), plan.items.find(i => i.kind === 'ATTACHMENT')!.sha256);
    assert.equal(drive.log.some(l => l.method === 'DELETE' || l.method === 'PATCH'), false);
    assert.equal(blockedRequests, 0);
    emit('nonDestructiveAndFailureChecks', { result: 'PASS', duplicateSkipped: true, newVersionRetainsOld: true, mismatchBlocksReadiness: true, staleVersionBlocksReadiness: true, revokedAccessBlocksReadiness: true, sourcesPreserved: true, destructiveRequests: 0, externalRequests: 0 });
    emit('result', { result: 'PASS', schema, syntheticDirectory: path.relative(root, dir), actualGoogleDrive: 'NOT_RUN', actualAndroid: 'NOT_RUN', deployment: 'NOT_RUN' });
  } finally {
    await app?.close();
    await drive?.close();
    await issuer?.close();
    await pool.end(); await admin.end();
    globalThis.fetch = originalFetch;
    // Intentionally retain synthetic schema/files. No deletion or trash operation.
  }
}
verify().catch(() => {
  // Errors can embed credentials, URLs or request bodies: output only the stage.
  emit('result', { result: 'FAIL', stage, actualGoogleDrive: 'NOT_RUN' });
  process.exitCode = 1;
});
