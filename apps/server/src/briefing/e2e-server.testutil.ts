// 브라우저 E2E 전용(TASK-20): 대화가 끝난 기록 + 모의 Pro + 메모리 저장소 + 가짜 로그인. 키·DB·네트워크·유료 호출 없음. tsx 로 실행.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { registerInterview } from '../interview/routes.js';
import { MemoryLiveUsageStore } from '../interview/usage.js';
import { B_ID, B_OWNER, MemBriefingRecords } from './memory.testutil.js';
import { registerBriefing } from './routes.js';
import type { ProInfer } from './briefing.js';

const distDir = path.resolve(import.meta.dirname, '../../../web/dist');
const MODEL_OUT = JSON.stringify([
  { kind: 'FACT', source: 'USER', text: '에코 버그를 고쳤다', emphasis: true },
  { kind: 'OPINION', source: 'USER', text: '뿌듯했다' },
  { kind: 'UNCERTAIN', source: 'USER', text: '원인은 캐시 같기도 하다' },
  { kind: 'FACT', source: 'USER', text: 'SQL 인젝션 예방 방법을 공부했다' },
  { kind: 'FACT', source: 'USER', text: '여당 대표 발언 때문에 짜증났다' },
]);
let proCalls = 0;
const infer: ProInfer = async () => { proCalls++; return { state: 'SUCCEEDED', text: MODEL_OUT }; };

const records = new MemBriefingRecords();
records.items = [
  { id: 'q1', seq: 1, kind: 'QUESTION', body: '오늘 뭐 했어요?' }, { id: 'a1', seq: 2, kind: 'ANSWER', body: '에코 버그를 고쳤어요' },
  { id: 'q2', seq: 3, kind: 'QUESTION', body: '어땠어요?' }, { id: 'a2', seq: 4, kind: 'ANSWER', body: '뿌듯했어요' },
];
const usage = new MemoryLiveUsageStore();
await usage.open(B_OWNER, B_ID, new Date());
await usage.add(B_OWNER, B_ID, 300_000, 100, process.env.BR_E2E_SCENARIO === 'running' ? null : 'USER_END', new Date());

const app = Fastify({ logger: false });
const user: SessionClaims = { sub: B_OWNER, email: 'me@example.test', name: '시험', iat: 0, exp: 9e9 };
const authed = (req: { headers: { cookie?: string } }) => (req.headers.cookie ?? '').includes('e2e=1');
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/e2e/') || !req.url.startsWith('/api/')) return;
  if (!authed(req)) return reply.code(401).send({ error: 'unauthenticated' });
  (req as unknown as { user: SessionClaims }).user = user;
});
app.get('/auth/session', async (req, reply) => (authed(req) ? { email: user.email, name: user.name, driveConnected: true } : reply.code(401).send({ error: 'unauthenticated' })));
app.get('/e2e/login', async (_req, reply) => reply.header('set-cookie', 'e2e=1; Path=/').redirect('/'));
app.post('/api/records', async () => ({ id: B_ID, lifeDate: '2026-10-25', status: 'IN_PROGRESS', resumed: true }));
app.get('/api/records', async () => ({ records: [], nextCursor: null }));
registerInterview(app, { records, usage, live: null, sessionDir: mkdtempSync(path.join(os.tmpdir(), 'dl-br-e2e-')), authenticate: (req) => (authed(req) ? { user } : { status: 401, code: 'unauthenticated' }) });
registerBriefing(app, { records, usage, infer });
app.get('/e2e/state', async () => ({ proCalls, jobs: records.jobs, status: records.status, production: records.production, versions: records.versions }));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
app.get('/*', async (req, reply) => {
  const rel = decodeURIComponent(req.url.split('?')[0] ?? '/').replace(/^\/+/, '');
  const f = path.join(distDir, rel);
  const file = rel && f.startsWith(distDir) && existsSync(f) ? f : path.join(distDir, 'index.html');
  return reply.header('content-type', MIME[path.extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
});
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
console.log('E2E_READY');
