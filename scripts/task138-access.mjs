// Independent direct-file probes. Synthetic bytes; no external accounts/API.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildApp } from '../apps/server/src/app.ts';
import { createTempSchema } from '../apps/server/src/records/db.testutil.ts';
import { RecordStore } from '../apps/server/src/records/store.ts';
import { loadAuthConfig } from '../apps/server/src/auth/config.ts';
import { sign } from '../apps/server/src/auth/session.ts';
const dir=path.resolve('.tmp/task138-access');
const schema=await createTempSchema(process.env.DATABASE_URL);
const pool=schema.pool();
const store=new RecordStore(pool);
const secret='synthetic-access-task138-not-real';
const now=new Date();
const {interview}=await store.startInterview('owner',now);
await store.saveFileAttachment('owner',interview.id,'private-fixture',{storageKey:'private.md',checksum:createHash('sha256').update('SYNTHETIC_PRIVATE_ATTACHMENT').digest('hex'),kind:'MARKDOWN',name:'private.md',mime:'text/markdown',size:28,capturedAt:null,capturedSource:null},now);
await store.confirm('owner',interview.id,now);
await store.appendVersion('owner',interview.id,'RESULT',{file:'rejected.mp4'},now);
await pool.query("UPDATE pipeline_states SET production='DONE',review='REJECTED' WHERE interview_id=$1",[interview.id]);
await mkdir(path.join(dir,'videos'),{recursive:true});
await mkdir(path.join(dir,'attachments'),{recursive:true});
await writeFile(path.join(dir,'videos/rejected.mp4'),'SYNTHETIC_PRIVATE_VIDEO');
await writeFile(path.join(dir,'attachments/private.md'),'SYNTHETIC_PRIVATE_ATTACHMENT');
const auth=loadAuthConfig({GOOGLE_CLIENT_ID:'mock',GOOGLE_CLIENT_SECRET:'mock-not-real',ALLOWED_EMAILS:'owner@example.test,other@example.test',PUBLIC_BASE_URL:'http://127.0.0.1:1'});
const app=buildApp({auth,sessionSecret:secret,records:store,fileStorageDir:dir});
app.log.level='silent';
const token=(sub,email)=>sign({sub,email,iat:0,exp:4102444800},secret,'session');
const rows=[];
try {
 for(const [actor,cookie] of [['anonymous',null],['disallowed',token('denied','denied@example.test')],['owner',token('owner','owner@example.test')],['other-allowed',token('other','other@example.test')]]) {
  for(const url of [`/api/records/${interview.id}/result/file`,`/api/records/${interview.id}/results/1/file`,'/api/videos/rejected.mp4','/api/attachments/private.md']) {
   const r=await app.inject({url,headers:cookie?{cookie:`dl_session=${cookie}`}:{}});
   rows.push({actor,path:url.replace(interview.id,'<record>'),status:r.statusCode,privateBytes:r.body.startsWith('SYNTHETIC_PRIVATE_')});
   if(actor==='anonymous') assert.equal(r.statusCode,401);
   if(actor==='disallowed') assert.equal(r.statusCode,403);
  }
 }
 console.log(JSON.stringify(rows,null,2));
 await writeFile('docs/qa/task-32-evidence/access.json',JSON.stringify(rows,null,2));
 // Security expectations: unreviewed video and another owner's private bytes must never be served.
 assert.equal(rows.filter(r=>r.privateBytes && (r.actor==='other-allowed'||r.path.includes('rejected.mp4'))).length,0,'direct-file authorization/review bypass');
} finally {await app.close();await pool.end();await schema.drop();await rm(dir,{recursive:true,force:true});}
