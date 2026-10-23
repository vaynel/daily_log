# TASK-69 기록 목록 페이지 나누기 · 결과 파일 없음 표시

- `GET /api/records?limit=&cursor=`: 생활일 내림차순. 기본 50건, 최대 100건(범위 밖·형식 오류는 400). 응답 `{ records, nextCursor }`, `nextCursor` 는 마지막으로 준 생활일이며 null 이면 마지막 페이지. (owner_id, life_date) 가 유일해 중복·누락이 없다.
- 정상 완료로 보이는 기록은 이 페이지 분량만 결과 파일 존재를 확인하고, 없으면 상태가 `RESULT_FILE_MISSING`('결과 파일 없음', 경고 톤)이다. 상세도 동일. 다운로드 숨김·경고는 기존 그대로.
- 웹: '이전 기록 더 보기'로 이어 붙이고(id 중복 제거), 달력은 보고 있는 달 첫날까지 자동으로 이어 불러온다.
- 검증: `npm run check`, `DATABASE_URL=... node scripts/paging-e2e.mjs`(PC·Android 에뮬레이션, 합성 데이터; 실기기 아님).
- 제외: 검수 미통과 결과 다운로드 정책, 달력 기능 변경.
