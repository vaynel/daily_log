# TASK-103 별도 OAuth/Drive 검증 앱

기준 커밋 `749464fc13d8b0e64adbd86e24b21aab743edbb9`과
읽기 전용 `/run/mandu/MANDU-HANDOFF.json`을 확인했다. 기존 TASK101 preflight/fake
harness와 운영 서버·worker·공통 소스는 변경하지 않는다. 별도 앱은 기존 buildApp,
OIDC/세션, PgDriveConnections/TokenVault, RecordStore/AttachmentService,
BackupService/GoogleDriveClient와 JobQueue를 조립한다.

실제 Google OAuth/Drive, Android, 배포는 **NOT_RUN**이다. TASK27 승인과 AC/이력을
변경하지 않았다. 이번 PASS는 격리 테스트 PostgreSQL 및 fake HTTP 실행에 한정된다.

## AI 실행 명령

작업 디렉터리는 `/workspace`, 의존성은 기존 lockfile의 `npm ci`로 이 경로에만 설치한다.
`DATABASE_URL`은 주입된 테스트 서비스만 사용한다. `.env` 또는 운영 인증은 읽지 않는다.
Redis는 이 수동 JobQueue 경로에서 필요하지 않다. Docker/host 경로도 필요 없다.

```sh
# 네트워크·DB 생성·로그인 없이 누락 항목만 출력. 기본 off, 종료 2가 정상이다.
timeout 10s node --import tsx scripts/drive-validation-app/main.ts

# 독립적인 실제 PG + HTTP 모의 로그인/동의/합성/백업/live 통합 검사
# 성공 0, 실패 1. 모든 임시 스키마/파일은 보존한다.
timeout 90s node --import tsx scripts/drive-validation-app/verify.ts --fake

# 기본 off, 설정/네트워크 차단 및 실제 foreground 명령의 로그 보호/종료 검증
# 이 검사는 3000 포트가 비어 있어야 한다.
timeout 40s node --import tsx --test scripts/drive-validation-app/config.test.ts

# 필요 시 모의 앱을 직접 foreground 실행한다. 시간 제한 종료 124는 테스트 PASS가 아니다.
timeout --foreground 900s node --import tsx scripts/drive-validation-app/main.ts --fake
```

fake 앱 브라우저 주소는 `http://127.0.0.1:3000/auth/login`이다. fake issuer는 합성 계정만
사용한다. 실제 사람의 동의를 대신한 것이 아니다. 로그인 후 `/auth/drive/connect`를
따로 방문한다. 루트 `/`는 현재 합성 ID와 다음 단계가 나오는 보호된 JSON 경로이다.
제품 UI를 추가하거나 운영 앱을 실행하지 않는다.

로그인한 **같은 브라우저 탭**의 개발자 콘솔에서 아래를 순서대로 실행한다. 쿠키를
추출하거나 채팅/파일/명령줄에 복사하지 않는다. 입력은 서버가 정한 합성 데이터뿐이다.

```js
const post = async (url) => {
  const r = await fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Validation-Action': '1'
  }, body: '{}' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const synthetic = await post('/api/validation/synthetic');
await post(`/api/backup/records/${synthetic.id}/run`);
await post('/api/validation/tick');
await (await fetch(`/api/backup/records/${synthetic.id}/readiness?live=1`)).json();
```

브라우저는 POST의 동일 Origin을 자동으로 보낸다. 인증·정확한 Host·Origin·전용 헤더·JSON
타입을 모두 요구한다. 합성 생성은 한 실행에서 1건으로 고정되며 재호출은 같은 ID를 반환한다.
첫 합성 생성 주체에 소유자를 고정한다. 다른 subject의 세션, 임의 기록 ID, 기존 기록
쓰기/열람, raw 파일, 연결 해제/삭제 경로는 차단한다. 백업 등록만으로 실행되지 않으며
`tick`은 최대 20번의 기존 queue.tick 호출만 수행한다. 자동 scheduler/daemon은 없다.

