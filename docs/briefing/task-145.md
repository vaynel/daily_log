# TASK-145 — 기술 문장 오탐과 포함 요청

기준: `ac881f908e91c2ff51758870ded8c3f80becee09`.

## 정책 근거

Task에 명시된 Wiki 05/03 요구는 **타인 비방은 영상 제외**, **사이버보안·개발 학습은 일괄 차단하지 않음**이다. 저장소의 [Wiki 09 원문 사본](../wiki/09-acceptance.md) §3도 정치·타인 비방·뒷담화·형사 사건/소송 제외와 보안 학습의 일괄 제외 금지를 명시한다. Wiki 05/03 원문은 이 checkout과 scoped MCP에서 제공되지 않아 Task의 인용을 근거로 삼았다.

- 코드·설계·구조·로직·함수·버그·커밋·쿼리·테스트·데이터·수집기·수집(GC)을 직접 수식하는 기술 표현 또는 해당 대상의 서술 표현만 비방 검사에서 뺀다. 문장 전체를 면제하지 않으므로 같은 문장의 별도 사람 비방은 기본 제외된다.
- `DEFAMATION` 키워드 오탐은 사용자가 브리핑의 **다시 넣기**로 INCLUDE할 수 있다. 이전 버전은 보존하고 새 SUMMARY 버전에 `correction: {itemId, action, previousExcludedReason}`을 저장한다. 현재 분류기가 더 이상 오탐하지 않는 과거 DEFAMATION 항목도 복원 가능하다.
- 정치·형사·뒷담화는 Task의 DEFAMATION 한정 예외 범위 밖이며 공개 제외 근거가 있으므로 INCLUDE 금지를 유지한다. DEFAMATION과 뒷담화가 함께 있는 경우도 뒷담화 판정을 별도로 확인해 우회하지 못한다. UNCERTAIN·MATERIAL·사용자 반복 제외 규칙도 유지한다.
- 명시적인 INCLUDE는 DEFAMATION 기본 제외를 해제한다. 의미 분석으로 실제 비방 여부를 판정하는 기능은 아니다. 재작성(REPLACE) 시에는 다시 분류한다. 최종 영상 선정은 기존 강조 우선·최대 6개 규칙을 유지한다.
- 원본 기록은 삭제하지 않는다. 제작 작업은 기존과 같이 사용자 확인 후에만 생성한다.

## 검증 방법

- `npm test -w apps/server -- --no-file-parallelism src/briefing`: 기술 문장 13개, 사람 대상·혼합 문장 11개, INCLUDE 및 버전 기록, 정치/형사/뒷담화 경계와 기존 브리핑 시험.
- 기준 코드에서 새 회귀 시험 30개 중 15 FAIL / 15 PASS를 확인했다(기술 문장 13개, INCLUDE 반영, 결정 기록). 기존 `scripts/task144-policy.mjs`는 기준 checkout에 없어 실제 함수·API를 호출하는 회귀 시험으로 재현했다. BEFORE 이미지는 이 실행 출력의 REPRODUCTION이며 제품 UI가 아니다.
- `npm run build` 후 `E2E_SHOT_DIR=/workspace/data/task145 node scripts/task145-policy.mjs`: 실제 UI의 기술 문장 표시, DEFAMATION 복원 버튼, 재조회, 저장된 결정, 확인 후 제작 계획을 검증한다. 합성 입력·모의 Pro·메모리 저장소이며 실사용자 기록/실모델 검증이 아니다.
- 전체 서버 시험은 최종 검증에서 한 번만 순차 실행한다. 유료 API·운영 DB·배포는 사용하지 않는다.

키워드 방식의 표현 범위 한계는 남는다. 예컨대 키워드 없이 돌려 말한 비방은 자동 탐지하지 못하며 사용자가 직접 제외할 수 있다.

## 실행 결과 (2026-11-03~04 UTC)

| 검사 | 실제 결과 |
| --- | --- |
| 기준 코드의 새 회귀 시험 | 15 FAIL / 15 PASS (의도한 오탐·INCLUDE·기록 결함 재현) |
| 수정 후 집중 브리핑 시험 | 82 PASS; 이후 경계 시험 2개 추가는 전체 실행에 포함 |
| 전체 서버 `npm test -w apps/server -- --no-file-parallelism` | 41 파일, 567 PASS, 0 FAIL, 341.86초; 전체 실행 1회 |
| 전체 웹 `npm test -w apps/web -- --no-file-parallelism` | 6 파일, 39 PASS |
| `npm run lint`, `npm run typecheck`, `npm run build` | 모두 exit 0 |
| `node scripts/task145-policy.mjs`, `npm run test:briefing-e2e` | 모두 PASS |
| `npm run test:siwc` | 37 PASS, 0 FAIL, Windows 전용 4개 SKIP (Linux 환경) |
| `npm run test:retention-ops` | 2 PASS |
| `npm run scan:secrets` | 529 파일 OK |

실행 로그는 `data/task145/`에 보존한다. BEFORE(시험 출력) 및 AFTER(실제 브리핑 UI) 이미지는 지정된 `/run/mandu/attach-screenshot.mjs`로 Mandu에 첨부했다. 시험은 제공된 격리 PostgreSQL 및 Chromium을 사용했으며 운영 배포는 하지 않았다. Windows 전용 부가 시험은 통과로 주장하지 않는다.
