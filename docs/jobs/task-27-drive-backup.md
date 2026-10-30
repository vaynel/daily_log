# TASK-27 Google Drive 일일 백업

코드: `apps/server/src/backup/*`, 스키마: `db/migrations/0010_drive_backup.sql`, 시험: `backup/backup.test.ts`(실제 PostgreSQL 임시 스키마 + 가짜 Drive/OIDC 발급자, 실제 Drive 호출 없음).

## 구성
- **Drive 연결(D29-01)** `/auth/drive/connect`·`/auth/drive/callback`(로그인과 분리된 `drive.file` 동의) → 갱신 토큰을 AES-256-GCM(`TokenVault`, 키: `DRIVE_TOKEN_KEY`, 없으면 `SESSION_SECRET`에서 HKDF)으로 암호화해 `drive_connections`에만 저장. 소유자를 AAD로 묶는다. 쿠키·로그·응답에는 토큰이 없다. `POST /auth/drive/disconnect`는 토큰 행 삭제 + Google 철회(최선 노력)만 하며 백업 파일·`backup_items`는 남긴다. 키가 바뀌어 복호화가 안 되면 `AUTH_EXPIRED`(재연결 필요).
- **목록(D29-02)** `plan.ts`: 기록 스냅샷(JSON: 대화 항목·첨부 목록·요약/계획/결과 버전·revision) + 첨부 원본 + 최신 RESULT 영상. **음성은 조회하지 않고** 스냅샷에도 필드가 없으며 `backup_items.item_kind`가 RECORD/ATTACHMENT/VIDEO로만 제한된다. 실제 여유 용량은 `about.storageQuota`(limit·usage)로 계산하고, 올릴 바이트가 남은 용량보다 크면 하나도 올리지 않는다(limit 없는 무제한 계정은 검사 한도 없음).
- **복사(D29-03)** 작업 큐 종류 `drive-backup`, 단계 `preflight → copy → finalize`. 
  - 중복 방지: `(소유자, 기록, 종류, 키, 내용 SHA-256)` 유일. 내용이 같으면 작업도 업로드도 없다(`enqueueInterview`가 이미 전부 검증되었으면 작업 없이 VERIFIED). 작업 멱등키 `drive-backup:<기록>:<목록 지문>`.
  - 버전: 파일은 새로 만들기만 하고 기존 파일을 갱신·삭제하지 않는다. 이름 `<생활일>_<종류>_<sha8>_<키>`, 폴더 `Daily Log Backup/<생활일>/`, appProperties에 `dlInterview`·`dlKind`·`dlVersion`(기록 `rev<N>.s<요약>.p<계획>.r<결과>`, 첨부 `sha<12>`, 영상 `result.v<N>`)·`dlItemKey`.
  - 응답 유실: 올리기 전에 `dlItemKey`로 같은 파일을 찾아 이어받는다. 올린 직후 크기·MD5를 Drive에서 다시 읽어 대조하고, `finalize`가 현재 목록 전부를 다시 대조한 뒤에만 VERIFIED.
  - 서버 파일 해시가 기록과 다르면 그 항목은 올리지 않고(`SOURCE_CORRUPT`) 나머지를 올린 뒤 `SOURCE_INCOMPLETE`로 실패.
  - `sweep()`은 워커가 `BACKUP_SWEEP_INTERVAL_MS`(기본 1시간)마다 호출하는 멱등 훑기라 하루 1회 이상 돌아도 중복 복사가 없다.
- **상태·재시도(D29-04)** `backup_states.reason`(민감정보 없는 코드) → `pipeline_states.backup` 파생.

| 사유 | 큐 동작 | 백업 열 |
|---|---|---|
| DRIVE_NOT_CONNECTED | 권한 대기(PERMISSION), 재시도 소모 없음, 연결 후 자동 재개 | PENDING |
| DRIVE_AUTH_EXPIRED / DRIVE_PERMISSION_DENIED | 권한 대기, 연결 `AUTH_EXPIRED` | FAILED |
| DRIVE_QUOTA_INSUFFICIENT | 재시도 없이 FAILED(사전 검사 또는 업로드 403) | FAILED |
| 일시 오류(네트워크·429·5xx·토큰 갱신 서버 오류) | 작업당 자동 재시도 1회(`RETRYING`→PENDING), 그 후 FAILED(`COPY_FAILED`) | PENDING→FAILED |
| VERIFY_MISMATCH / SOURCE_INCOMPLETE | 재시도 없이 FAILED | FAILED |

수동 재시도: `POST /api/backup/records/:id/retry`(헤더 `Idempotency-Key` 필수) → 큐 `requestManualRetry`. 자동 재시도 사용 횟수는 계승한다.

## 서버 원본 정리 가능 여부(AC-6)
`GET /api/backup/records/:id/readiness[?live=1]`: 현재 최신 목록(최신 revision·버전)의 모든 항목에 검증 기록이 있으면 `backedUp`. `live=1`이면 Drive에서 지금 다시 크기·MD5·휴지통 여부를 확인해 `ready`(true/false), 확인 불가(미연결·만료·네트워크)이면 `ready=false`와 사유. `live` 없이는 `ready=null`(LIVE_CHECK_REQUIRED). **이 API와 백업 코드는 아무것도 삭제하지 않는다.** 서버 사본 정리(한 달 만료) 실행기는 정리 직전에 `live=1`이 `ready=true`일 때만 서버 사본을 지워야 한다(후속).
서버 원본의 만료·사용자 삭제·휴지통 만료는 Drive 파일과 `backup_items`에 전파되지 않는다(FK 없음, `DriveApi`에 삭제·갱신 메서드 없음). 용량 부족 시 기존 백업을 지우지 않는다.

## 사용 절차
1. 설정: 기존 Google 로그인 환경변수 + (선택) `DRIVE_TOKEN_KEY`(16자 이상, 바꾸면 재연결 필요). `npm run db:migrate`.
2. 화면/관리자가 `/auth/drive/connect`로 이동해 Drive 동의 → `/auth/session`의 `driveState`(NONE/CONNECTED/AUTH_EXPIRED) 확인.
3. 워커(`npm run start:worker`)가 훑기 → `GET /api/backup/status`로 기록별 상태·사유·안내 확인.

## 한계 / 미실행
- 실제 Google Drive·Google OAuth 호출은 이 러너에서 하지 않았다(가짜 Drive 서버 사용). 실제 업로드 확인은 PM이 관리자 계정으로 서버에서 수행한다.
- 영상은 메모리에 읽어 한 번에 올린다(세로 180초 영상 규모 가정).
