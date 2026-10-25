# TASK-18 하루 1회 알림과 결과 알림

## 동작
- **인터뷰 알림**: 기본 22:00 Asia/Seoul. 사용자 설정(`notification_settings.interview_time`, `PUT /api/notifications/settings {interviewTime:"HH:MM"}`)이 이후 예약에 쓰인다.
  - 생활일(KST 날짜)당 1건: `notifications.dedupe_key = INTERVIEW_REMINDER:<owner>:<YYYY-MM-DD>` UNIQUE + `ON CONFLICT DO NOTHING`. 미응답·재시작·여러 워커 동시 실행에도 추가 알림 없음.
  - 예약 시각을 놓쳐도(서버 중단) 3시간 유예 안이면 늦게라도 1번, 넘으면 그날은 건너뜀. 그날 기록을 이미 확정했다면 SKIPPED.
  - 시각을 이미 지난 값으로 바꾸면 오늘은 SKIPPED 로 남기고 내일부터 적용한다. 오늘 이미 보낸 뒤 시각을 바꿔도 같은 날 두 번째 알림은 없다.
- **결과 알림**(`sweepResults`): `pipeline_states` 를 읽어 완료(제작 DONE+검수 PASSED+결과 버전 ≥1, 2번째 이상 버전은 "수정 완료"), 처리 실패, 백업 실패를 알린다. 키는 `<종류>:<기록>:v<결과 버전>` 이라 같은 상태에 대해 1번만 만든다. 알림 URL 은 `/?record=<id>` — 생활일과 상관없이 해당 기록 상세가 열린다. 최근 48시간 안에 바뀐 기록만 대상(배포 직후 과거 기록 일괄 알림 방지).
- **전달**: `PushSender`(Web Push/VAPID). 푸시 서비스 수락은 `ACCEPTED`(기기 표시 보장 아님). 일시 오류는 최대 3회(1분·2분 간격) 후 `FAILED`, 404/410 은 구독만 비활성, 권한 거부·구독 없음은 `UNDELIVERABLE`.
- **격리**: 전달 결과는 `notifications` 에만 기록한다. `interviews`·`pipeline_states`·`record_versions` 는 읽기만 하므로 전달 실패가 제작 실패·기록 삭제로 이어지지 않는다. 워커의 알림 단계는 단계별로 오류를 삼켜 작업 큐를 막지 않는다.
- **권한·안내**: 브라우저가 `PUT /api/notifications/permission` 으로 권한을 보고. `GET /api/notifications/status` 가 최근 알림과 사유별 안내(기록·영상은 그대로임 포함)를 준다. 웹의 "알림" 패널이 시각 설정·권한 상태·재확인·실패 안내를 보여 준다.

## 운영
- `VAPID_KEYS_FILE`: JSON `{"subject":"mailto:…","publicKey":"…","privateKey":"…"}` 서버 파일 경로. 저장소·로그에 키를 남기지 않는다. 없으면 발송은 `PUSH_NOT_CONFIGURED` 로 실패 처리(전달 성공으로 오인하지 않음)되고 웹은 연결 불가를 안내한다.
- 워커(`npm run start:worker`)가 예약·스윕·전달을 수행한다. 마이그레이션 `0008_notifications.sql`.
- 서비스 워커 `apps/web/public/sw.js` 가 푸시를 표시하고 클릭 시 알림 URL 로 이동한다.

## 시험
- `apps/server/src/notify/notify.test.ts` (시계 제어·중복·설정 E2E·완료 이벤트·전송 오류, 실제 PostgreSQL), `apps/web/src/notify.test.ts`.
- `npm run test:notify-e2e`: 설정 화면(PC·Android 에뮬레이션), 시각 저장·유지, 권한 거부 안내, 전달 실패 안내, 알림 URL 로 기록 열기.

## 한계
- Android 실기기 알림 표시·doze 는 이 Task 에서 실행하지 않음(TASK-6 서버기록 참고, PM·관리자 수행). TASK-51 브랜치(a752bf3)는 이 체크아웃에 없어 병합하지 못했고, 필요한 VAPID 발송·구독 API·서비스 워커를 이 Task 범위에서 새로 구현했다.
- 알림 클릭 시 로그인 세션이 만료돼 있으면 로그인 후 `?record=` 가 유지되지 않을 수 있다.
- 제작 파이프라인이 상태를 바꾸는 시점에 즉시가 아니라 워커 폴링 주기(기본 2초) 안에 알림이 만들어진다.
