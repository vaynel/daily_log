# TASK-26 F97-1 재작업

기준 checkout: f937ce22bfcb5957a2ce3439a33392f8294a6212 (TASK-97 독립 검수 제출).
고정 실행: e4b9b423-97b5-48e5-b236-952e5486a507.
immutable `/run/mandu/MANDU-HANDOFF.json`과 Mandu get_task의 이전 제출·선행 TASK-15/25 보고를 확인했다.

## 수정

기존 검사는 장면 내부만 연결했다. 같은 제외 문구가 두 장면 자막에 나뉘면 통과한 독립 반례를 수정 전 재현했다 (`before.txt`).
대본·시각 설명·전사·자막·확대 문구를 각각 영상 순서대로 연결해 기존 제외 분류/사용자 규칙/이번 영상 제외 문구 검사에 적용한다. 빈 구분자와 공백 구분자로 단어 분할 및 구절 경계를 검사한다. 구성 요소끼리 섞지 않는다.
경계 실패는 scene=null, scope:all-scenes 및 해시만 기록한다. 기존 qualityStage가 실패 component를 repairStages로 변환하므로 해당 구성 요소 단계 전체를 보수적으로 재제작한다. 세밀한 장면별 재제작 최적화는 하지 않는다.

새 단위 회귀 16개: 다섯 구성 요소 × 세 제외 방식, 세 장면 분할/안전 대조군. 수정 전 16 FAIL/기존9 PASS → 수정 후25 PASS. 독립 반례도 같은 장면/다른 장면 모두 false (`after.txt`).
기존 실제 MP4/PG 통합시험에 cross-scene 사례를 추가했다. 실패 상태·파일 SHA 보존·자막 단계만 재실행·재검수 통과 후 완료·DB 근거 저장을 검증하도록 했다. 이번 환경에서는 DATABASE_URL 부재로 실행하지 못했다.

## 실행 한계 및 미통과 항목

- DATABASE_URL 및 REDIS_URL 모두 미주입(값 출력 없이 존재 여부 확인). 임의 호스트/운영 DB를 사용하지 않았다. 필요한 환경 주입을 사용자에게 요청했다.
- targeted.txt: 25 PASS / 20 SKIP. integration.txt: 3 SKIP. 공통계획 최초 증거의 45 PASS 오기는 재개 후25 PASS/20 SKIP으로 정정했다.
- restart.txt 최초 실행은 build 전 dist 부재. build 후 restart-after-build.txt는 DATABASE_URL required로 exit1. 실제 재시작 시험 NOT_RUN.
- 실제 STT/그림 의미 판정/유료 API/계정/실기기/운영 worker 연결은 검증하지 않았다. 기존 키워드 판정의 표현 누락 한계는 유지된다.
- Wiki/Flowchart/list_team 도구가 scoped MCP에 없어 원문은 미열람. README, quality/qualityStage/renderStage, exclusion/rules, 시험 및 선행 검수 문서를 읽었다. 패킷 systematic-debugging/TDD/verification-before-completion과 고정 커밋의 writing-good-tests를 적용했다.
- 배포·push·runner claim/ACK/recovery·artifact publication 없음. 최종 승인하지 않는다.

## 재실행

제공 격리 DATABASE_URL 주입 후:

```sh
npm test -w apps/server -- src/video/quality.test.ts src/video/qualityStage.test.ts src/video/qualityQueue.test.ts src/jobs/queue.test.ts
npm run build -w apps/server
node scripts/quality-restart-e2e.mjs
```

DB 항목을 실제 검증하고 공통계획 BLOCKED 항목을 증거로 완료한 뒤 독립 재검수를 요청해야 한다. 이전 실행의 PASS를 이번 PASS로 대체하지 않았다.

## 최종 실행 결과

- npm run check: lint/typecheck, 서버308 PASS/103 SKIP, 웹29 PASS, CLI37 PASS/Windows4 SKIP, build, spike5 PASS. 마지막 records-crash에서 DATABASE_URL 필요로 exit78. 이후 queue-restart/notify는 미실행.
- npm run build 및 최종 server typecheck 별도 exit0, git diff --check 및 scan:secrets 통과.
- UI 최초 잘못 전달한 Vite 인자로 IPv4 연결 거절, 올바른 시작 후 FFmpeg 병행 중 pids 214/256 스레드 제한으로 Chromium launch 실패(ui.txt). 서버 시험 종료 후 같은 Chromium 재실행 PASS(ui-retry.txt): 실제 React DOM 검수 미통과, 사유2개, 다운로드 없음. API는 합성. 화면 변경 없음. REVIEW 이미지 첨부 upload 2bcfdc8b-e93e-4313-8451-fe097de035a5.

| 조건 | 이번 판정 | 근거 |
|---|---|---|
| AC-1 제외 누출 거절 | PASS | 독립 반례 after.txt, 5구성요소×3방식 및3장면 회귀25 PASS |
| AC-2 재제작 최대1회 | NOT_RUN | DB 미주입으로 qualityQueue skip; 선행 PASS는 역사적 근거 |
| AC-3 별도 카운터 | NOT_RUN | 동일 사유 |
| AC-4 재시작 지속 | NOT_RUN | restart-after-build.txt DATABASE_URL required |
| AC-5 미통과 정상완료/공개 차단 | PARTIAL | UI DOM PASS, 실제MP4/PG 통합3 SKIP |

최종 PARTIAL/BLOCKED: F97-1 코드 수정과 단위 반례 검증 완료, DB 검증 필요.

REVIEW 이미지를 직접 확인했다. 한글 렌더링 정상, 상단 검수 미통과·두 사유 표시. 합성 API가 상세 기록만 제공하여 하단 오늘 대화/알림에는 연결 오류 안내가 보이며 해당 기능 검증 증거가 아니다.
