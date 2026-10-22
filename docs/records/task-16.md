# TASK-16 생활일 최신순 목록과 기록 상세

- API(조회 전용, 인증 필수·소유자 한정): `GET /api/records`(생활일 내림차순; 제작·완료 시각 무관), `GET /api/records/:id`(대화 원본·최신 SUMMARY 일기/학습·첨부·상태·다음 행동), `GET /api/records/:id/attachments/:attId/file`, `GET /api/records/:id/result/file`.
- 종합 상태(`records/view.ts`): 작성 중 / 확정·제작 전 / 제작 중 / 예산 대기 / 처리 실패 / 검수 미통과 / 검수 중 / 완료. 제작·검수·백업은 독립 열이며 백업 실패는 별도 행동(백업 다시 시도)로만 표시.
- 마이그레이션 0004: `pipeline_states.production` 에 `WAITING_BUDGET` 추가(처리 실패와 구분).
- 내용 형식(제작 단계 담당이 기록): SUMMARY `{diary, learning[]}`, RESULT `{file}`(= `<FILE_STORAGE_DIR>/videos/<file>`). 파일이 없거나 0바이트면 `fileAvailable=false`, 다운로드 404 `FILE_MISSING`, 화면은 다운로드 대신 안내.
- 범위 밖: 달력 UI(TASK-49), 검색·전체 내보내기, 제작 요청·재시도·백업 재시도 버튼의 실제 동작(행동 이름만 표시).
- 검증: `npm run check`, `DATABASE_URL=... node scripts/records-view-e2e.mjs`(PC·Android 에뮬레이션, 합성 데이터; 실기기 아님).
