import { createServer } from 'node:http';
import {randomBytes} from 'node:crypto';
import {createAttempt,exchange,request} from './auth.mjs';
export async function startCompanion(store,{allowLogin=false,transport=request,port=0}={}) {
 const host=await store.init(), csrf=randomBytes(32).toString('hex');
 let attempt=null, status='미연결 — 실제 계정 동의와 제품 요청 검증 전입니다.', base, busy=false;
 const entry=`/session/${randomBytes(24).toString('hex')}`;
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'");
  const send=(code,text)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8'});res.end(text);};
  try {
   if(req.headers.host!==new URL(base).host) return send(403,'요청 거부');
   const u=new URL(req.url,base);
   const needsPermission=req.method==='GET' && u.pathname===entry && (await store.read())?.state==='WAIT_PERMISSION';
   if(req.method==='GET' && u.pathname===entry) return send(200,`<!doctype html><html lang="ko"><meta charset="utf-8"><title>daily_log 계정 연결 준비</title><h1>daily_log · ChatGPT 계정</h1><p>${needsPermission?'계정 확인됨 — ChatGPT 사용 권한이 없어 대기합니다. 아래 버튼을 누르면 권한 동의를 다시 요청합니다. 제품 연결은 미검증입니다.':status}</p><p>이 브라우저가 실행되는 컴퓨터에서 동의하세요. 휴대폰이나 원격 서버 브라우저로 이 주소를 열지 마세요.</p><p>${allowLogin?'버튼을 누르면 OpenAI에서 daily_log 앱 등록·계정·워크스페이스·권한을 확인합니다.':'안전한 로컬 데모입니다. 실제 로그인은 비활성화되어 있습니다.'}</p><form method="post" action="/start"><input type="hidden" name="csrf" value="${csrf}"><button>${needsPermission?'ChatGPT 사용 권한 활성화':'Continue with ChatGPT'}</button></form><form method="post" action="/cancel"><input type="hidden" name="csrf" value="${csrf}"><button>취소</button></form><p>유료 API 자동 전환 없음. 동의 후에도 TASK4에서 실제 제품 요청 검증이 필요합니다.</p></html>`);
   if(req.method==='POST' && ['/start','/cancel'].includes(u.pathname)) {
    if(req.headers.origin!==base || busy) return send(403,'요청 거부');
    let body='';for await(const chunk of req) {body+=chunk;if(body.length>1024) return send(413,'요청 거부');}
    if(new URLSearchParams(body).get('csrf')!==csrf) return send(403,'요청 거부');
    if(u.pathname==='/cancel') {attempt=null;status='취소됨 — 저장된 기존 계정은 유지됩니다.';return send(200,'취소됨. 이 창을 닫아도 됩니다.');}
    if(!allowLogin) return send(409,'데모 모드: 실제 로그인 비활성. 실행 안내를 확인하세요.');
    const selected=await store.read();
    attempt=createAttempt(host,`${base}/auth/callback`,selected);
    res.writeHead(303,{Location:attempt.url});return res.end();
   }
   if(req.method==='GET' && u.pathname==='/auth/callback') {
    if(busy || !attempt) return send(400,'로그인 시도가 없거나 만료되었습니다. 처음부터 다시 시작하세요.');
    const current=attempt;attempt=null;busy=true;
    try {
     const record=await exchange(current,u.searchParams,transport);await store.save(record);
     status=record.state==='READY'?'앱 전용 동의 검증·저장됨 — 제품 연결 검증은 아직 미완료입니다.':'계정 확인됨 — ChatGPT 사용 권한이 없어 대기합니다.';
     return send(200,status+' 이 창을 닫고 서버 전달 안내를 따르세요.');
    } catch {status='로그인 실패 또는 취소 — 기존 계정은 유지됩니다. 다시 시작하세요.';return send(400,status);}
    finally {busy=false;}
   }
   return send(404,'찾을 수 없음');
  } catch {return send(500,'안전하게 중단했습니다. 저장 경로·권한을 확인하세요.');}
 });
 await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
 base=`http://127.0.0.1:${server.address().port}`;
 return {url:base+entry,close:()=>new Promise((ok,no)=>server.close(e=>e?no(e):ok()))};
}
