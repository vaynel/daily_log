import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,link,symlink,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from './auth.mjs';
const windows={skip:process.platform!=='win32'};
// Real NTFS / DPAPI only. A platform string is never Windows storage evidence.
test('Windows CurrentUser storage encrypts, persists, locks, rejects links and corruption, and deletes',windows,async()=>{
 const base=await mkdtemp(resolve('data/windows-'));
 const dir=join(base,'daily-log-siwc');const store=new Store(dir);
 try {
  const host=await store.init();assert.equal(await new Store(dir).init(),host);
  const record={client_id:'oaiapp_test',subject:'synthetic',access_token:'synthetic-secret',state:'WAIT_PERMISSION'};
  await store.save(record);assert.deepEqual(await new Store(dir).read(),record);
  const bytes=await readFile(join(dir,'session.json'));assert.equal(bytes.includes(Buffer.from('synthetic-secret')),false);
  await assert.rejects(store.save({...record,subject:'another'}),/ACCOUNT_MISMATCH/);
  let release;const held=store.lock(()=>new Promise(r=>{release=r;}));
  while(!release)await new Promise(r=>setTimeout(r,10));
  try{await assert.rejects(new Store(dir).save(record));await assert.rejects(rename(dir,dir+'-moved'));}finally{release();await held;}
  await link(join(dir,'.lock'),join(dir,'lock-alias'));await assert.rejects(store.read());await rm(join(dir,'lock-alias'));
  await link(join(dir,'session.json'),join(dir,'alias'));await assert.rejects(store.read());await rm(join(dir,'alias'));
  await writeFile(join(dir,'session.json'),Buffer.from('corrupt'));await assert.rejects(store.read());
  await rm(join(dir,'session.json'));await store.save(record);
  await store.forget();assert.equal(await store.read(),null);assert.equal(await store.init(),host);
  const junction=join(base,'junction');await symlink(dir,junction,'junction');await assert.rejects(new Store(junction).init());await assert.rejects(new Store(join(junction,'nested')).init());
  await symlink(dir,join(dir,'session.json'),'junction');await assert.rejects(store.read());await rm(join(dir,'session.json'));
  await store.save(record);
  execFileSync(join(process.env.SystemRoot,'System32','icacls.exe'),[join(dir,'session.json'),'/grant','*S-1-1-0:(R)'],{stdio:'ignore'});
  await assert.rejects(store.read());await assert.rejects(store.forget());await rm(join(dir,'session.json'));
  execFileSync(join(process.env.SystemRoot,'System32','icacls.exe'),[dir,'/grant','*S-1-1-0:(OI)(CI)(R)'],{stdio:'ignore'});await assert.rejects(store.init());
 }finally{await rm(base,{recursive:true,force:true});}
});
test('Windows transaction survives rejected oversize write without truncating the prior session',windows,async()=>{
 const base=await mkdtemp(resolve('data/windows-write-'));const store=new Store(join(base,'store'));
 try {
  await store.init();const saved={client_id:'oaiapp_test',subject:'synthetic',state:'WAIT_PERMISSION'};await store.save(saved);
  await assert.rejects(store.save({...saved,access_token:'x'.repeat(70000)}),/STORAGE_TOO_LARGE/);
  assert.deepEqual(await new Store(store.dir).read(),saved);
 }finally{await rm(base,{recursive:true,force:true});}
});
test('Windows lock is released after the Node owner exits inside a transaction',windows,async()=>{
 const base=await mkdtemp(resolve('data/windows-crash-'));const dir=join(base,'store');
 try {
  execFileSync(process.execPath,['--input-type=module','-e',`import {Store} from ${JSON.stringify(new URL('./auth.mjs',import.meta.url).href)};await new Store(${JSON.stringify(dir)}).lock(()=>process.exit(0));`],{stdio:'pipe',timeout:30000});
  let host;
  for(let i=0;i<10;i++) {
   try{host=await new Store(dir).init();break;}catch{await new Promise(r=>setTimeout(r,300));}
  }
  assert.match(host??'',/^urn:uuid:/);
 }finally{await rm(base,{recursive:true,force:true});}
});
