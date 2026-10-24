import Fastify, { type FastifyServerOptions } from 'fastify';
import { BudgetLedger, SessionStore } from './meter.js';
import { MAX_AUDIO_BYTES, VoiceService } from './pipeline.js';
import { loadPricing, type Pricing } from './pricing.js';
import type { Transports } from './transports.js';
import { VOICE_PAGE } from './page.js';

export interface VoiceAppOptions {
  transports: Transports;
  sessionDir: string;
  budgetKrw?: number;
  pricing?: Pricing;
  logger?: FastifyServerOptions['logger'];
  now?: () => number;
}

export const DEFAULT_BUDGET_KRW = 1000;

export function buildVoiceApp(opts: VoiceAppOptions) {
  const app = Fastify({
    logger: opts.logger ?? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-goog-api-key"]'] },
    bodyLimit: MAX_AUDIO_BYTES + 1024,
  });
  const sessions = new SessionStore(opts.sessionDir);
  const ledger = new BudgetLedger(opts.budgetKrw ?? DEFAULT_BUDGET_KRW);
  const service = new VoiceService({ t: opts.transports, pricing: opts.pricing ?? loadPricing(), ledger, sessions, now: opts.now });

  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // 오류 응답에는 내부 메시지를 담지 않는다.
  app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    void reply.status(status).send({ code: status === 413 ? 'AUDIO_TOO_LARGE' : status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: '요청을 처리하지 못했습니다.' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/voice-test', async (_req, reply) =>
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store')
      .header('Permissions-Policy', 'microphone=(self)').send(VOICE_PAGE));

  app.post('/voice/api/sessions', async (_req, reply) => {
    const s = sessions.create(ledger.limitKrw, new Date());
    return reply.status(201).send({ id: s.id, budgetKrw: s.budgetKrw });
  });

  app.get<{ Params: { id: string } }>('/voice/api/sessions/:id', async (req, reply) => {
    const s = sessions.get(req.params.id);
    return s ? s : reply.status(404).send({ code: 'SESSION_NOT_FOUND' });
  });

  app.post<{ Params: { id: string }; Body: Buffer }>('/voice/api/sessions/:id/turns', async (req, reply) => {
    const raw = req.headers['x-audio-duration-ms'];
    const dur = typeof raw === 'string' && /^\d{1,7}$/.test(raw) ? Number(raw) : undefined;
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await service.turn(req.params.id, audio, String(req.headers['content-type'] ?? ''), dur);
    if (!r.ok) return reply.status(r.status).send({ code: r.code, message: r.message });
    return { turn: r.turn, audio: { mime: r.audio.mime, base64: r.audio.data.toString('base64') } };
  });

  app.post<{ Params: { id: string } }>('/voice/api/sessions/:id/end', async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) return reply.status(404).send({ code: 'SESSION_NOT_FOUND' });
    s.endedAt ??= new Date().toISOString();
    sessions.save(s);
    return s;
  });

  app.post<{ Params: { id: string }; Body: { naturalness?: unknown; unsupported?: unknown; note?: unknown } }>(
    '/voice/api/sessions/:id/feedback', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.status(404).send({ code: 'SESSION_NOT_FOUND' });
      const b = req.body ?? {};
      const n = b.naturalness;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5) return reply.status(400).send({ code: 'BAD_RATING', message: '자연스러움은 1~5 정수입니다.' });
      const allowed = ['INTERRUPT', 'OVERLAP', 'OTHER'];
      const unsupported = Array.isArray(b.unsupported) ? b.unsupported.filter((x): x is string => typeof x === 'string' && allowed.includes(x)) : [];
      s.feedback = { naturalness: n, unsupported, note: typeof b.note === 'string' ? b.note.slice(0, 500) : '', at: new Date().toISOString() };
      sessions.save(s);
      return { ok: true };
    });

  return app;
}
