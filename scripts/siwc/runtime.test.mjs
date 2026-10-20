import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from './auth.mjs';
const runtime=await import('./runtime.mjs').catch(()=>({}));
async function fixture(fn, overrides={}) {
 const base=await mkdtemp(resolve('data/siwc-runtime-'));const dir=resolve(base,'store');const store=new Store(dir);await store.init();
 await store.save({version:1,issuer:'https://auth.openai.com',subject:'synthetic-user',client_id:'oaiapp_test',access_token:'synthetic-access',refresh_token:'synthetic-refresh',scopes:['chatgpt.tokens.use.direct','resource.invoke'],expires_at:Date.now()+3600000,state:'READY',...overrides});
 try {await fn(store);} finally {await rm(base,{recursive:true,force:true});}
}
const stream=(events)=>new Response(events.map(x=>`data: ${JSON.stringify(x)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
const input={model:'synthetic-model',text:'합성 테스트'};
test('unverified support and permission stop before any external call',async()=>{
 assert.equal(typeof runtime.infer,'function');
 let calls=0; const transport=async()=>{calls++;throw Error('must not call');};
 await fixture(async s=>assert.equal((await runtime.infer(s,input,{transport})).state,'WAIT_SUPPORT'));
 await fixture(async s=>assert.equal((await runtime.infer(s,input,{supportVerified:true,transport})).state,'WAIT_PERMISSION'),{state:'WAIT_PERMISSION'});
 assert.equal(calls,0);
});
test('HTTP and streaming errors latch wait across restart with no paid fallback or retry',async()=>{
 assert.equal(typeof runtime.infer,'function');
 for(const [status,want] of [[401,'WAIT_AUTH'],[403,'WAIT_SUPPORT'],[429,'WAIT_LIMIT'],[503,'WAIT_RETRY']]) {
  let calls=0;const transport=async(url)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');return new Response('{}',{status});};
  await fixture(async s=>{
   assert.equal((await runtime.infer(s,input,{supportVerified:true,transport})).state,want);
   assert.equal((await runtime.infer(new Store(s.dir),input,{supportVerified:true,transport})).state,want);
   assert.equal(calls,1);
  });
 }
 for(const [event,want] of [[{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}},'WAIT_LIMIT'],[{type:'response.incomplete'},'WAIT_REVIEW']]) {
  await fixture(async s=>assert.equal((await runtime.infer(s,input,{supportVerified:true,transport:async()=>stream([event])})).state,want));
 }
});
test('completion requires terminal event, exact public endpoint/body; lost stream waits for reconciliation',async()=>{
 assert.equal(typeof runtime.infer,'function');
 await fixture(async s=>{
  const result=await runtime.infer(s,input,{supportVerified:true,transport:async(url,opts)=>{
   assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(opts.headers.Authorization,'Bearer synthetic-access');
   assert.deepEqual(JSON.parse(opts.body),{model:'synthetic-model',input:[{role:'user',content:'합성 테스트'}],store:false,stream:true});
   return stream([{type:'response.output_text.delta',delta:'합성'},{type:'response.completed'}]);
  }}); assert.equal(result.state,'SUCCEEDED');assert.equal(result.text,'합성');
 });
 await fixture(async s=>assert.equal((await runtime.infer(s,input,{supportVerified:true,transport:async()=>stream([{type:'response.output_text.delta',delta:'partial'}])})).state,'WAIT_RECONCILIATION'));
});
test('refresh rotates once under the cross-process store lock and keeps scopes on omitted scope',async()=>{
 assert.equal(typeof runtime.refresh,'function');
 let calls=0,release;
 const transport=async(url,opts)=>{
  calls++;assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');
  assert.equal(opts.body.get('grant_type'),'refresh_token');assert.equal(opts.body.has('scope'),false);
  await new Promise(r=>{release=r;});
  return Response.json({access_token:'synthetic-new',refresh_token:'synthetic-rotated',token_type:'Bearer',expires_in:3600});
 };
 await fixture(async s=>{
  const first=runtime.refresh(s,{transport});while(!release) await new Promise(r=>setImmediate(r));
  await assert.rejects(runtime.refresh(new Store(s.dir),{transport}),/BUSY/);release();await first;
  assert.equal((await s.read()).refresh_token,'synthetic-rotated');assert.equal((await s.read()).state,'READY');
  await runtime.refresh(s,{transport});assert.equal(calls,1);
 },{expires_at:0});
});
test('terminal refresh clears unusable tokens; ambiguous rotation waits without replay; explicit reconnect recovers',async()=>{
 assert.equal(typeof runtime.refresh,'function');
 for(const [code,want] of [['invalid_grant','WAIT_AUTH'],['invalid_client','WAIT_SUPPORT']]) await fixture(async s=>{
  assert.equal((await runtime.refresh(s,{transport:async()=>Response.json({error:code},{status:400})})).state,want);
  if(code==='invalid_grant') assert.equal((await s.read()).refresh_token,undefined);
 },{expires_at:0});
 await fixture(async s=>{
  let calls=0;const transport=async()=>{calls++;throw Error('synthetic secret must not escape');};
  assert.equal((await runtime.refresh(s,{transport})).state,'WAIT_RECONCILIATION');
  await runtime.refresh(s,{transport}); assert.equal(calls,1);
  await s.save({...await s.read(),state:'READY',access_token:'synthetic-reconnected',refresh_token:'synthetic-new',expires_at:Date.now()+3600000});
  assert.equal((await runtime.infer(s,input,{supportVerified:true,transport:async()=>stream([{type:'response.completed'}])})).state,'SUCCEEDED');
 },{expires_at:0});
});
test('signout attempts official discovered revocation, clears secrets even if remote revocation is unconfirmed',async()=>{
 for(const ok of [true,false]) await fixture(async s=>{
  const result=await runtime.signOut(s,{transport:async(url,opts)=>{
   if(url.endsWith('openid-configuration')) return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/jwks',revocation_endpoint:'https://auth.openai.com/revoke'});
   assert.equal(url,'https://auth.openai.com/revoke');assert.equal(opts.body.get('token_type_hint'),'refresh_token');
   return new Response('',{status:ok?200:503});
  }});
  assert.equal(result.revoked,ok);assert.equal((await s.read()).access_token,undefined);assert.equal((await s.read()).client_id,'oaiapp_test');
 });
});
test('SSE frame delimiters split across network chunks still reach completed event',async()=>{
 await fixture(async s=>{
  const chunks=['data: {"type":"response.completed"}\r','\n\r','\n'];
  const body=new ReadableStream({start(c){for(const part of chunks)c.enqueue(new TextEncoder().encode(part));c.close();}});
  assert.equal((await runtime.infer(s,input,{supportVerified:true,transport:async()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}})})).state,'SUCCEEDED');
 });
});
