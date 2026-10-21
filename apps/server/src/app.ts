import Fastify from 'fastify';
import { registerAuth, type EntryStore } from './auth/plugin.js';
import type { AuthConfig } from './auth/config.js';
import { AttachmentService } from './attachments/service.js';
import { registerRecordRoutes } from './attachments/routes.js';
import type { RecordStore } from './records/store.js';

export interface AppOptions {
  auth?: AuthConfig | null;
  sessionSecret?: string;
  fileStorageDir?: string;
  entries?: EntryStore;
  fetchImpl?: typeof fetch;
  records?: RecordStore;
  now?: () => Date;
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  app.get('/healthz', async () => ({ status: 'ok' }));
  registerAuth(app, {
    auth: opts.auth ?? null,
    sessionSecret: opts.sessionSecret ?? '',
    fileStorageDir: opts.fileStorageDir ?? '',
    entries: opts.entries ?? { list: async () => [] },
    fetchImpl: opts.fetchImpl,
  });
  if (opts.records) {
    registerRecordRoutes(app, { store: opts.records, attachments: new AttachmentService(opts.records, opts.fileStorageDir ?? ''), now: opts.now });
  }
  return app;
}
