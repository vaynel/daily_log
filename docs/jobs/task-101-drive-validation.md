# TASK-101: 별도 Drive 검증 준비

기준은 immutable `/run/mandu/MANDU-HANDOFF.json`의 TASK27 커밋
`4230ea0e67dde723d7671ec6cd95ad9b1c8ca0e6`이다. checkout의 동명 파일과
옛 호스트 경로는 사용하지 않는다. 이 변경은 TASK27 승인 또는 운영 배포가 아니다.
실제 Google Drive/OAuth와 Android는 **NOT_RUN**이다.

## 실행 경계

- 저장소·의존성·합성 파일은 `/workspace` 안에 둔다. `.env`나 운영 설정은 읽지 않는다.
- DB는 컨테이너에 주입된 격리 `DATABASE_URL`만 사용한다. `TASK101_TEST_DB=1`은
  운영 주소를 안전하게 만드는 옵션이 아니다. 주입된 테스트 서비스에서만 설정한다.
- preflight는 연결·DB 변경·OAuth·업로드 없이 상태만 출력한다. DB 값이 있더라도
  실제 연결은 `NOT_RUN`, OAuth도 환경변수 존재만으로 동의 완료라고 판정하지 않는다.
- verify는 `--fake`만 허용한다. 네트워크 fetch는 이번 실행에서 생성한 loopback
  fake Drive/OIDC의 정확한 origin만 허용하고 redirect 자동 추적을 금지한다.
  실제 Google 업로드를 켜는 숨은 옵션이나 환경변수는 없다.
- 앱은 기존 `buildApp`을 inject로 호출한다. fake 서버만 `127.0.0.1` 임시 포트에
  바인딩하고 실행 후 닫는다. queue.tick을 최대 20회 호출하며 daemon/timer/scheduler를
  시작하지 않는다. Redis는 이 동기 검증 경로에 필요하지 않다.
- 매 실행마다 `task101_<random>` 스키마에 기존 마이그레이션을 적용한다.
  기존 스키마·파일을 덮어쓰지 않는다. 시험 스키마와 `data/task101/run-*`는 보존한다.
  파일 삭제·Drive DELETE/PATCH·휴지통 요청·DB DROP 코드를 추가하지 않았다.
- 기존 앱의 요청 로그에는 OAuth callback query가 포함될 수 있으므로 첫 요청 전에
  로거를 silent로 설정한다. 예외도 stage만 출력한다. 토큰·쿠키·환경변수 값을 출력하거나
  파일로 저장하지 않는다. 합성 OAuth 암호화 키는 메모리에서 생성하며 실행 후 폐기한다.

## AI가 실행할 정확한 다음 명령

작업 디렉터리 `/workspace`, Node 22 이상, 기존 lockfile만 사용한다.
이미 의존성이 있으면 npm ci를 반복할 필요 없다. 운영 서버/worker 실행은 필요 없다.

```sh
timeout 120s npm ci --ignore-scripts --no-audit --no-fund
timeout 10s node scripts/drive-validation/preflight.mjs
timeout 15s node --test scripts/drive-validation/preflight.test.mjs
timeout 90s env TASK101_TEST_DB=1 node --import tsx scripts/drive-validation/verify.ts --fake
timeout 30s npx --no-install tsc -p scripts/drive-validation/tsconfig.json
timeout 30s npx --no-install eslint scripts/drive-validation
timeout 30s npm run scan:secrets
```

preflight 종료 0은 점검 출력 성공이며 실제 백업 성공이 아니다. verify 종료 0 및 마지막
`result: PASS`는 **테스트 PG/fake Drive에만** 적용된다. 누락 인자/DB/확인 플래그는 종료 2
`NOT_RUN`, 검증 실패는 종료 1 `FAIL`과 stage, timeout은 124이다. 실패를 성공으로 보고하지 않는다.

## 합성 입력과 검증 내용

`RecordStore`로 합성 질문·답변·요약·RESULT를 만들고 `AttachmentService`로 작은 Markdown을
저장한다. 기존 완성영상 `scripts/video-spike/out/sample.mp4`를 새 합성 디렉터리로 복사한다.
이 파일은 2,138,651 bytes, H.264 720×1280 / AAC, 180초이며 새 렌더링·유료 API 호출은 없다.
영상의 SHA-256은 `ebecf326b8d53aa69ebfdae3b7bf3f0c3f5d9d6f5164272d812a2058a4857e9d`이다.
음성 제외 검사용 `audio_segments` 메타데이터도 1건 만든다. 영상 내 오디오 트랙과 인터뷰
음성 세그먼트는 별개이며 완성영상 전체 바이트는 보존한다.

