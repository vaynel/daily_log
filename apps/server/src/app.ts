import Fastify from 'fastify';
import { registerAuth, type EntryStore } from './auth/plugin.js';
import type { AuthConfig } from './auth/config.js';
import { AttachmentService } from './attachments/service.js';
import { registerRecordRoutes } from './attachments/routes.js';
import { registerRecordViewRoutes } from './records/routes.js';
import type { RecordStore } from './records/store.js';
import { registerInterview } from './interview/routes.js';
import type { LiveUsageStore } from './interview/usage.js';
import type { LiveConfig } from './voice/live.js';
import type { MonthlyLedger } from './budget/ledger.js';
import { registerNotifyRoutes } from './notify/routes.js';
import type { NotificationService } from './notify/service.js';

export interface AppOptions {
  auth?: AuthConfig | null;
  sessionSecret?: string;
  fileStorageDir?: string;
  entries?: EntryStore;
  fetchImpl?: typeof fetch;
  records?: RecordStore;
  now?: () => Date;
  /** 제품 음성 인터뷰(Gemini Live). usage 와 records 가 있으면 라우트를 등록하고, live 가 null 이면 대화 시작은 fail closed. */
  interview?: { usage: LiveUsageStore; live: LiveConfig | null; monthly?: MonthlyLedger; sessionDir: string; liveNow?: () => number };
  notifications?: NotificationService;
  vapidPublicKey?: string | null;
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  app.get('/healthz', async () => ({ status: 'ok' }));
  const { authenticate } = registerAuth(app, {
    auth: opts.auth ?? null,
    sessionSecret: opts.sessionSecret ?? '',
    fileStorageDir: opts.fileStorageDir ?? '',
    entries: opts.entries ?? { list: async () => [] },
    fetchImpl: opts.fetchImpl,
  });
  if (opts.records) {
    registerRecordRoutes(app, { store: opts.records, attachments: new AttachmentService(opts.records, opts.fileStorageDir ?? ''), now: opts.now });
    registerRecordViewRoutes(app, { store: opts.records, fileStorageDir: opts.fileStorageDir ?? '', now: opts.now });
  }
  if (opts.records && opts.interview) {
    registerInterview(app, { records: opts.records, authenticate, now: opts.now, ...opts.interview });
  }
  if (opts.notifications) registerNotifyRoutes(app, { service: opts.notifications, vapidPublicKey: opts.vapidPublicKey });
  return app;
}
