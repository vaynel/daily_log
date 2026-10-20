import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('CLI probe accepts an executable and literal prefix arguments without PATH lookup', () => {
  const dir = mkdtempSync(join(process.cwd(), 'data', 'cli-test-'));
  try {
    const fixture = join(dir, 'cli with spaces.cjs');
    writeFileSync(fixture, "process.exit(process.argv[2] === '--help' ? 0 : 23);\n");
    const probe = spawnSync(process.execPath, ['scripts/pro-spike.mjs', process.execPath, fixture], {
      encoding: 'utf8', env: { ...process.env, PATH: '' },
    });
    assert.equal(probe.status, 0);
    assert.deepEqual(JSON.parse(probe.stdout).cliHelp, { available: true, exitCode: 0, error: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicitly missing executable remains unavailable without fallback', () => {
  const probe = spawnSync(process.execPath, ['scripts/pro-spike.mjs', '/workspace/data/no-such-codex'], {
    encoding: 'utf8',
  });
  const result = JSON.parse(probe.stdout);
  assert.equal(result.cliHelp.available, false);
  assert.equal(result.cliHelp.error, 'ENOENT');
  assert.equal(result.externalInferenceCalls, 0);
});

for (const scenario of ['success', 'api-auth', 'limit']) {
  test(`live experiment boundary: ${scenario}`, () => {
    const dir = mkdtempSync(join(process.cwd(), 'data', 'live-test-'));
    const calls = join(dir, 'calls');
    try {
      const fixture = join(dir, 'cli.cjs');
      writeFileSync(fixture, `
        const fs = require('node:fs');
        if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(24);
        const args = process.argv.slice(2);
        if (args[0] === 'login') {
          console.log(${JSON.stringify(scenario === 'api-auth' ? 'Logged in using an API key' : 'Logged in using ChatGPT')});
        } else {
          fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
          if (${JSON.stringify(scenario)} === 'limit') {
            console.log(JSON.stringify({type:'turn.failed', error:{message:'429'}}));
            process.exit(1);
          }
          const prompt = args.at(-1);
          const text = prompt.includes('color') ? 'red' : prompt.includes('숫자') ? '10' : '어떤 책을 읽었나요?';
          console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text}}));
          console.log(JSON.stringify({type:'turn.completed'}));
        }
      `);
      const r = spawnSync(process.execPath, ['scripts/pro-live-spike.mjs', '--run', process.execPath, fixture], {
        encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'synthetic', CODEX_API_KEY: 'synthetic' },
      });
      assert.equal(r.status, 0);
      const evidence = JSON.parse(r.stdout);
      if (scenario === 'success') {
        assert.deepEqual(evidence.cases.map(c => c.result), ['PASS', 'PASS', 'PASS']);
        assert.equal(readFileSync(calls, 'utf8'), 'call\ncall\ncall\n');
      } else if (scenario === 'api-auth') {
        assert.ok(evidence.cases.every(c => c.invocations === 0 && c.result === 'NOT_RUN'));
        assert.throws(() => readFileSync(calls), { code: 'ENOENT' });
      } else {
        assert.deepEqual(evidence.cases.map(c => c.result), ['FAIL', 'NOT_RUN', 'NOT_RUN']);
        assert.equal(readFileSync(calls, 'utf8'), 'call\n');
      }
      assert.equal(evidence.productAuthVerified, false);
      assert.equal(evidence.rawOutputRetained, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