## 실제 OAuth용 준비된 실행 경로와 아직 없는 선행조건

실제 모드의 실행 명령은 다음과 같다. **이번 작업에서는 실행하지 않았다.** 추가 코드 작성은
필요 없지만, 아래 보호 설정과 승인된 접근 경로가 모두 있어야 시작된다.

```sh
# 별도 승인된 비밀 설정 공급자가 stdin anonymous pipe를 연결한 상태에서 실행
# 명령줄 인자/환경변수/일반 파일로 OAuth 값을 전달하지 않는다.
timeout --foreground 900s node --import tsx scripts/drive-validation-app/main.ts --real
```

stdin은 FIFO 또는 socket이어야 하며 일반 파일과 TTY는 거부한다. 3초/16KiB 한도로 JSON
객체 하나를 메모리에서만 읽는다. `.env`, 운영 OAuth 값, 다른 세션의 인증은 읽지 않는다.
실제 값을 채팅으로 요구하지 않는다. 공급자의 별도 보호 저장소에서 다음 필드를 제공한다.
비밀 저장소 자체나 runner/controller 설정을 이 작업에서 생성·변경하지 않는다.

| 필드 | 조건 |
|---|---|
| `enableReal` | 명시적 boolean true; 없으면 기본 off |
| `clientId`, `clientSecret` | 별도 Google OAuth 웹 클라이언트, 운영 값 재사용 금지 |
| `allowedEmail` | 본인 이메일 1개만 |
| `sessionSecret`, `tokenKey` | 각각 32자 이상, 별도 보호 저장소의 키. 원문 로그/파일 기록 금지 |
| `publicBaseUrl` | 정확히 `http://127.0.0.1:3000` |
| `approvedLoopbackAccess` | 사용자 브라우저가 이 앱 loopback에 도달하는 기존 승인 경로를 검증한 경우에만 true |

누락/잘못된 설정은 값 없이 항목명만 출력하고 종료 2, 시작 실패는 안전한 stage만 출력하고
종료 1이다. CONFIG_READY는 설정 형식 확인이며 OAuth 동의·업로드 성공을 뜻하지 않는다.
키는 암호화 DB 토큰에 사용하고 세션은 메모리 설정으로 검증한다. 재시작은 새 스키마를
만들며 이전 토큰/개인 기록을 재사용하지 않는다. 실행 종료 후에도 스키마/파일은 보존한다.

Google Console에 등록할 정확한 redirect URI:

- `http://127.0.0.1:3000/auth/callback`
- `http://127.0.0.1:3000/auth/drive/callback`

별도 클라이언트/동의 화면/테스트 사용자가 준비되면 사람은 본인 브라우저에서 로그인
(`openid email profile`)하고 `/auth/drive/connect`에서 `drive.file`에 별도로 동의한다.
클라이언트/redirect 등록이 필요하면 Google Console에서 수행한다.

현재 보호 OAuth 설정 공급자와 사용자 PC→이 컨테이너 loopback의 승인된 경로에 대한 증거가
제공되지 않았다. 따라서 실제 연결 상태는 **NOT_READY**다. 단순히 예전 접속 기록이나
설정 존재를 보고 사용 가능하다고 판정하지 않는다. 공개 터널·배포·포트 공개를 만들지 않는다.
위 두 선행조건이 제공되어 검증되기 전 사용자에게 로그인부터 요구하지 않는다.

## 안전 경계

- DB URL은 정확히 주입된 테스트 서비스 `daily-log-test-postgres17:5432`의
  `daily_log_backend_test`(개발)와 `daily_log_qa_test`(독립 QA)만 명시적으로 허용한다.
  각 실행은 해당 환경에 주입된 `DATABASE_URL`을 그대로 사용한다. DB 이름을 임의로
  바꾸거나 DB/권한을 생성하지 않는다. 다른 host/database/port, query options/schema,
  fragment를 시작 전에 거부한다. 확인 플래그로 운영 DB를 허용할 수 없다.
