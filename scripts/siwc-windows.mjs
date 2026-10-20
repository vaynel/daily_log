import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {appDirectory} from './siwc/paths.mjs';
async function main() {
 if(Number(process.versions.node.split('.')[0])<22) throw Error('NODE_22_REQUIRED');
 if(process.platform!=='win32') throw Error('WINDOWS_REQUIRED');
 if(!process.env.LOCALAPPDATA) throw Error('LOCALAPPDATA_REQUIRED');
 const dir=appDirectory(join(process.env.LOCALAPPDATA,'daily-log-siwc'));
 if(process.argv[2]==='--check'){console.log('WINDOWS_READY: Node 22+ 확인. 저장소/로그인은 아직 검증하지 않았습니다.');return;}
 if(process.argv.length>2) throw Error('ARGUMENT_INVALID');
 console.log('daily_log · Windows 계정 도우미 (검수 전 준비판)\n1: 안전한 데모  2: 상태 확인  3: 실제 로그인 준비  4: 로컬 세션 삭제\n실제 계정·제품 연결은 TASK-4에서 별도 검증합니다. 유료 자동 전환 없음.');
 const input=createInterface({input:process.stdin,output:process.stdout});let command;
 try {
  const choice=(await input.question('선택 [기본 1]: ')).trim()||'1';
  command=({'1':'demo','2':'status','3':'login','4':'forget'})[choice];
  if(!command)throw Error('CHOICE_INVALID');
  if(command==='login' && (await input.question('독립 검수 후 개인 OSS 이용 조건을 확인했을 때만 LOGIN 입력: '))!=='LOGIN')return;
  if(command==='forget' && (await input.question('원격 권한은 해지되지 않습니다. 로컬 삭제하려면 DELETE 입력: '))!=='DELETE')return;
 } finally {input.close();}
 const args=[fileURLToPath(new URL('./siwc-cli.mjs',import.meta.url)),command,'--dir',dir];
 if(command==='login')args.push('--personal-oss');
 // No shell and no automatic browser launch. OAuth begins only from the local page button.
 const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:false});
 child.on('error',()=>{console.error('START_FAILED');process.exitCode=1;});
 child.on('exit',code=>{process.exitCode=code??1;});
}
main().catch(error=>{console.error(['WINDOWS_REQUIRED','NODE_22_REQUIRED','LOCALAPPDATA_REQUIRED'].includes(error.message)?error.message:'START_STOPPED: 입력·보호 경로·실행 환경을 확인하세요.');process.exitCode=1;});
