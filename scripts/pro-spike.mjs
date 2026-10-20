// Offline evidence runner. Never reads credentials or executes model requests.
import { spawnSync } from 'node:child_process';
import { runProRequest } from '../apps/server/dist/spikes/pro-request.js';

// Accept a literal executable + argument vector (e.g. node /opt/codex/bin/codex.js).
// Do not use a shell or silently try another executable.
const [executable = 'codex', ...prefixArgs] = process.argv.slice(2);
const cli = spawnSync(executable, [...prefixArgs, '--help'], { timeout: 5000, stdio: 'ignore' });
const input = { kind: 'text', text: '합성 기록: 오늘 책을 10분 읽었다.' };
const ready = { support: 'verified', auth: 'valid', quota: 'available' };
const rows = [];
for (const [name, context, reply] of [
  ['unverified-support', {}, { ok: true }],
  ['known-limit', { ...ready, quota: 'exhausted' }, { ok: true }],
  ['known-auth-expired', { ...ready, auth: 'expired' }, { ok: true }],
  ['response-limit', ready, { ok: false, status: 429, code: 'subscription_sharing_usage_limit_exceeded' }],
  ['response-auth', ready, { ok: false, status: 401 }],
  ['response-input', ready, { ok: false, status: 400, code: 'subscription_sharing_unsupported_capability' }],
  ['response-unavailable', ready, { ok: false, status: 503 }],
  ['response-lost', ready, null],
  ['completed', ready, { ok: true }],
]) {
  const calls = [];
  const result = await runProRequest(input, context, async () => {
    calls.push('controlled-subscription-adapter');
    if (!reply) throw new Error('synthetic lost response');
    return reply;
  });
  rows.push({ name, provenance: 'CONTROLLED', ...result, calls });
}
console.log(JSON.stringify({
  observedAt: new Date().toISOString(),
  cliHelp: { available: cli.status === 0, exitCode: cli.status, error: cli.error?.code ?? null },
  liveAccount: { result: 'NOT_RUN', reason: cli.error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'VERIFIED_PRODUCT_AUTH_NOT_AVAILABLE' },
  liveCases: ['text-question', 'record-summary', 'allowed-attachment'].map(name => ({ name, result: 'NOT_RUN' })),
  externalInferenceCalls: 0,
  rows,
}, null, 2));
