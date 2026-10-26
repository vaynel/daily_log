# TASK-103 재작업 제출

기준: TASK-104 제출 `26265db0ce45562ffff5c35345c5e78c589a73b6` 및
불변 `/run/mandu/MANDU-HANDOFF.json`. 독립 검수 P1은 QA DB가 정상이어도
앱의 단일 DB 이름 비교 때문에 시작을 거부하는 문제였다.

`config.ts`에서 같은 격리 테스트 호스트의 개발/QA DB 두 개만 허용하도록 수정했다.
운영 호스트·미승인 DB·포트·query·fragment 거부는 유지한다. 공통 서버/worker,
기존 harness, 운영 설정은 변경하지 않았다.

회귀 검사에서 QA URL은 수정 전 NOT_READY로 실패(exit 1), 수정 후 CONFIG_READY로
통과했다. 설정/CLI 5개, preflight 4개, 주입된 개발 PG에서 신규 HTTP 및 기존 보존형
harness 모두 통과했다. HTTP 로그인→별도동의→합성→백업→live, 비로그인 거부,
3종 바이트/해시/버전, 음성 제외, 원본 보존, 외부 Google·삭제 요청 0건을 재확인했다.
lint, 신규 앱 및 workspace typecheck, build, secret scan도 exit 0이다.
실제 출력과 명령은 `task-103-rework-evidence/`에 있다.

AC-1/2/3은 개발 범위의 실제 테스트 PG+fake HTTP 증거로 PASS 제출한다.
독립 QA 환경의 HTTP 재실행은 아직 NOT_RUN이다. 이 개발 자격으로 QA DB 접근을
확인한 결과 SQLSTATE 42501이었다. 권한/DB 생성이나 다른 인증 복사는 하지 않았다.
QA는 자신의 주입 URL 그대로 문서의 명령을 재실행해야 한다. QA PASS를 대신하거나
자기 승인하지 않는다.

실제 Google/OAuth/Android/배포는 NOT_RUN, 실제 연결은 보호 설정 공급자 및 승인된
브라우저 loopback 접근 증거 부재로 NOT_READY다. 전체 npm test는 기존 삭제 teardown
때문에 NOT_RUN이다. TASK27 승인·AC·이력은 변경하지 않았다. 화면 변경은 없다.
