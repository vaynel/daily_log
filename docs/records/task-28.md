# TASK-28 결과 확인·음성 수정·다운로드

- 조회: `GET /api/records/:id` (result.playable·confirmedAt·published=false, editableItems), `GET /api/records/:id/results` (현재/이전 버전)
- 재생·내려받기: `GET /api/records/:id/results/:v/file[?inline=1]` (Range 지원). 현재 버전은 COMPLETED(제작 완료+검수 통과+파일 있음)만, 이전 버전은 수정 전에 COMPLETED 였던 경우만. 기존 `/result/file`도 같은 판정(TASK-111).
- 수정: `POST /api/records/:id/revisions` `{commandId, kind: EXCLUDE|EDIT_TEXT|VOICE|RETRY, itemId, text, command}`
  새 SUMMARY·PRODUCTION_PLAN 버전과 작업을 한 트랜잭션으로 만들고 현재 결과를 "이전 버전"(result_version_marks)으로 표식한다. 장면·내레이션·자막은 같은 계획에서 만들어지므로 함께 다시 만든다. 원본 대화는 지우지 않는다. 같은 commandId 는 한 번만 처리.
- 확인: `POST /api/records/:id/result/confirm` — 사용자 명령으로만 기록(시간 경과로 자동 확인·공개 없음).
- 마이그레이션 0011. 품질 재제작 1회·처리 재시도 1회 카운터는 건드리지 않는다(수동 재시도는 기존 `requestManualRetry`).
- 한계: 제작 단계 핸들러(장면·TTS·렌더)는 이 저장소에서 아직 worker 에 연결되어 있지 않아, 실제 재렌더는 큐 작업 등록까지 시험했다.
- 시험: `npx vitest run src/records`(PostgreSQL), `npm run test:result-e2e`(Chromium PC·Android 에뮬레이션, 실기기 아님).
