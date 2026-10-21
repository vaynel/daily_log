# TASK-11 생활일별 기록·버전·자동 저장

범위: DB 스키마와 `RecordStore`(서버 내부 API). 인증 없는 HTTP 라우트는 추가하지 않았다(TASK-10 병행). 화면/브라우저 E2E는 TASK-16/17.

## 구성
- `apps/server/src/db/migrations/0002_life_day_records.sql` — interviews(생활일 `life_date` date + 실제 `started_at` timestamptz), interview_resumes(재개 시각 별도), conversation_items, attachment_refs, record_versions(SUMMARY/PRODUCTION_PLAN/RESULT 누적), pipeline_states(production/review/backup 독립 열), audio_segments.
- `apps/server/src/records/time.ts` — Asia/Seoul 변환, 생활일 제안(05:00 KST 전이면 전날), 달력 한 달 만료(말일 보정).
- `apps/server/src/records/store.ts` — `RecordStore`. 모든 시각은 호출자가 `now`로 주입(시계 제어).

## 생활일 규칙
- 신규 인터뷰 기본값은 제안일(05:00 KST 전 → 전날). 선택 가능한 신규 날짜는 제안일과 서울 오늘 달력일뿐이다(05:00 KST 전: 전날·당일, 이후: 당일만. TASK-62에서 '제안일 전날' 허용을 제거). 그 외 기록 없는 과거 날짜는 `EMPTY_PAST_DATE`, 미래/잘못된 날짜는 `INVALID_LIFE_DATE`로 거부하고 행을 만들지 않는다.
- 같은 (소유자, 생활일) 기록이 있으면 새로 만들지 않고 이어보기. 생활일·시작 시각은 불변, 재개 시각만 추가.
- 기존 작성 중 기록은 위 허용 창과 무관하게 원래 생활일로 재개되며 실제 재개 시각이 `interview_resumes`에 별도 기록된다.
- 동시 시작(TASK-62 F11-01): 기존 행 조회 → 없으면 `INSERT ... ON CONFLICT (owner_id, life_date) DO NOTHING` → 충돌 시 먼저 만들어진 행을 재개. 동시 N회 모두 성공·같은 id·행 1개이며 원시 DB 오류는 노출되지 않는다.
- 확정(`confirm`) 후 `startProduction`은 revision을 올리고 PRODUCTION_PLAN 버전을 누적한다.

## 음성 보관
최초 저장 시각과 만료 시각(서울 기준 다음 달 동일 일·시각, 없으면 말일)은 첫 저장 시 확정, 같은 키 재전송·재접속은 `ON CONFLICT DO NOTHING`으로 값을 바꾸지 않는다. 만료 시각 이후에는 `status=EXPIRED, recovered=false`이며 상태 변경은 `AUDIO_EXPIRED`로 거부. 실제 파일 삭제·Drive 백업 검증 만료 정리는 범위 밖.

## 검증 절차
```
DATABASE_URL=... npm run test -w apps/server      # 단위·DB 시험(임시 스키마 사용 후 삭제)
npm run build && npm run test:records-crash        # 별도 OS 프로세스 SIGKILL 중단 E2E
```
중단 E2E: 자식 프로세스가 항목+첨부를 한 트랜잭션으로 저장하는 중 SIGKILL → 새 프로세스가 같은 DB에서 복구. 또 트랜잭션 중간(항목 INSERT 후 첨부 INSERT 전)에 SIGKILL → 부분 기록 0건 확인.

## 확정 후 저장 정책 (TASK-62 F11-02)
확정(CONFIRMED)된 기록에 대한 새 항목·첨부 저장(`saveItem`/`saveAttachment`/`saveItemWithAttachment`)은 `CONFIRMED_LOCKED`로 **거부**한다. 내용이 같은 기존 키 재전송은 `duplicate`로 응답(네트워크 재시도 안전), 같은 키에 다른 내용은 `IDEMPOTENCY_CONFLICT`. 근거: Wiki05 v9 "확정 후 자동 변경 금지, 조용히 덮어쓰지 않음". 확정 이후의 변경은 `startProduction`이 revision을 올리고 PRODUCTION_PLAN 버전을 누적하는 경로로만 남으며 이전 버전은 보존된다. 확정본 내용 수정용 revision 생성 API는 화면/라우트 설계(TASK-16/17)에서 정한다.
