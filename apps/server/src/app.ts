import Fastify from 'fastify';
import { registerAuth, type EntryStore } from './auth/plugin.js';
import type { AuthConfig } from './auth/config.js';

export interface AppOptions {
  auth?: AuthConfig | null;
  sessionSecret?: string;
  fileStorageDir?: string;
  entries?: EntryStore;
  fetchImpl?: typeof fetch;
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
  return app;
}
