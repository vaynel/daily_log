import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A missing/unreadable input must fail the preservation check, not produce a
// partial digest that happens to match another partial digest after rendering.
try {
  const root = process.argv[2];
  if (!root) throw new Error('output directory required');
  const files = [];
  function walk(relative) {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(relative, name));
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`unsupported input type: ${relative}`);
    }
  }
  walk('assets');
  if (!files.length) throw new Error('assets empty');
  files.push('sample.mp4');
  const hash = createHash('sha256');
  for (const relative of files) {
    if (!lstatSync(join(root, relative)).isFile()) {
      throw new Error(`not a regular file: ${relative}`);
    }
    const digest = createHash('sha256').update(readFileSync(join(root, relative))).digest('hex');
    hash.update(JSON.stringify([relative, digest]));
    hash.update('\n');
  }
  process.stdout.write(`${hash.digest('hex')}\n`);
} catch (error) {
  console.error(`STATE_HASH_FAILED: ${error.message}`);
  process.exitCode = 1;
}
