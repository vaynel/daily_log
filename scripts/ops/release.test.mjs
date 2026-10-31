import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const commit = '5680ca374afe6cd8065a3e43402b8c4d285f8312';
test('switch denies missing, stale, wrong-release and incomplete approval; valid approval changes only release pointer', () => {
  const root = mkdtempSync('/workspace/data/task30/gate-');
  const call = (action) => spawnSync(process.execPath, ['scripts/ops/release.mjs', action, root, commit], { encoding: 'utf8' });
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
