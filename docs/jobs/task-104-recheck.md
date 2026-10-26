# TASK-104 수정 제출 독립 재검수

검수 대상: `7ae76e6d2410ca06e0cf202a7209db3723705eb4`, tree
`3722ae53a4dd5b81ccd3d7834f720fc71a722bd5`.
읽기 전용 `/run/mandu/MANDU-HANDOFF.json` 및 Mandu TASK-103 제출
`9638bf0c-8c96-4a1f-b9de-ce0ce36ebbf5`와 일치한다.
TASK-104 실행: `35eb57d1-07ba-4a08-b175-745bcfc30df2`.

판정: **PASS — 별도 검증 앱의 fake OIDC/Drive + 격리 QA PostgreSQL 범위**.
이 판정은 사람의 검토를 위한 독립 검수 의견이며 TASK27·출시·실제 Google 연결의
최종 승인이 아니다. 제품 코드 수정 없음. 이전 실패 보고/증거는 과거 이력으로 보존한다.

## 이전 P1 재검증

`config.ts`는 backend 테스트 DB 하나만 허용하던 비교를 backend/qa 두 DB 명시 목록으로
수정했다. host/port/protocol/사용자/비밀번호/query/fragment 제한은 유지한다.
이번 검수는 DATABASE_URL을 바꾸지 않고 주입된 QA DB에서 직접 수행했다.
`database.json`의 injectedQaDatabase=true, reachable=1, allowlistAccepted=true와
`http.txt` 및 `config.txt`가 이전 startup 결함 해소를 증명한다.
QA DB 생성·권한 수정·runner 설정 변경은 수행하지 않았다.

## 완료 조건 대조

| 조건 | 판정 | 실제 근거 |
|---|---|---|
| 개발 AC-1 별도 앱 wiring과 단발 queue/live | PASS | HTTP 로그인/동의/합성 생성/백업/live 전체 실행, CLI LISTENING 후 SIGTERM 정상 종료. queue는 자동 실행하지 않으며 tick 최대20회. |
| 개발 AC-2 실제 PG+fake HTTP 독립 재현 | PASS | QA DB 실제 실행. 비로그인401, 동의 거부 시 미연결, 타subject403, CSRF/Host 차단, 임의 기록404. 세 종류 바이트/버전/SHA256/MD5 일치, 음성 제외, 중복 생략, 손상·철회 시 ready=false, 원본 유지. |
| 개발 AC-3 안전 경계·한국어 실행 절차 | PASS | config 5/5, preflight 4/4. default-off 종료2, 운영 DB/host/port/query 거부, loopback, callback/cookie sentinel 로그 부재, 삭제 경로 차단. HTTP에서 외부Google0·파괴요청0. 실행문서의 명령과 인간 선행조건 대조. |
| 검수 AC-1 정확한 SHA의 개발 AC 전부 대조 | PASS | 위 3개 조건 및 원시 실행 로그, 변경 diff 검토. |
| 검수 AC-2 실제Google/OAuth와 환경 실패 구분 | PASS | QA DB startup 장애 해소. 실제 Google/OAuth/Android는 NOT_RUN, 실제 연결은 아래 선행조건 미검증으로 NOT_READY. |
| 검수 AC-3 구체 증거와 범위 제한 판정 | PASS | 본 보고서와 commands.json, DB·HTTP·설정 증거. TASK27 최종 승인 아님. |

## 실제 연결에 남은 조건

실제 Google OAuth/Drive, Android 및 배포는 **NOT_RUN**이다. 승인된 보호 stdin 설정
공급자와 사용자 브라우저→컨테이너 loopback 접근 경로의 검증 증거가 없어 실제 연결은
**NOT_READY**다. 별도 OAuth 웹 클라이언트와 테스트 사용자, 아래 redirect 등록 및
사람의 로그인/별도 drive.file 동의가 필요하다.

- http://127.0.0.1:3000/auth/callback
- http://127.0.0.1:3000/auth/drive/callback

이번 테스트의 fake 동의를 사람의 실제 동의로 계산하지 않는다. 위 인간 선행조건은
수정 전 QA DB 시작 결함과 별개이며 현재 fake 검수의 차단 요인이 아니다.

## 재현과 증거

[task-104-recheck-evidence](task-104-recheck-evidence/)에 명령·종료코드와 실제 출력을
보존한다. 의존성은 lockfile의 npm ci로 /workspace 안에 설치했다. 각 HTTP harness는
새 스키마와 합성 파일을 보존한다. Redis는 이 수동 JobQueue 경로에서 사용하지 않는다.
전체 npm test는 기존 teardown의 DROP SCHEMA/파일 삭제 때문에 NOT_RUN이다.
새 설정 검사·보존형 HTTP/legacy harness·preflight와 lint/typecheck/build로 검증했다.
화면 변경이 없고 visualRequired=false이므로 스크린샷은 해당 없음.

읽은 참조: 불변 handoff, Mandu get_task 선행 제출 및 고정 begin_task 패킷,
verification-before-completion, README, TASK103 실행문서, app/config/main/verify/config.test,
기존 auth plugin/backup routes 및 TASK101 harness 관련 경로.
