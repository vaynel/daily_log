import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const base='5680ca374afe6cd8065a3e43402b8c4d285f8312';
test('bundle pins exact source commit and lockfile, hashes archive and rejects symbolic revisions',()=>{
 const out=mkdtempSync('/workspace/data/task30/bundle-test-');
 try {
  const r=spawnSync(process.execPath,['scripts/ops/bundle.mjs',base,out],{encoding:'utf8'}); assert.equal(r.status,0,r.stderr);
  const m=JSON.parse(readFileSync(`${out}/manifest.json`));assert.equal(m.commit,base);
  assert.equal(m.sha256,createHash('sha256').update(readFileSync(`${out}/source.tar`)).digest('hex'));
  const lock=execFileSync('tar',['-xOf',`${out}/source.tar`,'package-lock.json']);
  assert.equal(m.lockSha256,createHash('sha256').update(lock).digest('hex'));
  assert.equal(spawnSync(process.execPath,['scripts/ops/bundle.mjs','HEAD',out]).status,2);
 } finally { rmSync(out,{recursive:true,force:true}); }
});
