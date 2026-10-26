import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyRequest } from 'fastify';
import { buildApp } from '../../apps/server/src/app.js';
import { AttachmentService } from '../../apps/server/src/attachments/service.js';
import type { AuthConfig } from '../../apps/server/src/auth/config.js';
import type { SessionClaims } from '../../apps/server/src/auth/session.js';
import { OidcClient } from '../../apps/server/src/auth/oidc.js';
import { startMockIssuer } from '../../apps/server/src/auth/mock-issuer.js';
import { PgDriveConnections } from '../../apps/server/src/backup/connections.js';
import { createDriveFactory } from '../../apps/server/src/backup/drive.js';
import { startFakeDrive } from '../../apps/server/src/backup/fakeDrive.testutil.js';
import { BACKUP_KIND, BackupService } from '../../apps/server/src/backup/service.js';
import { TokenVault } from '../../apps/server/src/backup/vault.js';
import { MonthlyLedger } from '../../apps/server/src/budget/ledger.js';
import { JobQueue } from '../../apps/server/src/jobs/queue.js';
import { RecordStore } from '../../apps/server/src/records/store.js';
import { guardedFetch, readiness, type ProtectedSettings } from './config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const sourceVideo = path.join(root, 'scripts/video-spike/out/sample.mp4');
const owner = (req: FastifyRequest) => (req as FastifyRequest & { user: SessionClaims }).user.sub;

