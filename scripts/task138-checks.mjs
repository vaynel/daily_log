import { spawn } from 'node:child_process';
import { writeFile, open } from 'node:fs/promises';
const checks = [
 ['build','npm',['run','build']],
 ['server','npm',['test','-w','apps/server','--','--no-file-parallelism','--maxWorkers=1']],
 ['web','npm',['test','-w','apps/web','--','--no-file-parallelism','--maxWorkers=1']],
 ['records-crash','node',['scripts/records-crash-e2e.mjs']],
 ['queue-restart','node',['scripts/queue-restart-e2e.mjs']],
 ['pipeline-restart','node',['scripts/pipeline-restart-e2e.mjs']],
 ['quality-restart','node',['scripts/quality-restart-e2e.mjs']],
 ['lint','npm',['run','lint']],
 ['typecheck','npm',['run','typecheck']],
];
const results=[];
for(const [name,cmd,args] of checks) {
 const f=await open(`docs/qa/task-32-evidence/${name}.txt`,'w');
 const start=new Date().toISOString();
 const p=spawn(cmd,args,{stdio:['ignore',f.fd,f.fd],env:{...process.env,UV_THREADPOOL_SIZE:'2',TMPDIR:'/workspace/.tmp'}});
 const result=await new Promise(resolve=>p.on('exit',(code,signal)=>resolve({name,code,signal,start,end:new Date().toISOString()})));
 await f.close(); results.push(result); console.log(JSON.stringify(result));
 await writeFile('docs/qa/task-32-evidence/checks.json',JSON.stringify(results,null,2));
}
