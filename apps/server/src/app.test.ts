import { expect, it } from 'vitest';
import { buildApp } from './app.js';

it('GET /healthz', async () => {
  const app = buildApp();
  const res = await app.inject('/healthz');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