export async function startValidationApp(o: { mode: '--fake' | '--real'; databaseUrl: string; settings?: ProtectedSettings; port?: number }) {
  const settings = o.settings ?? {};
  if (readiness(o.mode, o.databaseUrl, settings).result !== 'CONFIG_READY') throw new Error('NOT_READY');
  if (o.mode === '--real' && o.port !== undefined && o.port !== 3000) throw new Error('LOOPBACK_PORT_REQUIRED');
  if (!(await realpath(root)).startsWith('/workspace/')) {
    if ((await realpath(root)) !== '/workspace') throw new Error('WORKSPACE_REQUIRED');
  }
  const schema = `task103_${randomBytes(12).toString('hex')}`;
  const options = { connectionString: o.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000, idleTimeoutMillis: 5000 };
  const admin = new pg.Pool({ ...options, max: 1, options: '-c search_path=pg_catalog' });
  const pool = new pg.Pool({ ...options, max: 4, options: `-c search_path=${schema}` });
  // PG errors may contain connection details. Do not let background errors print them.
  admin.on('error', () => {}); pool.on('error', () => {});
  let issuer: Awaited<ReturnType<typeof startMockIssuer>> | undefined;
  let fakeDrive: Awaited<ReturnType<typeof startFakeDrive>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  const close = async () => {
    await app?.close(); await issuer?.close(); await fakeDrive?.close();
    await pool.end(); await admin.end();
    // Keep every synthetic schema/file/Drive copy. Never DROP/unlink/trash.
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations = path.join(root, 'apps/server/src/db/migrations');
    for (const name of (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort()) {
      await pool.query(await readFile(path.join(migrations, name), 'utf8'));
    }
    const parent = path.join(root, 'data/task103');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await realpath(parent)).startsWith(`${await realpath(root)}/`)) throw new Error('WORKSPACE_REQUIRED');
    const dir = await mkdtemp(path.join(parent, 'run-'));
    if (o.mode === '--fake') {
      issuer = await startMockIssuer({ clientId: 'task103-fake', clientSecret: 'task103-fake-secret' });
      fakeDrive = await startFakeDrive();
    }
    const network = guardedFetch(new Set(issuer && fakeDrive ? [issuer.issuer, fakeDrive.base] : [
      'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com',
    ]));
    const cfg: AuthConfig = {
      issuer: issuer?.issuer ?? 'https://accounts.google.com',
      clientId: issuer ? 'task103-fake' : settings.clientId!,
      clientSecret: issuer ? 'task103-fake-secret' : settings.clientSecret!,
      allowedEmails: [issuer ? 'owner@example.test' : settings.allowedEmail!.toLowerCase()],
      publicBaseUrl: 'http://127.0.0.1:3000', appUrl: '/', sessionTtlSeconds: 3600,
    };
    const sessionSecret = issuer ? randomBytes(32).toString('hex') : settings.sessionSecret!;
    const connections = new PgDriveConnections(pool, new TokenVault(issuer ? randomBytes(32).toString('hex') : settings.tokenKey!));
    const store = new RecordStore(pool);
    const handlers: ConstructorParameters<typeof JobQueue>[0]['handlers'] = {};
    const queue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers });
    const backup = new BackupService({ pool, queue, fileStorageDir: dir, connections,
      drive: createDriveFactory({ connections, oidc: new OidcClient(cfg, network.request), fetchImpl: network.request,
        apiBase: fakeDrive?.apiBase, uploadBase: fakeDrive?.uploadBase }) });
    handlers[BACKUP_KIND] = backup.handlers();
    app = buildApp({ auth: cfg, sessionSecret, fileStorageDir: dir, records: store, drive: connections, backup, fetchImpl: network.request });
    app.log.level = 'silent'; // before listen/ready: callbacks and cookies must never enter logs
    app.setErrorHandler((_error, _req, reply) => reply.code(500).send({ error: 'VALIDATION_REQUEST_FAILED' }));
    let boundOwner: string | undefined;
    let synthetic: { id: string; attachmentKey: string } | undefined;
    let busy = false;
    const authGet = new Set(['/auth/login', '/auth/callback', '/auth/session', '/auth/drive/connect', '/auth/drive/callback']);
    // Narrow existing buildApp routes to the validation surface. No disconnect,
    // record editing, arbitrary input, deletion, raw files, or production paths.
    app.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (req.headers.host !== new URL(cfg.publicBaseUrl).host) return reply.code(403).send({ error: 'HOST_REJECTED' });
      const p = req.url.split('?')[0]!;
      if (req.method === 'GET' && (p === '/healthz' || authGet.has(p))) return;
      if (p.startsWith('/auth')) return reply.code(404).send({ error: 'NOT_FOUND' });
      const sub = owner(req); // buildApp's authentication hook already ran
      if (boundOwner && boundOwner !== sub) return reply.code(403).send({ error: 'OWNER_REJECTED' });
      const allowed = (req.method === 'GET' && (p === '/' || (synthetic && p === `/api/backup/records/${synthetic.id}/readiness`)))
        || (req.method === 'POST' && (p === '/api/validation/synthetic' || p === '/api/validation/tick'
          || (synthetic && p === `/api/backup/records/${synthetic.id}/run`)));
      if (!allowed) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (req.method === 'POST' && (req.headers.origin !== cfg.publicBaseUrl || req.headers['x-validation-action'] !== '1'
        || req.headers['content-type'] !== 'application/json')) return reply.code(403).send({ error: 'SAME_ORIGIN_ACTION_REQUIRED' });
    });
    app.get('/', async () => ({ mode: o.mode.slice(2), syntheticId: synthetic?.id ?? null,
      steps: ['POST /api/validation/synthetic', 'POST /api/backup/records/:id/run', 'POST /api/validation/tick', 'GET /api/backup/records/:id/readiness?live=1'],
      actualGoogleDrive: 'NOT_RUN', deletionEnabled: false }));
    app.post('/api/validation/synthetic', async (req, reply) => {
      if (busy) return reply.code(409).send({ error: 'BUSY' });
      if (synthetic) return synthetic;
      busy = true;
      boundOwner = owner(req);
      try {
        const now = new Date();
        const { interview } = await store.startInterview(boundOwner, now);
        await store.saveItem(boundOwner, interview.id, 'synthetic-q', 'QUESTION', '합성 질문', now);
        await store.saveItem(boundOwner, interview.id, 'synthetic-a', 'ANSWER', '검증 전용 합성 답변', now);
        const a = await new AttachmentService(store, dir).upload({ ownerId: boundOwner, interviewId: interview.id,
          key: 'synthetic-attachment', kind: 'MARKDOWN', name: 'synthetic.md', bytes: Buffer.from('# TASK103 합성 첨부\n개인 기록 없음'), now });
        await store.appendVersion(boundOwner, interview.id, 'SUMMARY', { diary: '합성 요약', learning: [] }, now);
        await mkdir(path.join(dir, 'videos'), { recursive: true });
        await copyFile(sourceVideo, path.join(dir, 'videos/synthetic.mp4'), 1); // COPYFILE_EXCL
        await store.appendVersion(boundOwner, interview.id, 'RESULT', { file: 'synthetic.mp4' }, now);
        await store.saveAudioSegment(boundOwner, interview.id, 'synthetic-audio-excluded', now);
        await store.confirm(boundOwner, interview.id, now);
        synthetic = { id: interview.id, attachmentKey: a.storageKey };
        return reply.code(201).send(synthetic);
      } finally { busy = false; }
    });
    app.post('/api/validation/tick', async (_req, reply) => {
      if (!synthetic) return reply.code(409).send({ error: 'SYNTHETIC_REQUIRED' });
      if (busy) return reply.code(409).send({ error: 'BUSY' });
      busy = true;
      try {
        let processed = 0;
        for (; processed < 20; processed++) if (!await queue.tick()) break;
        return { processed, limit: 20, scheduled: false };
      } finally { busy = false; }
    });
    const base = await app.listen({ host: '127.0.0.1', port: o.port ?? 3000 });
    cfg.publicBaseUrl = base; // ephemeral fake test port; real mode remains 3000
    return { app, base, schema, dir, pool, fakeDrive, issuer, network: network.counts, close };
  } catch {
    await close();
    throw new Error('VALIDATION_START_FAILED');
  }
}
