import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startValidationApp, sourceVideo } from './app.js';
import { buildBackupPlan } from '../../apps/server/src/backup/plan.js';
import { DRIVE_SCOPE, LOGIN_SCOPE } from '../../apps/server/src/auth/config.js';

const emit = (check: string, evidence: object) => console.log(JSON.stringify({ check, ...evidence }));
const hash = (b: Buffer, alg = 'sha256') => createHash(alg).update(b).digest('hex');
let stage = 'startup';
async function verify() {
  if (process.argv.slice(2).join(' ') !== '--fake') throw new Error('FAKE_REQUIRED');
  const runtime = await startValidationApp({ mode: '--fake', databaseUrl: process.env.DATABASE_URL ?? '', port: 0 });
  const { base, pool, fakeDrive: drive, issuer } = runtime;
  const original = await readFile(sourceVideo);
  const allowed = new Set([base, issuer!.issuer]);
  let cookie = '';
  const clientFetch = async (url: string, init?: RequestInit) => {
    assert.ok(allowed.has(new URL(url).origin), 'test client must never contact Google');
    return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  };
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find(x => x.startsWith(`${name}=`))?.split(';')[0] ?? '';
  const request = (route: string, method = 'GET', useCookie = true, extra: Record<string, string> = {}) => clientFetch(base + route, {
    method, headers: { ...(useCookie ? { cookie } : {}), ...(method === 'POST' ? { origin: base, 'x-validation-action': '1', 'content-type': 'application/json' } : {}), ...extra },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  async function oauth(route: string, scope: string) {
    const start = await request(route);
    assert.equal(start.status, 302);
    const target = start.headers.get('location')!;
    assert.equal(new URL(target).searchParams.get('scope'), scope);
    const authz = await clientFetch(target);
    const callback = new URL(authz.headers.get('location')!);
    assert.equal(callback.origin, base);
    const done = await clientFetch(callback.href, { headers: { cookie: [cookie, cookieOf(start, 'dl_flow')].filter(Boolean).join('; ') } });
    assert.equal(done.status, 302);
    cookie = cookieOf(done, 'dl_session') || cookie;
    return done;
  }
  try {
    stage = 'loopback-and-unauthenticated';
    assert.equal((runtime.app.server.address() as AddressInfo).address, '127.0.0.1');
    for (const p of ['/api/validation/synthetic', '/api/validation/tick', '/api/backup/records/00000000-0000-0000-0000-000000000000/run']) {
      assert.equal((await request(p, 'POST', false)).status, 401);
    }
    assert.equal((await request('/auth/drive/connect', 'GET', false)).status, 401);
    stage = 'login-and-separate-consent';
    await oauth('/auth/login', LOGIN_SCOPE);
    assert.equal((await (await request('/auth/session')).json()).driveConnected, false);
    issuer!.state.denyDrive = true;
    assert.equal((await oauth('/auth/drive/connect', DRIVE_SCOPE)).headers.get('location'), '/?drive=denied');
    assert.equal((await (await request('/auth/session')).json()).driveConnected, false);
    issuer!.state.denyDrive = false;
    await oauth('/auth/drive/connect', DRIVE_SCOPE);
    assert.equal((await (await request('/auth/session')).json()).driveState, 'CONNECTED');
    emit('httpOAuth', { result: 'PASS', separateConsent: true, deniedConsentStaysDisconnected: true, unauthenticated: 401, loopback: true });

    stage = 'surface-csrf-and-owner';
    assert.equal((await request('/api/validation/synthetic', 'POST', true, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/validation/synthetic', 'POST', true, { 'x-validation-action': '' })).status, 403);
    stage = 'host-rejection';
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.get(base + '/healthz', { headers: { host: 'evil.example' }, timeout: 5000 }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP_TIMEOUT')));
    });
    assert.equal(wrongHost, 403);
    for (const [route, method] of [['/api/records', 'GET'], ['/api/interviews', 'POST'], ['/auth/drive/disconnect', 'POST'], ['/api/videos/synthetic.mp4', 'GET']]) {
      stage = 'blocked-route-' + route;
      assert.equal((await request(route!, method)).status, 404);
    }
    stage = 'synthetic-http';
    const created = await request('/api/validation/synthetic', 'POST');
    assert.equal(created.status, 201);
    const { id, attachmentKey } = await created.json() as { id: string; attachmentKey: string };
    assert.equal((await (await request('/api/validation/synthetic', 'POST')).json()).id, id);
    const ownCookie = cookie;
    issuer!.state.account = { sub: 'other-sub', email: 'owner@example.test', email_verified: true };
    cookie = '';
    await oauth('/auth/login', LOGIN_SCOPE);
    assert.equal((await request('/api/validation/tick', 'POST')).status, 403);
    assert.equal((await request(`/api/backup/records/${id}/run`, 'POST')).status, 403);
    cookie = ownCookie;
    assert.equal((await request('/api/backup/records/00000000-0000-0000-0000-000000000000/run', 'POST')).status, 404);
    assert.equal((await request(`/api/backup/records/${id}/run`, 'DELETE')).status, 404);
    emit('restrictedSurface', { result: 'PASS', csrfAndHostRejected: true, differentSubjectRejected: true, arbitraryRecordRejected: true, disconnectAndDeleteUnavailable: true });

    stage = 'backup-http';
    const route = `/api/backup/records/${id}`;
    const readiness = async (live = true) => {
      const res = await request(`${route}/readiness${live ? '?live=1' : ''}`);
      assert.equal(res.status, 200); return res.json();
    };
    assert.equal((await readiness()).ready, false);
    const run = await request(`${route}/run`, 'POST');
    assert.equal(run.status, 202); assert.equal((await run.json()).queued, true);
    assert.equal(drive!.uploaded().length, 0, 'queue must not run automatically');
    const tick = await (await request('/api/validation/tick', 'POST')).json();
    assert.ok(tick.processed > 0 && tick.processed <= 20); assert.equal(tick.scheduled, false);
    const plan = (await buildBackupPlan(pool, runtime.dir, id))!;
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.items.map(x => x.kind).sort(), ['ATTACHMENT', 'RECORD', 'VIDEO']);
    const rows = (await pool.query('SELECT * FROM backup_items WHERE interview_id=$1', [id])).rows;
    assert.equal(rows.length, 3); assert.equal(drive!.uploaded().length, 3);
    for (const item of plan.items) {
      const file = drive!.uploaded().find(f => f.appProperties.dlKind === item.kind)!;
      const bytes = 'bytes' in item.source ? item.source.bytes : await readFile(item.source.file);
      assert.deepEqual(file.bytes, bytes);
      const row = rows.find(r => r.item_kind === item.kind)!;
      assert.equal(row.status, 'VERIFIED'); assert.equal(row.version_label, item.label);
      assert.equal(file.appProperties.dlVersion, item.label);
      assert.equal(Number(row.size_bytes), bytes.length);
      assert.equal(row.content_sha256, hash(bytes)); assert.equal(item.sha256, hash(bytes));
      assert.equal(row.drive_md5, hash(bytes, 'md5'));
    }
    const snapshot = drive!.uploaded().find(f => f.appProperties.dlKind === 'RECORD')!.bytes.toString();
    assert.doesNotMatch(snapshot, /audio|segment|expires/i);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM audio_segments WHERE interview_id=$1', [id])).rows[0].n, 1);
    assert.equal((await readiness(false)).ready, null);
    assert.equal((await readiness()).ready, true);
    assert.equal((await (await request(`${route}/run`, 'POST')).json()).alreadyBackedUp, true);
    await request('/api/validation/tick', 'POST');
    assert.equal(drive!.uploaded().length, 3);
    emit('httpBackupAndLive', { result: 'PASS', kinds: ['RECORD', 'ATTACHMENT', 'VIDEO'], hashesAndVersionsMatch: true, audioExcluded: true, liveReady: true, cachedReady: null, duplicateSkipped: true, finiteTickLimit: 20 });
    stage = 'remote-negative-and-preservation';
    drive!.uploaded()[0]!.md5Override = '0'.repeat(32);
    assert.equal((await readiness()).ready, false);
    drive!.uploaded()[0]!.md5Override = undefined;
    drive!.state.unauthorized = true;
    assert.equal((await readiness()).ready, false);
    assert.deepEqual(await readFile(sourceVideo), original);
    assert.deepEqual(await readFile(path.join(runtime.dir, 'videos/synthetic.mp4')), original);
    assert.equal(hash(await readFile(path.join(runtime.dir, 'attachments', attachmentKey))), plan.items.find(i => i.kind === 'ATTACHMENT')!.sha256);
    assert.equal(drive!.log.some(x => ['DELETE', 'PATCH'].includes(x.method)), false);
    assert.equal(runtime.network.blocked, 0); assert.equal(runtime.network.external, 0);
    emit('negativeAndPreservation', { result: 'PASS', corruptRemoteRejected: true, revokedRemoteRejected: true, originalHashesUnchanged: true, destructiveRequests: 0, externalGoogleRequests: 0, allowedBackendRequests: runtime.network.allowed });
    emit('result', { result: 'PASS', schema: runtime.schema, directory: path.relative('/workspace', runtime.dir), actualGoogleDrive: 'NOT_RUN', actualAndroid: 'NOT_RUN', deployment: 'NOT_RUN' });
  } finally { await runtime.close(); }
}
verify().catch(() => { emit('result', { result: 'FAIL', stage, actualGoogleDrive: 'NOT_RUN' }); process.exitCode = 1; });
