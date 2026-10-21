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
 console.log('daily_log · Windows 계정 도우미 (검수 전 준비판)\n1: 안전한 데모  2: 상태 확인  3: 실제 로그인 준비  4: 로컬 세션 삭제  5: 서버로 안전 전달\n실제 계정·제품 연결은 TASK-4에서 별도 검증합니다. 유료 자동 전환 없음.');
 const input=createInterface({input:process.stdin,output:process.stdout});let command;const extra=[];
 try {
  const choice=(await input.question('선택 [기본 1]: ')).trim()||'1';
  command=({'1':'demo','2':'status','3':'login','4':'forget','5':'handoff'})[choice];
  if(!command)throw Error('CHOICE_INVALID');
  if(command==='login' && (await input.question('독립 검수 후 개인 OSS 이용 조건을 확인했을 때만 LOGIN 입력: '))!=='LOGIN')return;
  if(command==='forget' && (await input.question('원격 권한은 해지되지 않습니다. 로컬 삭제하려면 DELETE 입력: '))!=='DELETE')return;
 if(command==='handoff') {
   console.log('Windows OpenSSH 클라이언트(ssh)와 키 기반 로그인이 필요합니다. 비밀번호·토큰은 입력하지 않습니다. 서버의 공개 호스트키는 서버에서 `cat /etc/ssh/ssh_host_ed25519_key.pub`로 확인한 "ssh-ed25519 AAAA…" 두 단어입니다.');
   for(const [key,label] of [['--target','서버 계정@주소'],['--host-key','서버 공개 호스트키(ssh-ed25519 AAAA…)'],['--remote-repo','서버의 daily_log 절대 경로'],['--remote-dir','서버의 SIWC 저장 절대 경로(daily-log-siwc 포함)']]) extra.push(key,(await input.question(`${label}: `)).trim());
  }
 } finally {input.close();}
 const args=[fileURLToPath(new URL('./siwc-cli.mjs',import.meta.url)),command,'--dir',dir];
 if(command==='login')args.push('--personal-oss');
 if(command==='handoff')args.push(...extra);
 // No shell and no automatic browser launch. OAuth begins only from the local page button.
 const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:false});
 child.on('error',()=>{console.error('START_FAILED');process.exitCode=1;});
 child.on('exit',code=>{process.exitCode=code??1;});
}
main().catch(error=>{console.error(['WINDOWS_REQUIRED','NODE_22_REQUIRED','LOCALAPPDATA_REQUIRED'].includes(error.message)?error.message:'START_STOPPED: 입력·보호 경로·실행 환경을 확인하세요.');process.exitCode=1;});
