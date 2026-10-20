import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { OBSERVATION_STEPS, PushError, type PushService, validateSubscription } from './service.js';

const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 60_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const sha = (v: string) => createHash('sha256').update(v).digest();

export interface PushRuntime {
  service: PushService;
  accessToken: string;
  staticDir: string | null;
}

export function registerPushRoutes(app: FastifyInstance, rt: PushRuntime | null, now: () => number = Date.now): void {
  // 인증 실패 속도제한: 1분에 10회 초과 시 올바른 토큰도 잠시 거부(단일 사용자 비공개 서비스).
  let failures: number[] = [];
  const tokenHash = rt ? sha(rt.accessToken) : null;

  const deny = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/push/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!rt || !tokenHash) return deny(reply, 503, 'push_disabled');
    failures = failures.filter((t) => now() - t < FAIL_WINDOW_MS);
    if (failures.length >= FAIL_LIMIT) return deny(reply, 429, 'too_many_failures');
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(sha(m[1]!), tokenHash)) {
      failures.push(now());
      return deny(reply, 401, 'unauthorized');
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof PushError) return reply.code(err.status).send({ error: err.code });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    // 메시지에 요청 본문(구독 정보)이 섞일 수 있어 내용은 돌려주지 않는다.
    return reply.code(status).send({ error: status === 500 ? 'internal_error' : 'bad_request' });
  });

  const small = { bodyLimit: 8192 };
  const svc = () => rt!.service;

  app.get('/api/push/status', async () => svc().status());
  app.get('/api/push/vapid-public-key', async () => ({ publicKey: svc().publicKey }));

  app.put('/api/push/subscription', small, async (req) => {
    await svc().saveSubscription(validateSubscription(req.body, svc().config()));
    return { ok: true };
  });
  app.delete('/api/push/subscription', async () => {
    await svc().removeSubscription();
    return { ok: true };
  });

  app.post('/api/push/test', small, async (req) => {
    const id = (req.body as { requestId?: unknown } | null)?.requestId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new PushError(400, 'invalid_request_id');
    const { record, duplicate } = await svc().sendTest(id);
    return { duplicate, status: record.status, key: record.key, confirmedDelivered: false };
  });

  app.post('/api/push/displayed', small, async (req) => {
    const key = (req.body as { key?: unknown } | null)?.key;
    if (typeof key !== 'string' || !/^test:[A-Za-z0-9-]{8,64}$/.test(key)) throw new PushError(400, 'invalid_key');
    const r = await svc().confirmDisplayed(key);
    return { status: r.status };
  });

  app.put('/api/push/device', small, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' && v.length <= 60 ? v.trim() : null);
    const android = text(b.android);
    const chrome = text(b.chrome);
    const model = text(b.model);
    if (android === null || chrome === null || model === null) throw new PushError(400, 'invalid_device');
    await svc().saveDevice({ android, chrome, model });
    return { ok: true };
  });

  app.put('/api/push/observations', small, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.step !== 'string' || !(OBSERVATION_STEPS as readonly string[]).includes(b.step)) throw new PushError(400, 'invalid_step');
    if (b.result !== 'OK' && b.result !== 'FAIL' && b.result !== 'NOT_APPLICABLE') throw new PushError(400, 'invalid_result');
    const note = typeof b.note === 'string' ? b.note : '';
    if (note.length > 500) throw new PushError(400, 'note_too_long');
    return svc().saveObservation({ step: b.step, result: b.result, note });
  });

  // 시험 화면(비밀값 없는 정적 파일). 상태·기록은 위 인증 API로만 접근한다.
  if (rt?.staticDir) {
    const root = normalize(rt.staticDir);
    app.get('/*', async (req, reply) => {
      const raw = decodeURIComponent((req.params as { '*': string })['*'] || 'push-test.html');
      const full = normalize(join(root, raw));
      if (!full.startsWith(root + sep) || raw.includes('\0')) return reply.code(404).send({ error: 'not_found' });
      try {
        const data = await readFile(full);
        return reply
          .header('Content-Type', MIME[extname(full)] ?? 'application/octet-stream')
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
          .send(data);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    });
  }
}
