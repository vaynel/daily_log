import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const checks = [
  ['review', ['test','-w','apps/server','--','src/video/qualityEvidence.review.test.ts','--maxWorkers=1','--no-file-parallelism','--reporter=verbose']],
  ['web', ['test','-w','apps/web','--','--maxWorkers=1','--no-file-parallelism']],
  ['siwc', ['run','test:siwc']],
  ['lint', ['run','lint']],
  ['typecheck', ['run','typecheck']],
  ['build', ['run','build']],
  ['secrets', ['run','scan:secrets']],
];
const results=[];
for(const [name,args] of checks){
  const r=spawnSync('npm',args,{cwd:'/workspace',encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync(`/workspace/docs/video/task-136-evidence/${name}.txt`,(r.stdout??'')+(r.stderr??''));
  results.push({name,command:['npm',...args].join(' '),exit:r.status,signal:r.signal});
  writeFileSync('/workspace/docs/video/task-136-evidence/check-exits.json',JSON.stringify(results,null,2)+'\n');
  console.log(name, r.status);
}
