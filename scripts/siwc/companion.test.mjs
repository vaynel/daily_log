import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from './auth.mjs';
const api=await import('./companion.mjs').catch(()=>({}));
test('loopback demo cannot contact OpenAI; cross-origin start denied; cancel invalidates callback and secrets never render',async()=>{
 assert.equal(typeof api.startCompanion,'function');
 const base=await mkdtemp(resolve('data/siwc-companion-'));const dir=resolve(base,'store');let calls=0;
 const app=await api.startCompanion(new Store(dir),{transport:async()=>{calls++;throw Error('synthetic-secret');}});
 try {
  const page=await (await fetch(app.url)).text();assert.match(page,/Continue with ChatGPT/);assert.match(page,/미연결/);
  const csrf=page.match(/name="csrf" value="([^"]+)"/)[1];
  const base=new URL(app.url).origin;
  assert.equal((await fetch(`${base}/start`,{method:'POST',headers:{Origin:'https://evil.example'},body:new URLSearchParams({csrf}),redirect:'manual'})).status,403);
  assert.equal((await fetch(`${base}/start`,{method:'POST',headers:{Origin:base},body:new URLSearchParams({csrf}),redirect:'manual'})).status,409);
  assert.equal(calls,0);
  assert.equal((await fetch(`${base}/cancel`,{method:'POST',headers:{Origin:base},body:new URLSearchParams({csrf})})).status,200);
  assert.equal((await fetch(`${base}/auth/callback?code=synthetic-secret&state=bad`)).status,400);
  const html=await(await fetch(app.url)).text();assert.equal(html.includes('synthetic-secret'),false);assert.equal(calls,0);
 } finally {await app.close();await rm(base,{recursive:true,force:true});}
});
test('explicit enabled button starts OAuth only after click, matching state denial makes zero token calls',async()=>{
 assert.equal(typeof api.startCompanion,'function');
 const base=await mkdtemp(resolve('data/siwc-companion-'));const dir=resolve(base,'store');let calls=0;
 const app=await api.startCompanion(new Store(dir),{allowLogin:true,transport:async()=>{calls++;throw Error('must not call');}});
 try {
  const base=new URL(app.url).origin;const page=await(await fetch(app.url)).text();const csrf=page.match(/name="csrf" value="([^"]+)"/)[1];
  const r=await fetch(`${base}/start`,{method:'POST',headers:{Origin:base},body:new URLSearchParams({csrf}),redirect:'manual'});
  assert.equal(r.status,303);const u=new URL(r.headers.get('location'));assert.equal(u.origin,'https://auth.openai.com');
  assert.equal(u.searchParams.has('id_token_hint'),false);
  assert.equal((await fetch(`${base}/auth/callback?error=access_denied&state=${u.searchParams.get('state')}`)).status,400);
  assert.equal(calls,0);assert.equal(await new Store(dir).read(),null);
 } finally {await app.close();await rm(base,{recursive:true,force:true});}
});
test('permission-enable button is explicit, click required, and cancellation preserves waiting credentials',async()=>{
 const base=await mkdtemp(resolve('data/siwc-consent-'));const dir=resolve(base,'store');const store=new Store(dir);await store.init();
 const saved={version:1,client_id:'oaiapp_test',subject:'synthetic-user',scopes:['openid'],state:'WAIT_PERMISSION'};
 await store.save(saved);let calls=0;
 const app=await api.startCompanion(store,{allowLogin:true,transport:async()=>{calls++;throw Error('forbidden');}});
 try {
  const page=await(await fetch(app.url)).text();assert.match(page,/ChatGPT 사용 권한 활성화/);assert.match(page,/제품 연결은 미검증/);assert.equal(calls,0);
  const csrf=page.match(/name="csrf" value="([^"]+)"/)[1],base=new URL(app.url).origin;
  const r=await fetch(`${base}/start`,{method:'POST',headers:{Origin:base},body:new URLSearchParams({csrf}),redirect:'manual'});
  assert.equal(r.status,303);const u=new URL(r.headers.get('location'));assert.equal(u.searchParams.get('prompt'),'consent');
  assert.equal((await fetch(`${base}/auth/callback?error=access_denied&state=${u.searchParams.get('state')}`)).status,400);
  assert.deepEqual(await store.read(),saved);assert.equal(calls,0);
  await store.save({...saved,state:'READY'});
  const normal=await(await fetch(app.url)).text();assert.match(normal,/Continue with ChatGPT/);assert.doesNotMatch(normal,/ChatGPT 사용 권한 활성화/);
 }finally{await app.close();await rm(base,{recursive:true,force:true});}
});
