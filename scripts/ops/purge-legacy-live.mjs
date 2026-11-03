#!/usr/bin/env node
// Explicit directory only: never silently select an operator's production data.
import { tsImport } from 'tsx/esm/api';
try {
  const args = process.argv.slice(2);
  let dir, now = new Date(), apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--session-dir') dir = args[++i];
    else if (args[i] === '--now') now = new Date(args[++i]);
    else throw new Error('INVALID_ARGUMENT');
  }
  if (!dir || dir.startsWith('--') || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
  const { purgeLegacyLive } = await tsImport('../../apps/server/src/retention/legacy-live.ts', import.meta.url);
  const result = await purgeLegacyLive(dir, { now, apply });
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch {
  // Do not print raw errors: they can include paths or JSON transcript text.
  console.error('LEGACY_CLEANUP_FAILED: use --session-dir <directory> [--now <ISO time>] [--apply]');
  process.exitCode = 1;
}
