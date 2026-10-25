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
function memory(record){const s={record,retired:0,lock:fn=>fn(),read:async()=>s.record,saveUnlocked:async r=>{s.record=r;},retireUnlocked:async()=>{s.retired++;s.record=null;}};return s;}
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
test('missing, permission-less or refresh-less credentials never leave the PC',async()=>{
 for(const [rec,want] of [[null,'WAIT_AUTH'],[session({state:'WAIT_PERMISSION'}),'WAIT_PERMISSION'],[session({refresh_token:undefined}),'WAIT_AUTH'],[session({state:'WAIT_RECONCILIATION'}),'WAIT_RECONCILIATION']]) {
  let calls=0,refreshes=0;const s=memory(rec);
  assert.equal((await sendHandoff(s,good,{confirm:yes,run:async()=>{calls++;},transport:async()=>{refreshes++;}})).state,want);assert.equal(calls,0);assert.equal(refreshes,0);
 }
});
const issuer=(status,body,log)=>async(url,opts)=>{log.push(String(opts.body));return {ok:status===200,status,json:async()=>body};};
const ok200={access_token:'renewed-access',refresh_token:'renewed-refresh',token_type:'Bearer',expires_in:3600};
test('expired or expiring access token is renewed with the stored refresh token, then handed off',async()=>{
 for(const expires_at of [Date.now()-5000,Date.now()+30000]) {
  const s=memory(session({expires_at}));const log=[];let seen;
  const r=await sendHandoff(s,good,{confirm:yes,transport:issuer(200,ok200,log),run:async(args,payload)=>{seen={args,payload};return {ok:true,out:IMPORT_OK};}});
  assert.equal(r.state,'TRANSFERRED');assert.equal(log.length,1);assert.match(log[0],/refresh_token=synthetic-refresh/);
  const sent=JSON.parse(seen.payload);assert.equal(sent.access_token,'renewed-access');assert.equal(sent.refresh_token,'renewed-refresh');assert.ok(sent.expires_at>Date.now()+60000);
  assert.equal(seen.args.join(' ').includes('renewed-'),false);assert.equal(s.retired,1);
 }
});
test('fresh token is not refreshed',async()=>{
 const s=memory(session());const log=[];
 assert.equal((await sendHandoff(s,good,{confirm:yes,transport:issuer(200,ok200,log),run:async()=>({ok:true,out:IMPORT_OK})})).state,'TRANSFERRED');assert.equal(log.length,0);
});
test('permanent refresh failure stops at WAIT_AUTH without sending; the local record is not deleted',async()=>{
 const s=memory(session({expires_at:Date.now()-1}));let calls=0;
 const r=await sendHandoff(s,good,{confirm:yes,transport:issuer(400,{error:'invalid_grant'},[]),run:async()=>{calls++;}});
 assert.equal(r.state,'WAIT_AUTH');assert.equal(calls,0);assert.equal(s.retired,0);assert.ok(s.record);assert.equal(s.record.state,'WAIT_AUTH');
});
test('transient refresh failure keeps tokens and a later hand-off can retry',async()=>{
 const s=memory(session({expires_at:Date.now()-1}));let calls=0;const log=[];
 let r=await sendHandoff(s,good,{confirm:yes,transport:issuer(503,{error:'server_error'},log),run:async()=>{calls++;}});
 assert.equal(r.state,'WAIT_RETRY');assert.equal(r.localKept,true);assert.equal(calls,0);assert.equal(s.retired,0);assert.equal(s.record.refresh_token,'synthetic-refresh');
 r=await sendHandoff(s,good,{confirm:yes,transport:issuer(200,ok200,log),run:async()=>({ok:true,out:IMPORT_OK})});
 assert.equal(r.state,'TRANSFERRED');assert.equal(log.length,2);
 // a network failure is outcome-unknown: never replayed automatically
 const s2=memory(session({expires_at:Date.now()-1}));
 r=await sendHandoff(s2,good,{confirm:yes,transport:async()=>{throw Error('net');},run:async()=>{calls++;}});
 assert.equal(r.state,'WAIT_RECONCILIATION');assert.equal(calls,0);
 const before=log.length;await sendHandoff(s2,good,{confirm:yes,transport:issuer(200,ok200,log),run:async()=>{calls++;}});assert.equal(log.length,before);
});
test('concurrent hand-offs on a real store rotate the refresh token exactly once and leave no token in args or output',{skip:process.platform==='win32'},async()=>{
 const base=await mkdtemp(resolve('data/siwc-handoff-'));
 try {
  const store=new Store(`${base}/win/daily-log-siwc`);await store.init();await store.save(session({expires_at:Date.now()-1}));
  const log=[],sent=[];
  const go=()=>sendHandoff(store,good,{confirm:yes,transport:async(u,o)=>{log.push(1);await new Promise(r=>setTimeout(r,50));return issuer(200,ok200,[])(u,o);},run:async(args,payload)=>{sent.push({args,payload});return {ok:true,out:IMPORT_OK};}}).catch(e=>({state:'ERROR',message:e.message}));
  const results=await Promise.all([go(),go()]);
  assert.equal(log.length,1);
  assert.equal(results.filter(r=>r.state==='TRANSFERRED').length,1);
  assert.deepEqual(results.filter(r=>r.state!=='TRANSFERRED').map(r=>r.message),['STORE_BUSY']);
  assert.equal(sent.length,1);assert.equal(JSON.stringify(results).includes('renewed-'),false);assert.equal(sent[0].args.join(' ').includes('renewed-'),false);
 } finally {await rm(base,{recursive:true,force:true});}
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
