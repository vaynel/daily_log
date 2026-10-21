import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from './auth.mjs';
import {sendHandoff,validateHandoff,IMPORT_OK,IMPORT_CURRENT} from './handoff.mjs';
import {nextStep} from './companion.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwks={keys:[{...publicKey.export({format:'jwk'}),kid:'k',alg:'RS256',use:'sig'}]};
const now=Math.floor(Date.now()/1000);
const jwt=()=>{const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'k'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',aud:'oaiapp_test',sub:'user',exp:now+3600,iat:now})).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;};
const session=(o={})=>({version:1,issuer:'https://auth.openai.com',client_id:'oaiapp_test',subject:'user',id_token:jwt(),access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_at:Date.now()+3600000,scopes:['resource.invoke','chatgpt.tokens.use.direct'],state:'READY',...o});
const good={target:'daily@server.example',hostKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsynthetic',remoteRepo:'/srv/daily_log',remoteDir:'/srv/daily-log-siwc/account-1'};
const yes=async()=>true;
function memory(record){const s={record,retired:0,lock:fn=>fn(),read:async()=>s.record,retireUnlocked:async()=>{s.retired++;s.record=null;}};return s;}
test('target, host key and remote paths are validated before any credential read',async()=>{
 for(const bad of [{target:'-oProxyCommand=x@h'},{target:'a b@h'},{target:'user@host;rm'},{hostKey:'ssh-ed25519'},{hostKey:'ssh-ed25519 AAAA extra'},{remoteRepo:'srv/x'},{remoteDir:'/srv/../etc'},{remoteDir:'/srv/a b'},{port:0}]) assert.throws(()=>validateHandoff({...good,...bad}));
 const s=memory(session());let reads=0;s.read=async()=>{reads++;return s.record;};
 await assert.rejects(sendHandoff(s,{...good,target:'bad'},{confirm:yes}));assert.equal(reads,0);
});
test('no explicit consent means no read, no ssh and local session kept',async()=>{
 const s=memory(session());let calls=0;
 const r=await sendHandoff(s,good,{confirm:async()=>false,run:async()=>{calls++;}});
 assert.equal(r.state,'CANCELLED');assert.equal(calls,0);assert.ok(s.record);
});
test('expired, missing or permission-less credentials never leave the PC',async()=>{
 for(const [rec,want] of [[null,'WAIT_AUTH'],[session({expires_at:Date.now()+1000}),'WAIT_AUTH'],[session({state:'WAIT_PERMISSION'}),'WAIT_PERMISSION'],[session({refresh_token:undefined}),'WAIT_AUTH']]) {
  let calls=0;const s=memory(rec);
  assert.equal((await sendHandoff(s,good,{confirm:yes,run:async()=>{calls++;}})).state,want);assert.equal(calls,0);
 }
});
test('ssh args are strict, token stays in stdin only; failure and unconfirmed exit keep local session',async()=>{
 const s=memory(session());let seen;
 for(const res of [{ok:false,code:'SSH_FAILED'},{ok:true,out:'something else'}]) {
  const r=await sendHandoff(s,good,{confirm:yes,run:async(args,payload)=>{seen={args,payload};return res;}});
  assert.match(r.state,/^TRANSFER_(FAILED|UNCONFIRMED)$/);assert.equal(r.localKept,true);assert.equal(s.retired,0);assert.ok(s.record);
 }
 const joined=seen.args.join(' ');
 assert.match(joined,/StrictHostKeyChecking=yes/);assert.match(joined,/BatchMode=yes/);assert.match(joined,/GlobalKnownHostsFile=none/);
 assert.equal(joined.includes('synthetic-access')||joined.includes('synthetic-refresh'),false);
 assert.ok(seen.args.indexOf('--')<seen.args.indexOf(good.target));
 assert.match(seen.payload,/synthetic-refresh/);
});
test('success retires the local copy only after server confirmation; retry after lost reply is idempotent',async()=>{
 const s=memory(session());
 const r=await sendHandoff(s,good,{confirm:yes,run:async()=>({ok:true,out:IMPORT_OK+'\n'})});
 assert.equal(r.state,'TRANSFERRED');assert.equal(r.productConnection,'NOT_VERIFIED');assert.equal(s.retired,1);
 const s2=memory(session());
 assert.equal((await sendHandoff(s2,good,{confirm:yes,run:async()=>({ok:true,out:IMPORT_CURRENT})})).already,true);assert.equal(s2.retired,1);
});
test('Windows save -> Linux import over simulated pipe: wrong account rejected, duplicate import keeps server session, expired token rejected',{skip:process.platform==='win32'},async()=>{
 const base=await mkdtemp(resolve('data/siwc-handoff-'));
 try {
  const local=new Store(`${base}/win/daily-log-siwc`),server=new Store(`${base}/srv/daily-log-siwc`);
  await local.save(session());const serverHost=await server.init();
  const pipe=async(args,payload)=>{try{const {result}=await server.importText(payload,jwks);return {ok:true,out:result==='ALREADY_CURRENT'?IMPORT_CURRENT:IMPORT_OK};}catch{return {ok:false,code:'SSH_FAILED'};}};
  const r=await sendHandoff(local,good,{confirm:yes,run:pipe});
  assert.equal(r.state,'TRANSFERRED');assert.equal(await local.read(),null);
  assert.equal((await server.read()).state,'READY');assert.equal(await server.init(),serverHost);
  // stale copy later (e.g. lost reply) must not overwrite server-owned refresh
  const again=await server.importText(JSON.stringify(session()),jwks);
  assert.equal(again.result,'ALREADY_CURRENT');
  const other=new Store(`${base}/other/daily-log-siwc`);await other.init();
  await assert.rejects(other.importText(JSON.stringify(session({expires_at:Date.now()-1})),jwks));
  await assert.rejects(other.importText(JSON.stringify(session({subject:'someone-else'})),jwks));
  await assert.rejects(other.importText('x'.repeat(70000),jwks));
  assert.equal(await other.read(),null);
 } finally {await rm(base,{recursive:true,force:true});}
});
test('completion guidance depends on platform and readiness',()=>{
 assert.match(nextStep('READY','win32'),/5번/);assert.match(nextStep('READY','linux'),/추가 전달이 필요 없습니다/);
 assert.match(nextStep('WAIT_PERMISSION','win32'),/전달 불가/);assert.match(nextStep('WAIT_AUTH','linux'),/전달 불가/);
});
