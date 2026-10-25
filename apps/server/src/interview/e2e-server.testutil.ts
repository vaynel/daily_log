// 브라우저 E2E 전용: 제품 인터뷰 화면 + 모의 Live + 메모리 기록 + 가짜 로그인. 키·DB·네트워크 없음. tsx 로 실행.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { loadLiveConfig } from '../voice/live.js';
import { startMockLive } from '../voice/live-mock.testutil.js';
import { MemRecords, TEST_INTERVIEW, TEST_OWNER } from './memory.testutil.js';
import { registerInterview } from './routes.js';
import { MemoryLiveUsageStore } from './usage.js';

const KEY = 'e2e-sentinel-key-not-real-0002';
const scenario = process.env.IV_E2E_SCENARIO ?? 'normal';
const distDir = path.resolve(import.meta.dirname, '../../../web/dist');
const mock = await startMockLive({ expectedKey: KEY, vadSilenceMs: 250, firstAudioDelayMs: 60, audioChunks: 4, dropAfterTurns: scenario === 'drop' ? 1 : undefined });
const records = new MemRecords();
const usage = new MemoryLiveUsageStore();
if (scenario === 'expired') {
  records.items.push({ id: 'i1', seq: 1, kind: 'ANSWER', body: '어제 이어 쓰던 테스트 이야기', key: 's1' }, { id: 'i2', seq: 2, kind: 'QUESTION', body: '어떤 부분이 가장 어려웠나요?', key: 's2' });
  records.audio = [{ id: 'au1', firstSavedAt: new Date('2026-09-01'), expiresAt: new Date('2026-10-01'), status: 'EXPIRED', recovered: false }];
  records.backup = 'PENDING';
}
const app = Fastify({ logger: false });
const user: SessionClaims = { sub: TEST_OWNER, email: 'me@example.test', name: '시험', iat: 0, exp: 9e9 };
const authenticate = (req: { headers: { cookie?: string } }) => ((req.headers.cookie ?? '').includes('e2e=1') ? { user } : { status: 401 as const, code: 'unauthenticated' as const });
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/e2e/') || !req.url.startsWith('/api/')) return;
  const r = authenticate(req);
  if ('status' in r) return reply.code(401).send({ error: r.code });
  (req as unknown as { user: SessionClaims }).user = r.user;
});
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
app.get('/auth/session', async (req, reply) => ('status' in authenticate(req) ? reply.code(401).send({ error: 'unauthenticated' }) : { email: user.email, name: user.name, driveConnected: true }));
app.get('/e2e/login', async (_req, reply) => reply.header('set-cookie', 'e2e=1; Path=/').redirect('/'));
app.post('/api/records', async () => ({ id: TEST_INTERVIEW, lifeDate: '2026-10-25', status: 'IN_PROGRESS', resumed: records.items.length > 0 }));
app.get('/api/records', async () => ({ records: [], nextCursor: null }));
app.post('/api/records/:id/attachments', async (req, reply) => {
  records.attachments.push({ id: `a${records.attachments.length + 1}`, itemId: null, storageKey: 'k', checksum: 'c', name: decodeURIComponent(String(req.headers['x-file-name'] ?? '')) });
  return reply.code(201).send({ id: 'new', duplicate: false, kind: req.headers['x-attachment-kind'], size: 1, storageKey: 'k', capturedAt: null, capturedSource: null });
});
registerInterview(app, {
  records, usage, live: scenario === 'disabled' ? null : loadLiveConfig(KEY, { DAILY_LOG_VOICE_LIVE_URL: mock.url, DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS: '3000', DAILY_LOG_VOICE_LIVE_COMPRESSION_TARGET_TOKENS: '1500' }),
  sessionDir: mkdtempSync(path.join(os.tmpdir(), 'dl-iv-e2e-')), authenticate,
  limits: process.env.IV_E2E_MAXMS ? { maxMs: Number(process.env.IV_E2E_MAXMS), wrapMs: Number(process.env.IV_E2E_WRAPMS), maxCostKrw: 700, wrapCostKrw: 560 } : undefined,
});
app.get('/e2e/state', async () => ({ mock: mock.state, items: records.items, attachments: records.attachments, usage: await usage.get(TEST_OWNER, TEST_INTERVIEW) }));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
app.get('/*', async (req, reply) => {
  const rel = decodeURIComponent(req.url.split('?')[0] ?? '/').replace(/^\/+/, '');
  const f = path.join(distDir, rel);
  const file = rel && f.startsWith(distDir) && existsSync(f) ? f : path.join(distDir, 'index.html');
  return reply.header('content-type', MIME[path.extname(file)] ?? 'application/octet-stream').header('permissions-policy', 'microphone=(self)').send(readFileSync(file));
});
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
console.log('E2E_READY');
