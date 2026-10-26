# TASK-104 독립 검수

판정: **CHANGES_REQUESTED**. 신규 검증 앱의 QA 실행은 **BLOCKED**다.
검수 기준 SHA는 `599cd816522cc05fdc102e4801b039ee294efc08`, tree는
`35b82d6e11832d5f6406e6c5ca65258255c7e6e0`이며 `/run/mandu/MANDU-HANDOFF.json`의
불변 제출 증거 및 get_task 선행 보고와 일치한다. 검수 브랜치는 qa/task-104-review다.
제품 코드는 수정하지 않았다. 이 판정은 TASK27 최종 승인이나 출시 승인이 아니다.

## 필수 수정 / 실행 계약 정합성

P1 — `scripts/drive-validation-app/config.ts:18`은 테스트 DB 이름을
`daily_log_backend_test`로 고정했다. QA에 실제 주입된 서비스는 같은 테스트 호스트의
`daily_log_qa_test`다. `db-diagnosis.txt`의 실제 SQL 조회는 연결 성공을 확인하지만
동일 URL을 받은 readiness는 TEST_DATABASE_URL 누락으로 거부한다.

재현: 주입 환경 그대로 `node --import tsx scripts/drive-validation-app/verify.ts --fake`.
결과 exit 1, stage startup FAIL. config.test.ts의 foreground CLI 검사도 LISTENING 대신
NOT_READY를 받아 실패한다. 기존 TASK101 harness는 같은 주입 DB에서 끝까지 통과했다.
따라서 DB 중단이나 사람의 OAuth 동의 부재가 아니라 앱과 QA 실행 환경의 DB 허용 계약
불일치다. 운영 DB 차단 자체는 유지되어야 한다. 담당 개발/PM은 승인된 격리 QA DB와
명시적 허용 정책을 정합하게 만든 뒤 같은 HTTP 검사를 다시 제출해야 한다. 다른 DB로
바꾸거나 기존 안전 검사를 완화하여 통과시키지 않았다.

## 개발 AC 대조

| 개발 조건 | 독립 결과 | 근거 |
|---|---|---|
| AC-1 실행 가능한 별도 wiring | PARTIAL | app.ts/main.ts에 기존 auth/records/Drive/backup/queue 연결 확인. 현재 주입 환경에서 시작 실패 |
| AC-2 HTTP 로그인·별도동의·합성·백업·live | NOT_RUN (startup FAIL) | http.txt. 기존 inject harness PASS는 신규 HTTP 경로를 대신하지 않음 |
| AC-3 기본 off·보호·절차 | PARTIAL | config 4/5 PASS, foreground 로그/종료 검사는 시작 실패로 확인 불가. 문서의 명령·callback·보호 stdin/인간 전용 조건 확인 |

코드상 루프백 bind, 인증 훅 이후 소유자 검사, 정확한 Host/Origin/전용 헤더, 합성 기록 ID
허용목록, 수동 유한 tick, silent 로그, 외부 fetch origin/method 제한을 확인했다.
공유 auth/plugin.ts는 기본 인증을 적용하고 Drive 동의를 로그인과 분리한다.
backup/drive.ts는 create/upload/get을 사용하며 삭제 API가 없다. routes.ts 및 service.ts의
live 실패는 ready=false이고 cached 조회는 ready=null이다. 이 정적 확인을 실행 PASS로
표현하지 않는다. HEAD의 18개 추가 파일 외 공통 앱/runner/controller 변경은 없다.

## 실제 실행 결과

원시 출력과 정확한 명령/종료 코드는 `task-104-evidence/`에 있다.

- config: 4 PASS / 1 FAIL, exit 1 (foreground NOT_READY).
- 새 HTTP 통합: startup FAIL, exit 1; 후속 HTTP 검증 NOT_RUN.
- 기존 보존형 TASK101: exit 0. 실제 PG + fake OIDC/Drive, 세 종류 버전/크기/해시,
  음성 제외, 중복 방지, 새 버전과 구버전 보존, 원격 변조/철회 실패 닫힘, 원본 보존,
  삭제 요청 0, 외부 요청 0.
- preflight 4/4 PASS. 기본 off는 exit 2 / NOT_READY로 예상대로 차단.
- lint, 검증 앱 tsc, workspace typecheck, build: 각각 exit 0.
- 전체 npm test: NOT_RUN. 보존형 검수 범위 밖의 기존 파괴적 teardown은 실행하지 않음.
- npm ci: 설치 성공, 기존 의존성 감사 경고 moderate 2건; 의존성 수정은 하지 않음.

## 실제 Google 및 인간 준비조건

actualGoogleDrive/OAuth, Android, 배포는 모두 NOT_RUN. 외부 Google 요청을 수행하지 않았다.
문서는 별도 OAuth client/동의 화면/사용자·두 callback URI 등록, 보호된 stdin 설정 공급자,
사용자 브라우저에서 승인된 loopback 접근 경로가 필요함을 명시한다. 이 환경에 준비되었다는
증거는 없으며 실제 연결은 NOT_READY다. 사람의 로그인·동의는 후속 실제 검증에 필요하지만
현재 fake QA 실패를 해결할 조건은 아니다. 현 시점에 사용자에게 로그인을 요구하지 않는다.

## TASK-104 완료 조건

- AC-1 PARTIAL: 정확한 SHA/코드/개발 AC를 대조하고 실행했으나 신규 HTTP 경로는 시작 차단으로 검증 불가.
- AC-2 PASS: 실제 Google 미실행, 인간 전용 조건, DB 실행 계약 실패를 구분했다.
- AC-3 PASS: 구체 재현 증거로 CHANGES_REQUESTED 제출. TASK27 최종 승인으로 확장하지 않음.

읽은 참조: 불변 인계 파일, Mandu get_task/begin_task 고정 패킷 및 verification-before-completion,
README, TASK103 실행 문서 및 새 소스/테스트, TASK101 보존형 verify/preflight,
공유 app/auth plugin/Drive client/vault/routes와 backup service 관련 코드.
