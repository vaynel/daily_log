import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, stat, readFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
const auth = await import('./auth.mjs').catch(() => ({}));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' }] };
const now = Math.floor(Date.now() / 1000);
function jwt(claims = {}, key = privateKey) {
 const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic' })).toString('base64url');
 const p = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'synthetic-user', exp: now + 3600, iat: now, nonce: 'nonce', ...claims })).toString('base64url');
 return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
const tokens = (claims = {}) => ({ id_token: jwt(claims), access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct offline_access' });
const verifyOptions = { clientId: 'oaiapp_test', nonce: 'nonce', jwks };
test('PKCE sends fresh state/nonce and never tokens or hints in authorize URL', () => {
 assert.equal(typeof auth.createAttempt, 'function');
 const a = auth.createAttempt('urn:uuid:synthetic', 'http://127.0.0.1:1455/auth/callback');
 const b = auth.createAttempt('urn:uuid:synthetic', 'http://127.0.0.1:1455/auth/callback');
 assert.notEqual(a.state, b.state); assert.notEqual(a.nonce, b.nonce);
 const u = new URL(a.url); assert.equal(u.searchParams.get('client_id'), 'dynamic_agent_client');
 assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
 assert.equal(u.searchParams.has('id_token_hint'), false); assert.equal(u.searchParams.has('access_token'), false);
 assert.throws(() => auth.createAttempt('host', 'http://localhost:1455/auth/callback'));
});
test('callback rejects state, expiry, duplicate keys, replay and changed returning client before exchange', () => {
 assert.equal(typeof auth.consumeCallback, 'function');
 for (const query of ['state=wrong&code=x&client_id=oaiapp_test', 'state=S&state=S&code=x&client_id=oaiapp_test', 'state=S&code=x', 'state=S&error=access_denied']) {
  const a = { state:'S', expiresAt: Date.now()+60000, clientId: null };
  assert.throws(() => auth.consumeCallback(a, new URLSearchParams(query)));
 }
 const a = { state:'S', expiresAt: Date.now()+60000, clientId:'oaiapp_test' };
 assert.throws(() => auth.consumeCallback(a, new URLSearchParams('state=S&code=x&client_id=oaiapp_other')));
 const b = { state:'S', expiresAt:Date.now()+60000, clientId:null };
 assert.equal(auth.consumeCallback(b,new URLSearchParams('state=S&code=x&client_id=oaiapp_test')).clientId,'oaiapp_test');
 assert.throws(() => auth.consumeCallback(b,new URLSearchParams('state=S&code=x&client_id=oaiapp_test')));
 assert.throws(() => auth.consumeCallback({ state:'S',expiresAt:0 },new URLSearchParams('state=S&code=x&client_id=oaiapp_test')));
});
test('signed identity rejects tampering, issuer, audience, nonce, expiry and account changes; missing grant cannot infer', () => {
 assert.equal(typeof auth.validateTokens, 'function');
 assert.equal(auth.validateTokens(tokens(),verifyOptions).subject,'synthetic-user');
 for (const c of [{ iss:'https://evil.example' },{aud:'other'},{nonce:'other'},{exp:now-1},{sub:''}]) assert.throws(() => auth.validateTokens(tokens(c),verifyOptions));
 const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
 assert.throws(() => auth.validateTokens({...tokens(),id_token:jwt({},otherKey)},verifyOptions));
 assert.throws(() => auth.validateTokens(tokens(),{...verifyOptions,subject:'other'}));
 assert.equal(auth.validateTokens({...tokens(),scope:'openid'},verifyOptions).state,'WAIT_PERMISSION');
});
test('protected atomic storage preserves host across import, excludes mismatched registrations, rejects insecure modes and serializes writers', async () => {
 assert.equal(typeof auth.Store, 'function');
 const base=await mkdtemp(resolve('data/siwc-store-'));
 try {
  const local=new auth.Store(`${base}/local`), remote=new auth.Store(`${base}/remote`);
  const h=await local.init(); assert.equal(await local.init(),h);
  const rh=await remote.init(); assert.notEqual(rh,h);
  const r=auth.validateTokens(tokens(),verifyOptions); await local.save(r);
  assert.equal((await stat(`${base}/local/session.json`)).mode & 0o777,0o600);
  await remote.importFile(`${base}/local/session.json`,jwks);
  assert.equal(await remote.init(),rh); assert.equal((await remote.read()).subject,'synthetic-user');
  await assert.rejects(remote.save({...r,subject:'other'}));
  let release; const held=remote.lock(async()=>await new Promise(r=>{release=r;}));
  while(!release) await new Promise(r=>setImmediate(r));
  await assert.rejects(remote.lock(async()=>{}),/BUSY/); release(); await held;
  await chmod(`${base}/local/session.json`,0o644); await assert.rejects(local.read(),/STORAGE/);
  assert.equal((await readFile(`${base}/remote/session.json`,'utf8')).includes('synthetic-user'),true);
 } finally { await rm(base,{recursive:true,force:true}); }
});
test('exchange binds actual nonce, issued client and exact redirect; failed verification never produces credentials',async()=>{
 const a=auth.createAttempt('urn:uuid:synthetic','http://127.0.0.1:54321/auth/callback');let posts=0;
 const transport=async(url,opts)=>{
  if(url===auth.TOKEN_URL){posts++;assert.equal(opts.body.get('client_id'),'oaiapp_test');assert.equal(opts.body.get('redirect_uri'),'http://127.0.0.1:54321/auth/callback');assert.equal(opts.body.get('code_verifier'),a.verifier);assert.equal(opts.body.has('client_secret'),false);return Response.json(tokens({nonce:a.nonce}));}
  if(url.endsWith('openid-configuration')) return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/jwks',revocation_endpoint:'https://auth.openai.com/revoke'});
  assert.equal(url,'https://auth.openai.com/jwks');return Response.json(jwks);
 };
 const params=new URLSearchParams({state:a.state,code:'synthetic-code',client_id:'oaiapp_test'});
 assert.equal((await auth.exchange(a,params,transport)).state,'READY');
 await assert.rejects(auth.exchange(a,params,transport));assert.equal(posts,1);
 const b=auth.createAttempt('urn:uuid:synthetic','http://127.0.0.1:54321/auth/callback',{client_id:'oaiapp_test',subject:'other'});
 const p=new URLSearchParams({state:b.state,code:'synthetic-code'});
 await assert.rejects(auth.exchange(b,p,async(url,opts)=>url===auth.TOKEN_URL?Response.json(tokens({nonce:b.nonce})):transport(url,opts)),/TOKEN_INVALID/);
});
test('import rejects forged signature and mismatched account before overwriting saved registration',async()=>{
 const base=await mkdtemp(resolve('data/siwc-import-'));
 try {
  const local=new auth.Store(`${base}/local`),remote=new auth.Store(`${base}/remote`);await local.init();await remote.init();
  const record=auth.validateTokens(tokens(),verifyOptions);await remote.save(record);
  await local.save({...record,id_token:jwt({sub:'attacker'})});
  await assert.rejects(remote.importFile(`${base}/local/session.json`,jwks));assert.equal((await remote.read()).subject,'synthetic-user');
  await local.save({...record,id_token:record.id_token.slice(0,-10)+'aaaaaaaaaa'});
  await assert.rejects(remote.importFile(`${base}/local/session.json`,jwks));
 }finally{await rm(base,{recursive:true,force:true});}
});
