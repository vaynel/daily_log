import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const cli = new URL('./purge-legacy-live.mjs', import.meta.url).pathname;

test('default dry-run is private and read-only; apply deletes only expired ended legacy files', async () => {
  const dir = await mkdtemp('/workspace/data/task141-cli-');
  const old = new Date('2024-01-31T03:00:00Z');
  try {
    const fixtures = {
      'live-old.json': { endedAt: old.toISOString() },
      'live-new.json': { endedAt: old.toISOString() },
      'live-linked.json': { interviewId: 'record-id', endedAt: old.toISOString() },
      'live-active.json': { endedAt: null },
      'live-processing.json': { endedAt: old.toISOString(), processing: true },
      'unrelated.json': { endedAt: old.toISOString() },
    };
    for (const [name, data] of Object.entries(fixtures)) {
      const file = path.join(dir, name);
      await writeFile(file, JSON.stringify({ ...data, turns: [{ userText: 'DO_NOT_PRINT_PRIVATE_BODY' }] }));
      const date = name === 'live-new.json' ? new Date('2024-02-01T03:00:00Z') : old;
      await utimes(file, date, date);
    }
    await symlink(path.join(dir, 'unrelated.json'), path.join(dir, 'live-symlink.json'));
    const run = (...extra) => spawnSync(process.execPath, [cli, '--session-dir', dir, '--now', '2024-02-29T03:00:00Z', ...extra], { encoding: 'utf8' });
    const before = await readdir(dir);
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout), { mode: 'dry-run', targets: 1, oldest: old.toISOString(), newest: old.toISOString(), deleted: 0, failed: 0 });
    assert.deepEqual(await readdir(dir), before);
    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).deleted, 1);
    assert.deepEqual(await readdir(dir), before.filter(n => n !== 'live-old.json'));
    for (const output of [dry, applied]) {
      assert.doesNotMatch(output.stdout + output.stderr, /DO_NOT_PRINT|live-old|record-id/);
    }
    assert.equal(JSON.parse(run('--apply').stdout).targets, 0);
    const invalid = run('--oops');
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(await readdir(dir), before.filter(n => n !== 'live-old.json'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt transcripts stay private and preserved while valid expired files are cleaned', async () => {
  const dir = await mkdtemp('/workspace/data/task141-corrupt-');
  const old = new Date('2024-01-01T00:00:00Z');
  try {
    for (const [name, body] of [['live-corrupt.json', '{"SECRET_CORRUPT_BODY":'], ['live-valid.json', JSON.stringify({ endedAt: old.toISOString() })]]) {
      const file = path.join(dir, name);
      await writeFile(file, body); await utimes(file, old, old);
    }
    const r = spawnSync(process.execPath, [cli, '--session-dir', dir, '--now', '2024-02-01T00:00:00Z', '--apply'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { mode: 'apply', targets: 1, oldest: old.toISOString(), newest: old.toISOString(), deleted: 1, failed: 1 });
    assert.deepEqual(await readdir(dir), ['live-corrupt.json']);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET_CORRUPT_BODY|live-corrupt/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
