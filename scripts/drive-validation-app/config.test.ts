import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('default and incomplete real entrypoint fail closed without values or network', () => {
  for (const args of [[], ['--real']]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/drive-validation-app/main.ts', ...args], {
      input: JSON.stringify({ clientSecret: 'never-emit-this-sentinel' }),
      env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, '');
    const status = JSON.parse(r.stdout);
    assert.equal(status.actualGoogleDrive, 'NOT_RUN');
    assert.equal(status.result, 'NOT_READY');
    assert.ok(status.missing.includes('TEST_DATABASE_URL'));
    assert.doesNotMatch(r.stdout, /never-emit-this-sentinel/);
  }
});

import { guardedFetch, readiness, testDatabaseAllowed } from './config.js';

test('test DB identity and clean URL are mandatory; flags cannot bless production', () => {
  const base = 'postgresql://synthetic:ci-only@daily-log-test-postgres17:5432/daily_log_backend_test';
  assert.equal(testDatabaseAllowed(base), true);
  for (const bad of [undefined, 'invalid', base.replace('daily-log-test-postgres17', 'prod'),
    base.replace('daily_log_backend_test', 'daily_log'), base + '?options=-csearch_path=public',
    base + '?host=prod', base + '#public', base.replace(':5432', ':5433')]) {
    assert.equal(testDatabaseAllowed(bad), false);
    assert.ok(readiness('--fake', bad).missing.includes('TEST_DATABASE_URL'));
  }
  assert.equal(readiness(undefined, base).result, 'NOT_READY');
  assert.equal(readiness('--real', base, { enableReal: true }).result, 'NOT_READY');
});

test('real configuration validates single owner, keys, loopback and access without contacting Google', () => {
  const db = 'postgresql://synthetic:ci-only@daily-log-test-postgres17:5432/daily_log_backend_test';
  const good = { enableReal: true, clientId: 'synthetic-client', clientSecret: 'synthetic-secret', allowedEmail: 'owner@example.test',
    sessionSecret: 's'.repeat(32), tokenKey: 't'.repeat(32), publicBaseUrl: 'http://127.0.0.1:3000', approvedLoopbackAccess: true };
  assert.equal(readiness('--real', db, good).result, 'CONFIG_READY');
  for (const patch of [{ publicBaseUrl: 'http://0.0.0.0:3000' }, { approvedLoopbackAccess: false },
    { enableReal: false }, { allowedEmail: 'one@test,two@test' }, { sessionSecret: 'short' }, { tokenKey: 'short' }]) {
    assert.equal(readiness('--real', db, { ...good, ...patch }).result, 'NOT_READY');
  }
});

test('network gate denies Google in fake mode, destructive methods and redirect escape', async () => {
  let calls = 0;
  const gate = guardedFetch(new Set(['http://127.0.0.1:12345']), async (_input, init) => {
    calls++; assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://accounts.google.com' } });
  });
  for (const target of ['https://accounts.google.com', 'http://127.0.0.1:12346', 'http://user:secret@127.0.0.1:12345']) {
    await assert.rejects(gate.request(target), /NETWORK_TARGET_BLOCKED/);
  }
  for (const method of ['DELETE', 'PATCH']) await assert.rejects(gate.request('http://127.0.0.1:12345', { method }), /NETWORK_TARGET_BLOCKED/);
  assert.equal(calls, 0);
  assert.equal((await gate.request('http://127.0.0.1:12345')).status, 302);
  assert.equal(calls, 1);
  assert.equal(gate.counts.external, 0);
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('foreground CLI logs no callback query/cookie, refuses delete and stops cleanly', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/drive-validation-app/main.ts', '--fake'], {
    env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const exited = once(child, 'exit');
  try {
    const started = await Promise.race([
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('START_TIMEOUT')), 10000);
        child.stdout.on('data', () => { if (out.includes('\n')) { clearTimeout(timer); resolve(); } });
      }),
      exited.then(() => { throw new Error('START_FAILED'); }),
    ]);
    void started;
    const info = JSON.parse(out.trim());
    assert.equal(info.result, 'LISTENING');
    assert.equal(info.browserUrl, 'http://127.0.0.1:3000/auth/login');
    const sentinel = 'private-query-cookie-sentinel';
    const r = await fetch('http://127.0.0.1:3000/auth/callback?code=' + sentinel + '&state=' + sentinel, {
      headers: { cookie: 'dl_flow=' + sentinel }, redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    assert.equal(r.status, 302);
    assert.equal((await fetch('http://127.0.0.1:3000/auth/drive/disconnect', { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 404);
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(err, '');
    assert.equal(out.trim().split('\n').length, 1);
    assert.equal(out.includes(sentinel), false);
  } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } }
});
