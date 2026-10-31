import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [commit,out]=process.argv.slice(2);
const hash=(b)=>createHash('sha256').update(b).digest('hex');
try {
 if (!/^[a-f0-9]{40}$/.test(commit??'') || !out) throw new Error('EXACT_COMMIT_AND_OUTPUT_REQUIRED');
 execFileSync('git',['cat-file','-e',`${commit}^{commit}`]);
 mkdirSync(out,{recursive:true});
 const archive=join(out,'source.tar');
 if(existsSync(archive)||existsSync(join(out,'manifest.json'))) throw new Error('OUTPUT_ALREADY_EXISTS');
 execFileSync('git',['archive','--format=tar',`--output=${archive}`,commit]);
 const lock=execFileSync('git',['show',`${commit}:package-lock.json`]);
 const manifest={commit,tree:execFileSync('git',['rev-parse',`${commit}^{tree}`],{encoding:'utf8'}).trim(),sha256:hash(readFileSync(archive)),lockSha256:hash(lock),kind:'LOCKED_SOURCE_BUILD_REQUIRED',deployed:false};
 writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(manifest));
} catch { console.error('BUNDLE_REFUSED: exact commit, new output directory and Git objects required');process.exitCode=2; }
