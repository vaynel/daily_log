// Independent TASK-54 contract probe. Synthetic credentials; loopback only.
// Exit 1 means the required explicit permission-recovery route is absent.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from './auth.mjs';
import { startCompanion } from './companion.mjs';

const dir = await mkdtemp(resolve('data/qa54-reconsent-'));
const store = new Store(dir);
await store.init();
await store.save({
  version: 1, client_id: 'oaiapp_qa54', subject: 'synthetic-qa54',
  scopes: ['openid', 'resource.invoke'], state: 'WAIT_PERMISSION',
});
let externalCalls = 0;
const app = await startCompanion(store, {
  allowLogin: true,
  transport: async () => { externalCalls++; throw Error('EXTERNAL_CALL_FORBIDDEN'); },
});
try {
  const base = new URL(app.url).origin;
  const html = await (await fetch(app.url)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const response = await fetch(`${base}/start`, {
    method: 'POST', headers: { Origin: base },
    body: new URLSearchParams({ csrf }), redirect: 'manual',
  });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('location'));
  assert.equal(target.searchParams.get('client_id'), 'oaiapp_qa54');
  assert(target.searchParams.get('scope').split(' ').includes('chatgpt.tokens.use.direct'));
  assert.equal(externalCalls, 0);
  const explicitConsent = target.searchParams.get('prompt')?.split(' ').includes('consent') === true;
  console.log(JSON.stringify({
    sourceState: 'WAIT_PERMISSION', issuedClientPreserved: true,
    directScopeRequested: true, explicitConsent, externalCalls,
    result: explicitConsent ? 'PASS' : 'FAIL',
  }));
  // force_reconsent requires provider rollout confirmation; this preparation
  // has no such confirmation. The documented supported mechanism is prompt.
  if (!explicitConsent) process.exitCode = 1;
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
