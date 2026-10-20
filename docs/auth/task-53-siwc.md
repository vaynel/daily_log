# TASK-53 · 앱 전용 SIWC 준비

2026-10-20. 이 문서는 **준비 구현**이다. 실제 계정 동의·제품 요청·재연결은 NOT_RUN이며 TASK4 후속에서 사용자가 검증한다. 기존 TASK4/QA45의 부분 판정을 바꾸지 않는다. 개발 Codex 로그인 성공은 제품 연결 성공이 아니다. 이 도우미는 Codex 인증 파일·환경 API 키를 읽지 않는다. 공개 배포 없음.

## 공식 근거와 허용 범위

직접 읽은 공식 문서:

- [등록과 로그인](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): OSS 동적 등록은 `dynamic_agent_client`로 시작하고 발급된 client ID로 교환한다. client secret/partner API key는 불필요하다. 사용자 동의와 계정·workspace에 귀속된 등록은 필요하다.
- [개요](https://developers.openai.com/siwc/token-sharing-open-source), [Quickstart](https://developers.openai.com/siwc/quickstart): OSS 플랜 사용과 제한적으로 제공되는 상용 파트너 웹 로그인은 구분한다. 이 구현의 대상은 사용자 소유 개인 OSS 실행 환경이다. 유료 remote SaaS·다중 고객 운영의 허가는 확인하지 않았으므로 차단한다.
- [Self-hosted VM](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): 사용자 컴퓨터에서 동의 후 같은 사용자·workspace의 보호된 자격증명을 SSH로 서버에 전달한다. 서버 고유 host ID를 유지하고 이후 갱신은 서버만 담당한다. 이동 세션의 host별 사용량 귀속·해지는 아직 제공되지 않는다.
- [계정·세션](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions): 등록별 저장, 갱신 직렬화, 회전 refresh token 교체, 원격 revoke와 로컬 비밀값 제거.
- [모델·추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): public Responses 경로, `store:false`, `stream:true`, 완료 이벤트 확인.
- [오류·복구](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery): 동의 부족·권한·한도·일시 장애를 구분. 다른 과금 경로로 자동 전환하지 않는다.
- [Preview 제약](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): 음성/영상 입력·transcription·Files upload 지원으로 확대하지 않는다. 이 준비 어댑터는 텍스트만 받는다. 이미지·첨부·음성은 TASK4 검증 전 미지원이다.

문서에 개인 OSS 경로가 있어도 daily_log 계정·workspace의 실제 적격성, 모델, 지역 정책, 부여 권한, 한도는 확인 전이다. `infer()`의 `supportVerified`는 기본 false이며 서버 내부에서 TASK4의 검증 근거에 따라 설정할 계약이다. 사용자 HTTP 입력으로 켜면 안 된다. 기존 worker/API에는 아직 연결하지 않았다. CLI status는 항상 `productConnection: NOT_VERIFIED`로 표시한다.

## 설치·컴퓨터에서 확인

Node.js 22+, Linux 또는 macOS(Unix 권한)에서 저장소의 `npm ci` 실행. Windows 직접 실행은 권한 보호 구현이 없어 차단한다. Windows/WSL 브라우저의 loopback 연결은 별도 검증 전이다. 저장소·종속성은 작업 공간 안에 둔다.

아래 예시는 이 작업 공간의 보호된 앱 전용 디렉터리이다. 계정 등록마다 별도 하위 디렉터리를 사용한다. 경로에는 `daily-log-siwc` 구성요소가 있어야 한다. 일반 auth.json, Codex 파일, API 키를 지정하거나 복사하지 않는다.

```sh
npm run siwc -- init --dir /workspace/data/daily-log-siwc/local-account-1
npm run siwc -- demo --dir /workspace/data/daily-log-siwc/local-account-1
```

표시된 로컬 주소를 **같은 컴퓨터의 브라우저**에서 연다. 데모의 Continue with ChatGPT 버튼은 외부 이동 없이 차단 안내만 보인다. 실제 동의는 사용자가 아래 명령을 실행한 뒤 버튼을 눌러 진행한다. worker는 이 명령을 실행하지 않았다.

```sh
npm run siwc -- login --personal-oss --dir /workspace/data/daily-log-siwc/local-account-1
```

| 사용자 동작 | 컴퓨터 / 휴대폰 | 확인할 내용 |
| --- | --- | --- |
| 로컬 명령과 주소 열기 | 컴퓨터 | 미연결 표시, 서버에 공개 포트 없음 |
| Continue with ChatGPT 클릭 | 같은 컴퓨터 | OpenAI 주소에서 daily_log 등록, 올바른 계정·workspace, 사용 권한·한도 확인 |
| 동의 또는 취소 | 같은 컴퓨터 | 동의하지 않으면 자격증명 저장·추론 없음 |
| 콜백 결과 | 같은 컴퓨터 | 계정 검증·저장 완료와 제품 요청 미검증을 구분 |
| 사용량·앱 해제 | 컴퓨터/휴대폰 ChatGPT 설정 | [Usage](https://chatgpt.com/settings/usage)와 앱 접근 권한 확인 |
| 실제 요청 3종 및 재연결 | TASK4 후속 | 사용자 승인 후 텍스트/요약/허용 첨부별 실제 결과와 호출수 기록 |

브라우저 loopback은 휴대폰에서 서버로 연결되는 주소가 아니다. SSH 포트 공개, 임의 endpoint, 개발 토큰 복사로 우회하지 않는다. 도우미는 10분 뒤 종료한다. 새 시도는 이전 state를 폐기하며 실패·취소가 기존 계정을 덮어쓰지 않는다.

## 서버 전달

먼저 서버에 같은 앱 전용 도구를 설치하고 별도 디렉터리의 `init`을 실행한다. 컴퓨터 도우미를 종료하고 컴퓨터 쪽 refresh/추론 사용을 멈춘다. 서버 SSH 접속·host key를 확인한 뒤 **session.json 하나만** 0700 staging 디렉터리로 `scp` 전송하고 `chmod 600`을 적용한다. host.json은 전송하지 않는다. 평문 메신저·브라우저 localStorage·환경변수·명령행 토큰 금지. 실제 명령의 사용자명/주소는 사용자가 선택한다.

```sh
# 서버: SSH로 전달된 보호 파일의 경로를 지정
npm run siwc -- init --dir /workspace/data/daily-log-siwc/server-account-1
npm run siwc -- import --dir /workspace/data/daily-log-siwc/server-account-1 --file /workspace/data/daily-log-siwc/staging/session.json
npm run siwc -- status --dir /workspace/data/daily-log-siwc/server-account-1
```

Import는 서명·issuer·audience·subject·만료를 다시 검증한다. 원래 nonce 검증은 컴퓨터 교환 단계에서 수행되며 import는 새 OAuth 동의를 주장하지 않는다. 이미 다른 등록이 있는 대상은 거부한다. 만료된 ID/access token은 다시 로그인 후 전달한다. 성공 후 staging 파일과 컴퓨터의 session.json을 로컬에서 제거하고 host.json은 유지한다. 컴퓨터에서 **signout/revoke는 하지 않는다**(서버로 옮긴 동일 세션도 해지됨). 갱신은 서버 하나만 소유한다. 백업에 session.json을 포함하지 않는다. 파일 암호화는 제공하지 않으므로 소유자 전용 Unix 권한과 암호화된 디스크·SSH가 보호 경계다.

## 상태·복구

- `READY`는 검증된 자격증명 상태일 뿐 제품 연결 완료가 아니다. 권한 누락은 `WAIT_PERMISSION`.
- 401/만료의 terminal refresh 실패는 `WAIT_AUTH`; 권한/정책 403은 `WAIT_SUPPORT`; 429는 `WAIT_LIMIT`. 유료 API fallback이나 자동 retry는 없다.
- 5xx는 `WAIT_RETRY`. 자동 복구·재시도는 구현하지 않았다. 정책/한도 해소를 확인하고 명시적 새 로그인·import로 회복한다. reset 시간을 추측하지 않는다.
- 응답 유실·중단 스트림·갱신 회전 결과 불명은 `WAIT_RECONCILIATION`. 먼저 결과/세션 상태 확인, 동일 요청 자동 재실행 금지. 새 로그인으로 세션 복구 후 별도 요청을 승인한다.
- 프로세스 간 `.lock`을 배타적으로 획득한다. 다른 작업은 BUSY로 중단한다. 비정상 종료 후에는 모든 해당 프로세스가 종료되었는지 확인한 뒤 빈 `.lock` 디렉터리만 제거한다. 잠금 시간만 보고 자동 삭제하지 않는다. 불확실한 요청 상태는 디스크에 남는다.
- 취소 버튼/Ctrl-C는 대기 로그인만 종료한다. 저장 세션 해지는 `npm run siwc -- signout --dir ...` 사용. 공식 discovery의 revoke를 시도하고 로컬 토큰을 제거하며 client/subject/host는 보존한다. 원격 해지 미확인은 ChatGPT 설정에서 직접 연결 해제한다.
- 로그는 상태만 출력한다. 콜백 URL, 토큰, 응답 원문, 개인 텍스트, 인증 오류 원문은 출력하지 않는다. 지원 요청에 session.json이나 로컬 로그인 주소를 붙이지 않는다.

## 검증과 통합

`npm run test:siwc`는 런타임 생성 합성 RSA 토큰, 가짜 네트워크 응답, 실제 임시 파일·loopback 서버를 사용한다. 외부 계정/추론 호출은 0이다. `npm test` 및 CI에도 포함된다. `runtime.mjs`는 명시적으로 선택한 model/text를 받아 텍스트 결과를 반환하는 준비 모듈이다. TASK4에서는 같은 OAuth access token으로 공식 `/v1/models`를 조회하여 사용자에게 허용된 모델을 선택하게 한 뒤 연결해야 한다. 모델을 임의 기본값으로 정하지 않았다.

TASK48 보안 수정 원본 `b0fe158a6ed042eb53a9487250ecfea60c041def`를 cherry-pick하여 Vitest 4.1.11 고정을 유지한다. 기존 TASK4 자료는 수정하지 않았다. 실제 검증 명령·결과는 [검증 기록](task-53-verification.md)에 별도 기록한다.
