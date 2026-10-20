import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('launcher preflight gives a clear native OS result and never starts login',()=>{
 const r=spawnSync(process.execPath,['scripts/siwc-windows.mjs','--check'],{encoding:'utf8'});
 assert.equal(r.status,process.platform==='win32'?0:1);
 assert.match(r.stdout+r.stderr,process.platform==='win32'?/WINDOWS_READY/:/WINDOWS_REQUIRED/);
 assert.doesNotMatch(r.stdout+r.stderr,/auth\.openai\.com|Bearer/);
});
test('Windows cmd launcher handles missing Node without policy changes or login', {skip:process.platform!=='win32'},()=>{
 const r=spawnSync(process.env.ComSpec,['/d','/c','start-windows.cmd'],{encoding:'utf8',input:'\n',env:{...process.env,PATH:process.env.SystemRoot+'\\System32'}});
 assert.equal(r.status,1);assert.match(r.stdout,/Node.js 22/);
});
