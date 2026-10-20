import Fastify from 'fastify';
import { registerPushRoutes, type PushRuntime } from './push/routes.js';

export interface AppOptions {
  push?: PushRuntime | null;
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  app.get('/healthz', async () => ({ status: 'ok' }));
  registerPushRoutes(app, opts.push ?? null);
  return app;
}
