import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fail=code=>{throw new Error(code);};
export const IMPORT_OK='CREDENTIALS_IMPORTED_PRODUCT_NOT_VERIFIED', IMPORT_CURRENT='CREDENTIALS_ALREADY_CURRENT';
const TARGET=/^[A-Za-z_][A-Za-z0-9_.-]{0,31}@(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/;
const HOSTKEY=/^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;
const REMOTE_PATH=/^\/[A-Za-z0-9._/-]{1,200}$/;
export function validateHandoff({target,hostKey,remoteRepo,remoteDir,port=22}) {
 if(!TARGET.test(target??'')) fail('TARGET_INVALID');
 // The user copies the public host key from the approved server; it pins the destination.
 if(!HOSTKEY.test(hostKey??'')) fail('HOST_KEY_INVALID');
 for(const p of [remoteRepo,remoteDir]) if(!REMOTE_PATH.test(p??'') || p.split('/').includes('..')) fail('REMOTE_PATH_INVALID');
 if(!Number.isInteger(port) || port<1 || port>65535) fail('PORT_INVALID');
}
function runSsh(args,payload,{spawnFn=spawn,exe='ssh'}={}) {
 return new Promise(resolve=>{
  let out='',done=false;
  const end=r=>{if(!done){done=true;clearTimeout(timer);resolve(r);}};
  let child;
  try {child=spawnFn(exe,args,{stdio:['pipe','pipe','ignore'],windowsHide:true});} catch {return end({ok:false,code:'SSH_UNAVAILABLE'});}
  const timer=setTimeout(()=>{child.kill();end({ok:false,code:'SSH_TIMEOUT'});},60000);
  child.on('error',()=>end({ok:false,code:'SSH_UNAVAILABLE'}));
  child.stdout.on('data',d=>{if(out.length<4096)out+=d;});
  child.stdin.on('error',()=>{});
  child.on('close',code=>end({ok:code===0,code:code===0?'EXIT_0':'SSH_FAILED',out}));
  child.stdin.end(payload);
 });
}
// Sends the single local session over an SSH stdin pipe to the verified server and retires the
// local copy only after the server confirmed. Failure keeps the local session; a retry after an
// unknown outcome is idempotent because the server answers ALREADY_CURRENT.
export async function sendHandoff(store,opts,{confirm,run=runSsh,spawnFn,now=Date.now}={}) {
 validateHandoff(opts);
 if(typeof confirm!=='function' || await confirm({target:opts.target,port:opts.port??22})!==true) return {state:'CANCELLED'};
 const dir=await mkdtemp(join(tmpdir(),'daily-log-hostkey-'));
 try {
  return await store.lock(async()=>{
   const r=await store.read();
   if(!r) return {state:'WAIT_AUTH'};
   if(r.state!=='READY') return {state:r.state};
   if(!r.refresh_token || !r.access_token || r.expires_at<=now()+60000) return {state:'WAIT_AUTH'};
   const hostName=opts.target.slice(opts.target.indexOf('@')+1).replace(/^\[|\]$/g,'');
   const known=join(dir,'known_hosts');
   await writeFile(known,`${(opts.port??22)===22?hostName:`[${hostName}]:${opts.port}`} ${opts.hostKey}\n`,{mode:0o600});
   const args=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile="${known.replaceAll('\\','/')}"`,'-o','GlobalKnownHostsFile=none','-o','ClearAllForwardings=yes','-o','ConnectTimeout=15','-p',String(opts.port??22),'--',opts.target,
    `cd ${opts.remoteRepo} && npm run --silent siwc -- import --stdin --dir ${opts.remoteDir}`];
   const res=await run(args,JSON.stringify(r),{spawnFn});
   if(!res.ok) return {state:'TRANSFER_FAILED',code:res.code,localKept:true};
   const marker=String(res.out??'');
   if(!marker.includes(IMPORT_OK) && !marker.includes(IMPORT_CURRENT)) return {state:'TRANSFER_UNCONFIRMED',localKept:true};
   await store.retireUnlocked();
   return {state:'TRANSFERRED',already:marker.includes(IMPORT_CURRENT),productConnection:'NOT_VERIFIED'};
  });
 } finally {await rm(dir,{recursive:true,force:true});}
}
