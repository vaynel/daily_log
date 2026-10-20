#!/usr/bin/env node
import {appDirectory} from './siwc/paths.mjs';
import { Store,getJwks } from './siwc/auth.mjs';
import {startCompanion} from './siwc/companion.mjs';
import {refresh,signOut} from './siwc/runtime.mjs';
const [command='help',...args]=process.argv.slice(2);
const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const dir=value('--dir');
async function main() {
 if(command==='help') {console.log('daily_log SIWC: init | demo | login --personal-oss | status | forget | import --file PATH | refresh | signout; 모든 명령에 --dir APP_DIRECTORY 필요. docs/auth/task-53-siwc.md 참고.');return;}
 const store=new Store(appDirectory(dir));
 if(command==='init') {await store.init();console.log('HOST_READY');}
 else if(command==='status') {const r=await store.read();console.log(JSON.stringify({credentials:r?.state??'WAIT_AUTH',productConnection:'NOT_VERIFIED',paidFallback:false}));}
 else if(command==='demo' || command==='login') {
  if(command==='login' && !args.includes('--personal-oss')) throw Error('PERSONAL_OSS_REQUIRED');
  const app=await startCompanion(store,{allowLogin:command==='login'});
  console.log(`이 컴퓨터의 브라우저에서 열기: ${app.url}`);
  const timer=setTimeout(()=>app.close(),10*60*1000);timer.unref();
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{clearTimeout(timer);await app.close();});
 } else if(command==='import') {
  if(process.platform==='win32') throw Error('WINDOWS_IMPORT_UNSUPPORTED');
  if(!value('--file')) throw Error('FILE_REQUIRED');
  await store.importFile(value('--file'),await getJwks());console.log('CREDENTIALS_IMPORTED_PRODUCT_NOT_VERIFIED');
 } else if(command==='forget') {await store.forget();console.log('LOCAL_SESSION_REMOVED_REMOTE_REVOCATION_NOT_CONFIRMED');}
 else if(command==='refresh') console.log(JSON.stringify(await refresh(store)));
 else if(command==='signout') {const result=await signOut(store);console.log(JSON.stringify(result));if(!result.revoked) console.log('원격 해지 미확인: ChatGPT 설정에서 daily_log 연결을 해제하세요.');}
 else throw Error('COMMAND_INVALID');
}
main().catch(()=>{console.error('SIWC_STOPPED: 명령·저장 권한·잠금·네트워크를 확인하세요. 비밀값을 출력하지 않습니다.');process.exitCode=1;});
