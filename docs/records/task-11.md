# TASK-11 생활일별 기록·버전·자동 저장

범위: DB 스키마와 `RecordStore`(서버 내부 API). 인증 없는 HTTP 라우트는 추가하지 않았다(TASK-10 병행). 화면/브라우저 E2E는 TASK-16/17.

## 구성
- `apps/server/src/db/migrations/0002_life_day_records.sql` — interviews(생활일 `life_date` date + 실제 `started_at` timestamptz), interview_resumes(재개 시각 별도), conversation_items, attachment_refs, record_versions(SUMMARY/PRODUCTION_PLAN/RESULT 누적), pipeline_states(production/review/backup 독립 열), audio_segments.
- `apps/server/src/records/time.ts` — Asia/Seoul 변환, 생활일 제안(05:00 KST 전이면 전날), 달력 한 달 만료(말일 보정).
- `apps/server/src/records/store.ts` — `RecordStore`. 모든 시각은 호출자가 `now`로 주입(시계 제어).

## 생활일 규칙
- 신규 인터뷰 기본값은 제안일(05:00 KST 전 → 전날). 선택 가능한 신규 날짜는 제안일, 제안일 전날, 서울 오늘 달력일. 그 외 기록 없는 과거 날짜는 `EMPTY_PAST_DATE`, 미래/잘못된 날짜는 `INVALID_LIFE_DATE`로 거부하고 행을 만들지 않는다.
- 같은 (소유자, 생활일) 기록이 있으면 새로 만들지 않고 이어보기. 생활일·시작 시각은 불변, 재개 시각만 추가.
- 확정(`confirm`) 후 `startProduction`은 revision을 올리고 PRODUCTION_PLAN 버전을 누적한다.

## 음성 보관
최초 저장 시각과 만료 시각(서울 기준 다음 달 동일 일·시각, 없으면 말일)은 첫 저장 시 확정, 같은 키 재전송·재접속은 `ON CONFLICT DO NOTHING`으로 값을 바꾸지 않는다. 만료 시각 이후에는 `status=EXPIRED, recovered=false`이며 상태 변경은 `AUDIO_EXPIRED`로 거부. 실제 파일 삭제·Drive 백업 검증 만료 정리는 범위 밖.

## 검증 절차
```
DATABASE_URL=... npm run test -w apps/server      # 단위·DB 시험(임시 스키마 사용 후 삭제)
npm run build && npm run test:records-crash        # 별도 OS 프로세스 SIGKILL 중단 E2E
```
중단 E2E: 자식 프로세스가 항목+첨부를 한 트랜잭션으로 저장하는 중 SIGKILL → 새 프로세스가 같은 DB에서 복구. 또 트랜잭션 중간(항목 INSERT 후 첨부 INSERT 전)에 SIGKILL → 부분 기록 0건 확인.
