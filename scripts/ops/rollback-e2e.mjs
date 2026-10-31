// Isolated service only. Owns one random schema; restores only that schema, never public.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const url=process.env.DATABASE_URL;
if(!url || !process.env.PG_BIN) throw new Error('DATABASE_URL and PG_BIN required');
const admin=new pg.Pool({connectionString:url,max:1});
const suffix=randomBytes(6).toString('hex');const names=[`t30_rollback_${suffix}`];
const dir=mkdtempSync('/workspace/data/task30/rollback-');const pools=[];const created=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
function cli(name,args,dbUrl) {
 const u=new URL(dbUrl);const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1))};
 const r=spawnSync(join(process.env.PG_BIN,name),args,{env,encoding:'utf8'});
 assert.equal(r.status,0,`${name} failed (details omitted to protect connection credentials)`);
}
try {
 for(const name of names){await admin.query(`CREATE SCHEMA ${name}`);created.push(name);}
 const urls=[url];
 for(const u of urls)pools.push(new pg.Pool({connectionString:u,max:1,options:`-c search_path=${names[0]}`}));
 const [before]=pools;const restore=before;
 const migrations=readdirSync('apps/server/src/db/migrations').filter(f=>f.endsWith('.sql')).sort();
 await before.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
 for(const f of migrations.slice(0,-1)){await before.query(readFileSync(`apps/server/src/db/migrations/${f}`,'utf8'));await before.query('INSERT INTO schema_migrations(name) VALUES($1)',[f]);}
 const id=randomUUID();await before.query("INSERT INTO interviews(id,owner_id,life_date,started_at,status) VALUES($1,'synthetic-owner','2026-10-01',now(),'CONFIRMED')",[id]);
 await before.query("INSERT INTO record_versions(id,interview_id,kind,version,content,created_at) VALUES($1,$2,'RESULT',1,$3,now())",[randomUUID(),id,{file:'complete.mp4',test:true}]);
 await before.query("INSERT INTO pipeline_states(interview_id,production,review,backup,updated_at) VALUES($1,'DONE','PASSED','VERIFIED',now())",[id]);
 const files=join(dir,'files');mkdirSync(files);writeFileSync(join(files,'original.txt'),'synthetic original');writeFileSync(join(files,'complete.mp4'),'synthetic completed result bytes — not playable media');
 const hashes=Object.fromEntries(readdirSync(files).map(f=>[f,hash(readFileSync(join(files,f)))]));
 const snapshot=async p=>{const data={};for(const t of ['interviews','record_versions','pipeline_states','schema_migrations'])data[t]=(await p.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;return hash(JSON.stringify(data));};
 const dbHash=await snapshot(before);
 cli('pg_dump',['--schema',names[0],'--format=custom','--no-owner','--no-acl','--file',join(dir,'db.dump')],urls[0]);
 const tar=spawnSync('tar',['-cf',join(dir,'files.tar'),'-C',files,'.']);assert.equal(tar.status,0);
 // Run the real migration entry point against the old schema, including idempotency ledger.
 const env={...process.env,DATABASE_URL:urls[0],FILE_STORAGE_DIR:files,SESSION_SECRET:'synthetic-rollback-secret-0000',PGOPTIONS:`-c search_path=${names[0]}`};
 const migrate=spawnSync(process.execPath,['apps/server/dist/db/migrate.js'],{env,encoding:'utf8'});assert.equal(migrate.status,0);assert.match(migrate.stdout,/0012_trash_retention/);
 assert.equal((await before.query('SELECT * FROM schema_migrations')).rowCount,migrations.length);
 await admin.query(`DROP SCHEMA ${names[0]} CASCADE`);
 cli('pg_restore',['--exit-on-error','--no-owner','--no-acl','--dbname',new URL(url).pathname.slice(1),join(dir,'db.dump')],url);
 const restored=join(dir,'restored');mkdirSync(restored);assert.equal(spawnSync('tar',['-xf',join(dir,'files.tar'),'-C',restored]).status,0);
 assert.equal(await snapshot(restore),dbHash);
 for(const [f,h]of Object.entries(hashes)){assert.equal(hash(readFileSync(join(files,f))),h);assert.equal(hash(readFileSync(join(restored,f))),h);}
 assert.equal((await restore.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='interviews' AND column_name='deleted_at'")).rowCount,0);
 console.log(JSON.stringify({result:'PASS',migration:'0012_trash_retention',rollback:'pg_dump17 -> pg_restore17 owned temporary schema restore',dbSha256:dbHash,fileSha256:hashes,sourceAndRestoredEqual:true,synthetic:true}));
}finally{for(const p of pools)await p.end();for(const n of created)await admin.query(`DROP SCHEMA IF EXISTS ${n} CASCADE`);await admin.end();rmSync(dir,{recursive:true,force:true});}
