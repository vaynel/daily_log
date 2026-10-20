import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
// Plaintext crosses only anonymous pipes. Never include input/output in thrown errors.
export async function openWindowsStore(dir) {
 if(process.platform!=='win32') throw Error('WINDOWS_REQUIRED');
 const exe=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',fileURLToPath(new URL('./windows/store.ps1',import.meta.url))],{stdio:['pipe','pipe','ignore'],windowsHide:true});
 const closed=new Promise(resolve=>child.once('close',resolve));
 let pending,failed=false;
 const stop=()=>{failed=true;if(pending){clearTimeout(pending.timer);pending.reject(Error('STORAGE_UNSAFE_OR_BUSY'));pending=null;}};
 child.on('error',stop);child.on('exit',stop);child.stdin.on('error',stop);
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{
  if(!pending || line.length>100000 || line.startsWith('ERROR')){stop();child.kill();return;}
  const p=pending;pending=null;clearTimeout(p.timer);p.resolve(line);
 });
 const send=message=>new Promise((resolve,reject)=>{
  if(failed || pending){reject(Error('STORAGE_UNSAFE_OR_BUSY'));return;}
  const timer=setTimeout(()=>{stop();child.kill();},15000);
  pending={resolve,reject,timer};child.stdin.write(message+'\n');
 });
 const close=async()=>{
  lines.close();child.stdin.end();
  const timer=setTimeout(()=>child.kill(),2000);
  try {await closed;} finally {clearTimeout(timer);}
 };
 try {if(await send(Buffer.from(dir).toString('base64'))!=='READY')throw Error('STORAGE_UNSAFE');}
 catch(e){await close();throw e;}
 return {
  async read(name){const r=await send(`R ${name}`);if(r==='NULL')return null;if(!r.startsWith('VALUE '))throw Error('STORAGE_UNSAFE');try{return JSON.parse(Buffer.from(r.slice(6),'base64').toString('utf8'));}catch{throw Error('STORAGE_INVALID');}},
  async write(name,value){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>65536)throw Error('STORAGE_TOO_LARGE');if(await send(`W ${name} ${bytes.toString('base64')}`)!=='OK')throw Error('STORAGE_UNSAFE');},
  async forget(){if(await send('D session.json')!=='OK')throw Error('STORAGE_UNSAFE');},
  close
 };
}
