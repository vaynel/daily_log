#!/usr/bin/env node
import {appDirectory} from './siwc/paths.mjs';
import { Store,getJwks } from './siwc/auth.mjs';
import {startCompanion} from './siwc/companion.mjs';
import {refresh,reconcile,signOut} from './siwc/runtime.mjs';
import {sendHandoff,IMPORT_OK,IMPORT_CURRENT} from './siwc/handoff.mjs';
import {createInterface} from 'node:readline/promises';
const [command='help',...args]=process.argv.slice(2);
const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const dir=value('--dir');
async function main() {
 if(command==='help') {console.log('daily_log SIWC: init | demo | login --personal-oss | status | forget | import --file PATH 또는 --stdin | handoff --target USER@HOST --host-key "ssh-ed25519 …" --remote-repo PATH --remote-dir PATH [--port N] | refresh | reconcile --confirm | signout; 모든 명령에 --dir APP_DIRECTORY 필요. docs/auth/task-53-siwc.md 참고.');return;}
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
  if(args.includes('--stdin')) {
   let text='';for await(const chunk of process.stdin) {text+=chunk;if(text.length>65536) throw Error('IMPORT_INVALID');}
   const {result}=await store.importText(text,await getJwks());
   console.log(result==='ALREADY_CURRENT'?IMPORT_CURRENT:IMPORT_OK);
  } else {
   if(!value('--file')) throw Error('FILE_REQUIRED');
   await store.importFile(value('--file'),await getJwks());console.log(IMPORT_OK);
  }
 } else if(command==='handoff') {
  const port=value('--port')===undefined?22:Number(value('--port'));
  const opts={target:value('--target'),hostKey:value('--host-key'),remoteRepo:value('--remote-repo'),remoteDir:value('--remote-dir'),port};
  const confirm=async({target})=>{
   const rl=createInterface({input:process.stdin,output:process.stdout});
   try {return (await rl.question(`${target} 서버로 로그인 자격증명을 SSH로 전달하고 이 PC의 로컬 세션을 삭제합니다. 진행하려면 SEND 입력: `)).trim()==='SEND';} finally {rl.close();}
  };
  const result=await sendHandoff(store,opts,{confirm});
  console.log(JSON.stringify({...result,paidFallback:false}));
  if(result.state!=='TRANSFERRED') process.exitCode=1;
 } else if(command==='forget') {await store.forget();console.log('LOCAL_SESSION_REMOVED_REMOTE_REVOCATION_NOT_CONFIRMED');}
 else if(command==='reconcile') {
  const result=await reconcile(store,{confirm:args.includes('--confirm')});
  console.log(JSON.stringify({...result,paidFallback:false}));
  if(result.state==='CONFIRM_REQUIRED') {console.log('응답 유실 여부를 사람이 확인한 뒤 --confirm 으로 다시 실행하세요. 자동 재전송은 없습니다.');process.exitCode=1;}
 }
 else if(command==='refresh') console.log(JSON.stringify(await refresh(store)));
 else if(command==='signout') {const result=await signOut(store);console.log(JSON.stringify(result));if(!result.revoked) console.log('원격 해지 미확인: ChatGPT 설정에서 daily_log 연결을 해제하세요.');}
 else throw Error('COMMAND_INVALID');
}
main().catch(()=>{console.error('SIWC_STOPPED: 명령·저장 권한·잠금·네트워크를 확인하세요. 비밀값을 출력하지 않습니다.');process.exitCode=1;});
