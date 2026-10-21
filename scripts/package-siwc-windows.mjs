import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const output=resolve('dist/siwc-windows');
// Exact committed-source allowlist: no data, credentials, .env, dependencies or local build outputs.
const files=['start-windows.cmd','scripts/siwc-windows.mjs','scripts/siwc-cli.mjs',
 'scripts/siwc/auth.mjs','scripts/siwc/paths.mjs','scripts/siwc/runtime.mjs','scripts/siwc/companion.mjs',
 'scripts/siwc/windows-store.mjs','scripts/siwc/handoff.mjs','scripts/siwc/windows/Store.cs','scripts/siwc/windows/store.ps1',
 'docs/auth/task-56-windows.md','docs/auth/task-56-verification.md','docs/auth/task-58-handoff.md'];
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[0-9a-f]{40}$/.test(commit))throw Error('COMMIT_REQUIRED');
for(const file of files)execFileSync('git',['cat-file','-e',`${commit}:${file}`],{stdio:'ignore'});
await mkdir(output,{recursive:true});
const name=`daily-log-siwc-windows-${commit}.zip`,path=join(output,name);
execFileSync('git',['-c','core.autocrlf=false','archive','--format=zip','--prefix=daily-log-siwc/',`--output=${path}`,commit,'--',...files],{stdio:'ignore'});
const hash=createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(path+'.sha256',`${hash}  ${name}\n`);
await writeFile(path+'.manifest.json',JSON.stringify({commit,sha256:hash,files,git:execFileSync('git',['--version'],{encoding:'utf8'}).trim()},null,2)+'\n');
console.log(JSON.stringify({commit,sha256:hash,file:path}));
