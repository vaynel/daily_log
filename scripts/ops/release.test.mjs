import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const commit = '5680ca374afe6cd8065a3e43402b8c4d285f8312';
test('switch denies missing, stale, wrong-release and incomplete approval; valid approval changes only release pointer', () => {
  const root = mkdtempSync('/workspace/data/task30/gate-');
  const call = (action) => spawnSync(process.execPath, ['scripts/ops/release.mjs', action, root, commit, '--nginx-config', join(root,'missing-nginx'), '--worker-properties', join(root,'missing-worker')], { encoding: 'utf8' });
  try {
    mkdirSync(join(root, 'releases', commit), { recursive: true });
    symlinkSync('releases/previous', join(root, 'current'));
    let r = call('switch'); assert.equal(r.status, 2); assert.match(r.stdout, /WAITING_APPROVAL/);
    assert.equal(readlinkSync(join(root, 'current')), 'releases/previous');
    const approval = { commit, administrator: 'TEST ONLY', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), externalChecks: { dns: true, https: true, google: true, android: true, pc: true }, backupVerified: true };
    for (const invalid of [{...approval, commit: 'a'.repeat(40)}, {...approval, expiresAt: '2000-01-01'}, {...approval, externalChecks: {}}, {...approval, backupVerified:false}, {...approval, administrator:''}]) {
      writeFileSync(join(root,'approval.json'), JSON.stringify(invalid)); assert.equal(call('switch').status, 2);
      assert.equal(readlinkSync(join(root,'current')), 'releases/previous');
    }
    writeFileSync(join(root,'approval.json'), JSON.stringify(approval));
    r=call('status'); assert.equal(r.status,0); assert.match(r.stdout,/READY_FOR_ADMIN_SWITCH/); assert.doesNotMatch(r.stdout,/OPEN|개통 완료/);
    r=call('switch'); assert.equal(r.status,0); assert.equal(readlinkSync(join(root,'current')),`releases/${commit}`); assert.match(r.stdout,/SWITCHED_PENDING_VERIFICATION/);
    assert.equal(call('destroy').status,2);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('preflight FAIL blocks status/switch without changing current; NOT_RUN stays visible and does not block', () => {
  const root = mkdtempSync('/workspace/data/task30/preflight-');
  const nginx = join(root, 'nginx.conf');
  const worker = join(root, 'worker.txt');
  const call = (action) => spawnSync(process.execPath, ['scripts/ops/release.mjs', action, root, commit, '--nginx-config', nginx, '--worker-properties', worker], { encoding: 'utf8' });
  try {
    mkdirSync(join(root, 'releases', commit), { recursive: true });
    symlinkSync('releases/previous', join(root, 'current'));
    writeFileSync(join(root, 'approval.json'), JSON.stringify({ commit, administrator: 'TEST ONLY', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), externalChecks: { dns:true, https:true, google:true, android:true, pc:true }, backupVerified:true }));
    writeFileSync(nginx, 'server { listen 443 ssl; client_max_body_size 1m; }');
    writeFileSync(worker, 'Restart=on-failure\nRestartUSec=10s\nStartLimitIntervalUSec=0\n');
    for (const action of ['status', 'switch']) {
      const r = call(action);
      assert.equal(JSON.parse(r.stdout).status, 'WAITING_PREFLIGHT');
      assert.equal(r.status, 2);
      assert.equal(readlinkSync(join(root, 'current')), 'releases/previous');
      assert.equal(JSON.parse(r.stdout).preflight.checks[0].result, 'FAIL');
    }
    writeFileSync(nginx, 'server { listen 443 ssl; client_max_body_size 11m; }');
    writeFileSync(worker, 'Restart=no\nRestartUSec=10s\nStartLimitIntervalUSec=0\n');
    assert.equal(JSON.parse(call('switch').stdout).status, 'WAITING_PREFLIGHT');
    assert.equal(readlinkSync(join(root, 'current')), 'releases/previous');
    writeFileSync(worker, 'Restart=always\nRestartUSec=10s\nStartLimitIntervalUSec=0\n');
    let valid = call('switch');
    assert.equal(valid.status, 0);
    assert.deepEqual(JSON.parse(valid.stdout).preflight.checks.map(c => c.result), ['PASS','PASS']);
    assert.equal(readlinkSync(join(root, 'current')), `releases/${commit}`);
    for (const value of ['1g', '1G']) {
      writeFileSync(nginx, `server { listen 443 ssl; client_max_body_size ${value}; }`);
      rmSync(join(root, 'current'));
      symlinkSync('releases/previous', join(root, 'current'));
      const result = call('switch');
      assert.equal(result.status, 0, value);
      assert.equal(JSON.parse(result.stdout).status, 'SWITCHED_PENDING_VERIFICATION');
      assert.deepEqual(JSON.parse(result.stdout).preflight.checks.map(c => c.result), ['PASS','PASS']);
      assert.equal(readlinkSync(join(root, 'current')), `releases/${commit}`);
    }
    chmodSync(root,0o755); chmodSync(nginx,0o000); chmodSync(worker,0o000);
    const denied = spawnSync(process.execPath, ['scripts/ops/release.mjs', 'status', root, commit, '--nginx-config', nginx, '--worker-properties', worker], { encoding:'utf8', ...(process.getuid()===0 ? {uid:65534,gid:65534} : {}) });
    assert.equal(denied.status,0,denied.stderr);
    assert.deepEqual(JSON.parse(denied.stdout).preflight.checks.map(c => c.result), ['NOT_RUN','NOT_RUN']);
    rmSync(nginx); rmSync(worker);
    const r = call('switch');
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout).preflight.checks.map(c => c.result), ['NOT_RUN','NOT_RUN']);
    assert.equal(readlinkSync(join(root, 'current')), `releases/${commit}`);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