- 매번 난수 `task103_<96bit>` 스키마를 **새로** 만들고 search_path를 그 스키마로 고정한다.
  기존 migration의 제약 변경은 새 스키마에만 적용된다. public/기존 스키마를 쓰지 않는다.
- 합성 파일은 `/workspace/data/task103/run-*` 새 디렉터리만 쓴다. 기존 sample.mp4를
  COPYFILE_EXCL로 복사한다. 영상/첨부/기록 바이트·버전·SHA-256·MD5를 검증한다.
- 앱은 127.0.0.1만 바인딩한다. 요청 로그는 listen 전에 silent, 오류는 고정 코드만 반환한다.
  OAuth query, 세션/flow 쿠키, refresh/access token, 환경값을 출력하지 않는다.
- fake 모드의 모든 OAuth/Drive fetch는 그 실행에서 생성된 loopback origin 두 개만 허용한다.
  real 모드는 accounts.google.com, oauth2.googleapis.com, www.googleapis.com HTTPS만 허용한다.
  discovery 응답의 endpoint 및 upload Location도 같은 gate를 통과한다. redirect 자동 추적,
  URL userinfo, DELETE/PATCH를 거부하고 각 fetch에 10초 제한을 둔다.
- 삭제·휴지통·원본 수정 경로가 없다. Drive 사본·완성영상은 무기한 보존하며 서버 원본은
  1개월이 지나도 최신 live 검증 전 삭제 금지다. ready=true도 삭제 실행 허가가 아니다.
- 실제 모드는 실행 가능한 wiring일 뿐 이번 검증 범위가 아니다. Google의 실제 동작과
  원격 네트워크 환경 호환성은 실제 검증 때 확인해야 한다.

## 재현 증거와 검사 범위

[task-103-evidence](task-103-evidence/)에 원시 실행 결과와 종료 코드를 기록한다.
새 CLI 부재로 기본 off 검사가 실패한 RED를 확인한 뒤 구현했다. 첫 HTTP 검사에서 Node
fetch가 수동 Host 헤더를 전송하지 않아 Host 거부 검사가 실패했다. 정확한 raw HTTP
요청으로 바꾸어 거부를 확인했다. 이 실패들은 통과 실행으로 계산하지 않는다.

전체 `npm test`는 **NOT_RUN**이다. 기존 테스트 teardown에 DB DROP SCHEMA와 파일 rm이
있어 이번 작업의 파일/DB 삭제 금지와 충돌한다. 대신 기존 보존형 TASK101 통합 검증,
preflight 4건, 새 설정/CLI 5건, 새 HTTP/PG 통합 검사, 전체 lint/typecheck/build를 수행한다.
테스트를 통과시키기 위해 공유 테스트나 운영 코드를 수정하지 않았다.

## TASK-104 피드백 반영

독립 QA가 사용하는 `daily_log_qa_test`를 거부하던 단일 DB 이름 비교를 두 승인된
테스트 DB의 명시적 허용 목록으로 수정했다. `*_test` 패턴이나 임의 환경 플래그로
허용 범위를 확장하지 않는다. QA URL의 CONFIG_READY 회귀 검사는 수정 전 실패,
수정 후 통과했다. 동일 QA URL에서 운영 호스트·미승인 DB·포트·query·fragment를
거부하는 검사도 추가했다.

새 실행 증거는 [task-103-rework-evidence](task-103-rework-evidence/)에 보존한다.
이번 개발 컨테이너에는 backend 테스트 DB가 주입되었으므로 실제 HTTP/PG 재검증은
그 DB에서 수행했다. QA DB 연결을 같은 테스트 서비스에서 확인했으나 사용할 수
없었다. QA DB 생성·권한 변경은 하지 않았다. QA 환경 자체의 HTTP 재실행은 독립
검수에서 주입된 QA URL로 위 명령을 실행해야 하며, 개발의 PASS로 대체하지 않는다.
