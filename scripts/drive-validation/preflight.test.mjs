import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { preflight } from './preflight.mjs';

test('missing DB/source/OAuth stay NOT_RUN and real upload is disabled', async () => {
  const p = await preflight({}, '/workspace/data/task101-nonexistent-video');
  assert.equal(p.database.reason, 'DATABASE_URL_MISSING');
  assert.equal(p.source.result, 'NOT_RUN');
  assert.equal(p.oauth.result, 'NOT_RUN');
  assert.equal(p.actualGoogleDrive.result, 'NOT_RUN');
  assert.equal(p.realUploadEnabled, false);
});
test('presence of credentials cannot claim OAuth consent or DB health; values never emitted', async () => {
  const p = await preflight({ DATABASE_URL: 'sensitive-sentinel', GOOGLE_CLIENT_SECRET: 'sensitive-sentinel' });
  assert.equal(p.database.result, 'NOT_RUN');
  assert.equal(p.oauth.result, 'NOT_RUN');
  assert.equal(JSON.stringify(p).includes('sensitive-sentinel'), false);
});
test('upload flag is rejected', () => {
  const r = spawnSync(process.execPath, ['scripts/drive-validation/preflight.mjs', '--upload'], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).result, 'NOT_RUN');
});
test('verification refuses absent DB and refuses default/real modes before connecting', () => {
  for (const args of [[], ['--real'], ['--fake']]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/drive-validation/verify.ts', ...args], {
      env: { PATH: process.env.PATH, TASK101_TEST_DB: '1' }, timeout: 10000, encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).check, 'NOT_RUN');
  }
});
