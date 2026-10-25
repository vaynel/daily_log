# TASK-19 그날 대화와 자료 기반 인터뷰

## 구성
- `apps/server/src/interview/policy.ts`: 인터뷰 지시문(`INTERVIEW_INSTRUCTION`), 그날 첨부·대화 맥락 조립(`buildInterviewInstruction`), 대화 뒤 정리 구분 규칙(`ORGANIZE_INSTRUCTION`, `parseStatements`).
- `voice/pipeline.ts` 의 `INSTRUCTION` 은 위 지시문을 가리킨다. Live `systemInstruction` 은 `voice/live.ts` 가 제품 모드에서 `buildInterviewInstruction` 으로 만든다.
- `interview/routes.ts` 가 그날 기록(`loadById`)의 대화·첨부만 넘긴다. 다른 날 기록을 가져오는 경로가 없다(맥락 격리).
- `records/store.ts` 의 첨부 조회에 `kind`, `original_name` 을 추가했다(지시문에는 종류·이름만, 내용은 싣지 않음).
- `interview/eval.ts`: 대표 대화 평가표(질문 하나, 70자 이하, 막연한 질문, 같은 틀 반복, 전날 근거, 건너뛴 주제 반복, 첨부 단정, 따라 말하기).

## 정책 대응
| 항목 | 반영 |
|---|---|
| AC-1·5 | v2 지시문 규칙 맨 앞: 물음표 1개, 두 문장 60자 이내(평가표 상한 70자), 요청 없으면 설명하지 않음 |
| AC-2 | 사용자 발화·오늘 첨부 목록만 근거, 전날 진척 이어 묻기 금지 |
| AC-3 / D16-03 | 대답한 주제·"넘어가자" 주제 재질문 금지, 학습 안 한 날은 독서·생각·내일 계획으로 전환 |
| AC-4 | 첨부는 이해·수행의 증거가 아님. "해 보셨어요, 읽어 보신 정도예요?" 식으로 묻기 |
| AC-6 | 공감 한 문장 + 선택지 있는 꼬리 질문, 깊이 사다리, 5영역 추적 |
| D16-02 | 출퇴근·회사 배경은 1~2턴 |
| D16-04 | 정리 단계 출력을 FACT/MATERIAL/OPINION/UNCERTAIN 으로 구분, 첨부 내용이 사용자 사실로 둔갑하면 거절 |

## 실제 모델 평가 (PM 실측, 이 러너 재현 아님)
gemini-3.1-flash-live-preview·Achird·ko-KR, 같은 12턴 대본, 첨부 whiteboard.jpg·echo-fix-notes.md. 1차(ecdcd00 지시문 1,944자) 위반 15건(MULTI_QUESTION 10, TOO_LONG 5, 첨부 사진 내용 지어냄), 2차(v2 지시문) 위반 1건(1턴 MULTI_QUESTION), 답변 30~56자, 추정 158원. 원자료는 서버 `~/daily-log-assets/task-19-eval/`. 평가표는 첨부를 본 듯 말하는 표현(`SEEMS_TO_SEE_ATTACHMENT`)도 잡는다.

## 검증 절차
`npm run lint && npm run typecheck && npm test && npm run build && npm run test:spike`, 개별: `cd apps/server && npx vitest run src/interview`.

## 한계
- 평가표 시험은 사람이 정한 시나리오 전사로 평가표와 지시문 구성을 검증한다. 이 러너는 유료 호출 금지로 실제 Gemini Live 를 호출하지 않았고, 모델 품질 근거는 위 PM 실측 인용이다. run1 회귀 시험은 원본 run1.json 이 없어 PM 보고 문구 유형으로 재구성한 전사를 쓴다. 실기기 대화 10턴 이상 평가와 사용자 자연스러움 4/5 는 사용자 평가가 필요하다(NOT_RUN).
- `parseStatements` 는 Pro 정리 단계에 연결할 검증기이며, 정리 단계(브리핑·대본) 자체는 이 Task 범위가 아니라 호출 연결은 하지 않았다.
- PostgreSQL 이 없어 `store.ts` 의 첨부 컬럼 추가 쿼리는 실DB 로 실행하지 못했다(마이그레이션 0003 컬럼 기준).
