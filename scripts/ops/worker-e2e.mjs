import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const schema=`t30_worker_${randomBytes(6).toString('hex')}`;
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,options:`-c search_path=${schema}`});
const dir=mkdtempSync('/workspace/data/task30/worker-');let child;let exited;
try {
 await pool.query(`CREATE SCHEMA ${schema}`);
 for(const f of readdirSync('apps/server/src/db/migrations').sort()) await pool.query(readFileSync(`apps/server/src/db/migrations/${f}`,'utf8'));
 const id=randomUUID();await pool.query("INSERT INTO interviews(id,owner_id,life_date,started_at,status) VALUES($1,'synthetic-owner',CURRENT_DATE,now(),'CONFIRMED')",[id]);
 for(const [kind,stages] of [['VIDEO_PRODUCTION',['scene_plan','narration','assets','render','quality']],['drive-backup',['preflight','copy','finalize']]]) await pool.query('INSERT INTO jobs(kind,subject_id,stages,idempotency_key) VALUES($1,$2,$3,$1)',[kind,id,stages]);
 const env={PATH:process.env.PATH,DATABASE_URL:process.env.DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,FILE_STORAGE_DIR:dir,SESSION_SECRET:'synthetic-worker-secret-0000',WORKER_POLL_INTERVAL_MS:'100'};
 child=spawn(process.execPath,['apps/server/dist/worker.js'],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);exited=new Promise(r=>child.on('exit',(code,signal)=>r({code,signal})));
 const deadline=Date.now()+20000;let rows;
 while(Date.now()<deadline){rows=(await pool.query('SELECT kind,state,wait_reason,error_code FROM jobs ORDER BY kind')).rows;if(rows.length===2 && rows.every(r=>r.state==='WAITING'))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='WAITING'&&r.wait_reason==='PERMISSION'),JSON.stringify(rows));
 const events=rows.map(r=>r.error_code);
 assert.ok(events.includes('PRO_UNAVAILABLE'));assert.ok(events.includes('DRIVE_NOT_CONNECTED'));
 assert.equal((await pool.query('SELECT * FROM budget_entries')).rowCount,0);
 child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});assert.match(output,/worker stopped/);
 console.log(JSON.stringify({result:'PASS',actualWorker:true,jobs:rows,eventCodes:events,paidLedgerEntries:0,termination:'SIGTERM exit 0'}));
}finally{if(child?.exitCode===null){child.kill('SIGKILL');await exited;}await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();rmSync(dir,{recursive:true,force:true});}
