import { TOKEN_URL, RESOURCE, request, getJwks, validateIdentity, getMetadata } from './auth.mjs';
const terminalRefresh=new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
function errorState(status,code) {
 if(code==='subscription_sharing_usage_limit_exceeded' || status===429) return 'WAIT_LIMIT';
 if(code==='subscription_sharing_unsupported_capability') return 'UNSUPPORTED_INPUT';
 if(code==='subscription_sharing_usage_unavailable' || code==='subscription_sharing_user_unavailable' || status>=500) return 'WAIT_RETRY';
 if(status===401 || code==='subscription_sharing_invalid_user') return 'WAIT_AUTH';
 if(status===403 || ['chatpass_v2_scope_not_authorized','chatpass_v2_invalid_authorization_context','subscription_sharing_user_not_eligible','subscription_sharing_route_not_supported'].includes(code)) return 'WAIT_SUPPORT';
 return 'WAIT_REVIEW';
}
async function wait(store,record,state,clear=false) {
 const next={...record,state};
 if(clear) {delete next.access_token;delete next.refresh_token;delete next.id_token;}
 await store.saveUnlocked(next);return {state};
}
// retryTransient lets the hand-off retry after WAIT_RETRY (tokens kept, request definitely not applied); WAIT_RECONCILIATION is never replayed.
export async function renewUnlocked(store,transport,{retryTransient=false}={}) {
 const r=await store.read(); if(!r) return {state:'WAIT_AUTH'};
 if(r.state!=='READY' && !(retryTransient && r.state==='WAIT_RETRY' && r.refresh_token)) return {state:r.state};
 if(r.expires_at>Date.now()+60000) return {state:'READY'};
 if(!r.refresh_token) return wait(store,r,'WAIT_AUTH',true);
 // Persist uncertainty before a possibly rotating request. A crash must never replay it.
 await wait(store,r,'WAIT_RECONCILIATION');
 try {
  const res=await transport(TOKEN_URL,{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:r.client_id,refresh_token:r.refresh_token,resource:RESOURCE})});
  const body=await res.json();
  if(!res.ok) {
   const code=typeof body.error==='string'?body.error:body.error?.code;
   return wait(store,r,terminalRefresh.has(code)?'WAIT_AUTH':code==='invalid_client'?'WAIT_SUPPORT':'WAIT_RETRY',terminalRefresh.has(code));
  }
  if(body.token_type?.toLowerCase()!=='bearer' || typeof body.access_token!=='string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in<=0 || (body.refresh_token!==undefined && (typeof body.refresh_token!=='string' || !body.refresh_token))) return wait(store,r,'WAIT_AUTH');
  if(body.id_token) validateIdentity(body.id_token,{clientId:r.client_id,subject:r.subject,jwks:await getJwks(transport)});
  const scopes=body.scope===undefined?r.scopes:typeof body.scope==='string'?body.scope.split(/\s+/):[];
  const state=scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke')?'READY':'WAIT_PERMISSION';
  await store.saveUnlocked({...r,access_token:body.access_token,refresh_token:body.refresh_token??r.refresh_token,id_token:body.id_token??r.id_token,expires_at:Date.now()+body.expires_in*1000,scopes,state});
  return {state};
 } catch {return wait(store,r,'WAIT_RECONCILIATION');}
}
export async function refresh(store,{transport=request}={}) {return store.lock(()=>renewUnlocked(store,transport));}
export async function infer(store,input,{supportVerified=false,transport=request}={}) {
 if(!supportVerified) return {state:'WAIT_SUPPORT'};
 if(typeof input.model!=='string' || !input.model.trim() || typeof input.text!=='string' || !input.text.trim()) return {state:'UNSUPPORTED_INPUT'};
 return store.lock(async()=>{
  const renewed=await renewUnlocked(store,transport);if(renewed.state!=='READY') return renewed;
  const r=await store.read();
  if(!r.scopes.includes('chatgpt.tokens.use.direct') || !r.scopes.includes('resource.invoke')) return wait(store,r,'WAIT_PERMISSION');
  await wait(store,r,'WAIT_RECONCILIATION');
  try {
   const res=await transport(`${RESOURCE}/responses`,{method:'POST',headers:{Authorization:`Bearer ${r.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({model:input.model,input:[{role:'user',content:input.text}],store:false,stream:true})});
   if(!res.ok) {
    const body=await res.json().catch(()=>({}));return wait(store,r,errorState(res.status,body.error?.code));
   }
   if(!res.headers.get('content-type')?.includes('text/event-stream') || !res.body) return wait(store,r,'WAIT_RECONCILIATION');
   let buffer='',text='',bytes=0;const decoder=new TextDecoder();
   for await(const chunk of res.body) {
    bytes+=chunk.length;if(bytes>4*1024*1024) return wait(store,r,'WAIT_REVIEW');
    buffer=(buffer+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');
    let end;
    while((end=buffer.indexOf('\n\n'))>=0) {
     const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
     const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
     if(!data || data==='[DONE]') continue;
     const e=JSON.parse(data);
     if(e.type==='response.output_text.delta' && typeof e.delta==='string') text+=e.delta;
     if(e.type==='response.failed' || e.type==='error') return wait(store,r,errorState(0,e.response?.error?.code??e.code??e.error?.code));
     if(e.type==='response.incomplete') return wait(store,r,'WAIT_REVIEW');
     if(e.type==='response.completed') {await store.saveUnlocked({...r,state:'READY'});return {state:'SUCCEEDED',text};}
    }
   }
   return wait(store,r,'WAIT_RECONCILIATION');
  } catch {return wait(store,r,'WAIT_RECONCILIATION');}
 });
}
export async function signOut(store,{transport=request}={}) {
 return store.lock(async()=>{
  const r=await store.read();if(!r) return {state:'WAIT_AUTH',revoked:false};
  await wait(store,r,'WAIT_AUTH');let revoked=false;
  try {
   const m=await getMetadata(transport);
   const res=await transport(m.revocation_endpoint,{method:'POST',body:new URLSearchParams({token:r.refresh_token,token_type_hint:'refresh_token',client_id:r.client_id})});revoked=res.status===200;
  } catch { /* No raw network errors or credentials in diagnostics. */ }
  await wait(store,r,'WAIT_AUTH',true);return {state:'WAIT_AUTH',revoked};
 });
}
