import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink, rmdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const fail = code => { throw new Error(code); };
const random = () => randomBytes(32).toString('base64url');
const issued = x => typeof x === 'string' && /^oaiapp_[A-Za-z0-9_-]+$/.test(x);
export function createAttempt(hostId, redirectUri, selected = null) {
 const uri = new URL(redirectUri);
 if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || uri.pathname !== '/auth/callback' || uri.search || uri.hash || uri.username || uri.password) fail('CALLBACK_INVALID');
 if (selected && !issued(selected.client_id)) fail('CLIENT_INVALID');
 const a = { state:random(), nonce:random(), verifier:random(), redirectUri, expiresAt:Date.now()+600000, clientId:selected?.client_id ?? null, subject:selected?.subject };
 const params = { client_id:a.clientId ?? 'dynamic_agent_client', ext_agent_host_id:hostId, response_type:'code', redirect_uri:redirectUri, scope:SCOPES, resource:RESOURCE, state:a.state, nonce:a.nonce, code_challenge_method:'S256', code_challenge:createHash('sha256').update(a.verifier).digest('base64url') };
 if (!a.clientId) params.agent_name_hint = 'daily_log';
 // Task policy deliberately omits all account/token hints from URLs.
 a.url = `${ISSUER}/api/accounts/authorize?${new URLSearchParams(params)}`;
 return a;
}
export function consumeCallback(a, params) {
 if (!a || a.used || a.expiresAt <= Date.now()) fail('ATTEMPT_EXPIRED');
 a.used = true;
 for (const key of params.keys()) if (params.getAll(key).length !== 1) fail('CALLBACK_INVALID');
 if (params.get('state') !== a.state) fail('STATE_INVALID');
 if (params.has('error')) fail('CONSENT_CANCELLED');
 const clientId = params.get('client_id') || a.clientId;
 if (!issued(clientId) || (a.clientId && a.clientId !== clientId) || !params.get('code')) fail('CLIENT_INVALID');
 a.clientId = clientId;
 return { clientId, code:params.get('code') };
}
export function validateIdentity(token, { clientId, nonce, jwks, subject }) {
 try {
  const parts=token.split('.'); if(parts.length!==3) fail('TOKEN_INVALID');
  const h=JSON.parse(Buffer.from(parts[0],'base64url'));
  const p=JSON.parse(Buffer.from(parts[1],'base64url'));
  if(h.alg!=='RS256' || h.crit || !issued(clientId)) fail('TOKEN_INVALID');
  const keys=jwks.keys.filter(k=>k.kid===h.kid && k.kty==='RSA' && (!k.use || k.use==='sig') && (!k.alg || k.alg==='RS256'));
  if(keys.length!==1 || !verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key:keys[0],format:'jwk'}),Buffer.from(parts[2],'base64url'))) fail('TOKEN_INVALID');
  const now=Date.now()/1000;
  const audiences=Array.isArray(p.aud)?p.aud:[p.aud];
  if(p.iss!==ISSUER || !audiences.includes(clientId) || (audiences.length>1 && p.azp!==clientId) || (p.azp && p.azp!==clientId) || !Number.isFinite(p.exp) || p.exp<=now || (p.nbf && p.nbf>now) || !Number.isFinite(p.iat) || p.iat>now+60 || typeof p.sub!=='string' || !p.sub || (nonce!==undefined && p.nonce!==nonce) || (subject && p.sub!==subject)) fail('TOKEN_INVALID');
  return p;
 } catch { fail('TOKEN_INVALID'); }
}
export function validateTokens(t, opts) {
 const identity=validateIdentity(t.id_token,opts);
 if(t.token_type?.toLowerCase()!=='bearer' || typeof t.access_token!=='string' || !t.access_token || typeof t.refresh_token!=='string' || !t.refresh_token || !Number.isFinite(t.expires_in) || t.expires_in<=0 || typeof t.scope!=='string') fail('TOKEN_INVALID');
 const scopes=t.scope.split(/\s+/);
 return { version:1, issuer:ISSUER, client_id:opts.clientId, subject:identity.sub, id_token:t.id_token, access_token:t.access_token, refresh_token:t.refresh_token, token_type:'Bearer', expires_at:Date.now()+t.expires_in*1000, scopes, state:scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke')?'READY':'WAIT_PERMISSION' };
}
export async function request(url, options = {}) {
 return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
}
export async function getMetadata(transport=request) {
 const res=await transport(`${ISSUER}/.well-known/openid-configuration`);
 if(!res.ok) fail('DISCOVERY_UNAVAILABLE');
 const m=await res.json();
 if(m.issuer!==ISSUER) fail('DISCOVERY_INVALID');
 for(const k of ['jwks_uri','revocation_endpoint']) {
  const u=new URL(m[k]); if(u.origin!==ISSUER || u.username || u.password || u.hash) fail('DISCOVERY_INVALID');
 }
 return m;
}
export async function getJwks(transport=request) {
 const m=await getMetadata(transport); const r=await transport(m.jwks_uri);
 if(!r.ok) fail('JWKS_UNAVAILABLE'); return r.json();
}
export async function exchange(a, callback, transport=request) {
 const {clientId,code}=consumeCallback(a,callback);
 const r=await transport(TOKEN_URL,{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:a.verifier,redirect_uri:a.redirectUri,resource:RESOURCE})});
 if(!r.ok) fail('EXCHANGE_FAILED');
 return validateTokens(await r.json(),{clientId,nonce:a.nonce,subject:a.subject,jwks:await getJwks(transport)});
}
async function protectedRead(path) {
 const f=await open(path,'r');
 try {
  const s=await f.stat(), ls=await lstat(path);
  if(!s.isFile() || ls.isSymbolicLink() || s.nlink!==1 || (s.mode & 0o077) || s.uid!==process.getuid() || s.size>65536) fail('STORAGE_UNSAFE');
  return JSON.parse(await f.readFile('utf8'));
 } finally {await f.close();}
}
export class Store {
 constructor(dir) {this.dir=resolve(dir);}
 async secureDir() {
  if(process.platform==='win32') fail('STORAGE_UNSUPPORTED_USE_LINUX');
  await mkdir(this.dir,{recursive:true,mode:0o700});
  const s=await lstat(this.dir);
  if(!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid!==process.getuid() || await realpath(this.dir)!==this.dir) fail('STORAGE_UNSAFE');
 }
 async lock(fn) {
  await this.secureDir(); const path=join(this.dir,'.lock');
  try {await mkdir(path,{mode:0o700});} catch {fail('STORE_BUSY');}
  try {return await fn();} finally {await rmdir(path);}
 }
 async atomic(name,value) {
  const path=join(this.dir,`${name}.${randomUUID()}.tmp`); const f=await open(path,'wx',0o600);
  try {await f.writeFile(JSON.stringify(value));await f.sync();} finally {await f.close();}
  try {await rename(path,join(this.dir,name));} finally {await unlink(path).catch(()=>{});}
 }
 async hostUnlocked() {
  try {const h=await protectedRead(join(this.dir,'host.json')); if(!/^urn:uuid:[0-9a-f-]{36}$/.test(h.id)) fail('HOST_INVALID');return h.id;}
  catch(e) {if(e.code!=='ENOENT') throw e; const id=`urn:uuid:${randomUUID()}`;await this.atomic('host.json',{id});return id;}
 }
 async init() {return this.lock(()=>this.hostUnlocked());}
 async read() {
  await this.secureDir();
  try {return await protectedRead(join(this.dir,'session.json'));} catch(e) {if(e.code==='ENOENT') return null;throw e;}
 }
 async saveUnlocked(record) {
  const old=await this.read();
  if(old && (old.client_id!==record.client_id || old.subject!==record.subject)) fail('ACCOUNT_MISMATCH');
  await this.atomic('session.json',record);
 }
 async save(record) {return this.lock(()=>this.saveUnlocked(record));}
 async importFile(file,jwks) {
  return this.lock(async()=>{
   await this.hostUnlocked(); const r=await protectedRead(resolve(file));
   validateIdentity(r.id_token,{clientId:r.client_id,subject:r.subject,jwks});
   if(r.version!==1 || r.issuer!==ISSUER || !Array.isArray(r.scopes) || !r.access_token || !r.refresh_token || !Number.isFinite(r.expires_at) || r.expires_at<=Date.now()) fail('IMPORT_INVALID');
   // Imported local status is not proof of a successful product inference.
   await this.saveUnlocked({...r,state:r.scopes.includes('chatgpt.tokens.use.direct') && r.scopes.includes('resource.invoke')?'READY':'WAIT_PERMISSION'});
  });
 }
}