기존 auth login/callback과 별도 drive connect/callback을 fake issuer로 실행한다.
기존 `PgDriveConnections`, `TokenVault`, `GoogleDriveClient`, `BackupService`, `JobQueue`,
`buildBackupPlan`과 backup 라우트를 그대로 재사용한다. 운영 공통 코드는 변경하지 않는다.

1. 비로그인 run은 401, 로그인한 run은 202이며 유한 queue 처리로 업로드한다.
2. RECORD/ATTACHMENT/VIDEO 각각 원본 바이트, Drive 속성 버전, DB 버전·크기·SHA-256·MD5를 대조한다.
3. 음성 메타데이터가 있어도 계획/업로드/backup_items에는 3종만 있고 JSON에 음성 정보가 없다.
4. live 없는 readiness는 null, live 조회는 true인지 확인한다.
5. 중복 실행은 업로드하지 않는다. 요약 v2는 새 스냅샷 1건만 올리며 구버전은 유지한다.
6. 원격 MD5 변조, 최신 요약 미복사, 원격 401에서 readiness가 false인지 확인한다.
7. 원본 영상·복사 영상·첨부 해시 불변과 Drive 삭제/수정 요청 0건을 확인한다.

원시 출력과 명령/종료코드는 [task-101-evidence](task-101-evidence/)에 기록한다.
첫 개발 실행은 반환 객체에 없는 attachment.checksum을 비교하여 실패했다.
기존 service 반환 계약을 확인하고 계획에 기록된 SHA-256과 비교하도록 수정했다.
실패 실행은 통과 수에 포함하지 않는다.

## 이후 인간 OAuth와 실제 Drive 검증 준비 요건

**현재 사용자에게 로그인·비밀값을 요청하지 않는다.** 별도 실제 검증 단계에서 본인이
Google 로그인 및 `drive.file` 동의를 해야 한다. AI/가짜 OIDC가 이 동의를 대신할 수 없다.

실제 검증용 OAuth 웹 클라이언트와 동의 화면/테스트 사용자, 허용 이메일이 준비되어야 한다.
운영 값 복사 대신 별도 보호 설정을 사용한다. 브라우저와 callback을 처리할 앱이 같은
loopback 주소에 도달해야 하며 OAuth 등록 redirect URI가 다음과 정확히 같아야 한다.

- `http://127.0.0.1:3000/auth/callback`
- `http://127.0.0.1:3000/auth/drive/callback`

다른 주소를 선택하면 PUBLIC_BASE_URL과 두 등록 URI를 함께 맞춘다. 원격 컨테이너의
loopback은 사용자 PC의 loopback과 다르므로 승인된 접근 경로 없이 로그인부터 시작하지 않는다.
처음 `/auth/login`은 openid/email/profile, 이후 `/auth/drive/connect`는 drive.file이며
앱의 `/auth/session`에서 CONNECTED를 확인해야 한다. 갱신 토큰은 기존 암호화 저장을 사용하고,
안정적인 별도 키가 필요하다. 쿠키/토큰을 채팅·명령줄·증거에 붙이지 않는다.

이 harness는 **의도적으로 실제 서버 시작/Google 호출 모드를 제공하지 않는다**.
현재 실행할 다음 명령은 위 preflight와 fake 검증 명령이다. 이후 실제 검증 담당자는
별도 검증 앱의 기존 `buildApp`에 auth/connections/backup/records를 연결하고 loopback만
바인딩했는지 먼저 검토해야 한다. 현재 운영앱에 backup wiring이 있다고 가정하면 안 된다.
그 다음 본인 브라우저 세션에서 동일 합성 기록에 대해 순서대로
`POST /api/backup/records/:id/run` → 유한 queue 처리 →
`GET /api/backup/records/:id/readiness?live=1`와 Drive 실제 메타데이터를 대조한다.
이 후속 작업이 실행되기 전 actualGoogleDrive는 계속 NOT_RUN이다.

Drive 사본과 완성영상은 무기한 보존한다. 서버 원본은 1개월이 지나도 현재 최신 버전에 대한
새 live 검증 전에는 삭제하면 안 된다. ready=true 역시 이 작업에서 삭제를 허용하거나
실행한다는 뜻이 아니다. 용량 부족·권한 철회·검증 불가 시 삭제와 성공 처리를 모두 중단한다.
