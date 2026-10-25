# TASK-13 외부 호출과 월 예산 제어

## 구조
- `apps/server/src/budget/ledger.ts` — PostgreSQL 월 원장(`budget_entries`, `budget_months`, 마이그레이션 0005). 서울 시각 기준 달. 월 한도는 설정으로도 **50,000원을 넘길 수 없다**(`HARD_MONTHLY_LIMIT_KRW`, DB CHECK 포함).
- `apps/server/src/budget/gateway.ts` — `paidCall`: 예약 → 호출 → 확정/보존. 예약이 거절되면 `run`은 호출되지 않는다.
- 음성 서버(`/voice-test` STT·TTS, `/voice-live` Gemini Live 턴)는 `monthly` 원장이 있으면 모든 호출을 같은 원장에 기록한다. 프로세스 단위 `BudgetLedger`는 보조 장치로 남는다. `voice/main.ts`는 `DATABASE_URL`이 없으면 78로 종료한다(재시작으로 합계가 0이 되는 문제 제거).

## 상태와 규칙
| 상태 | 점유액 | 전이 |
|---|---|---|
| RESERVED | 예상액 | → CONFIRMED(실제액) / RELEASED(외부 호출 전 또는 4xx 명시 거절) / UNKNOWN |
| UNKNOWN | 예상액 | → CONFIRMED / RELEASED 는 `resolveUnknown`에 확인 근거가 있을 때만 |
| CONFIRMED | 실제액 | Live 누적 usage 갱신을 위한 재확정만 허용 |
| RELEASED | 0 | 종료 |

- 새 호출 허용 조건: `확정 + 예약 + 불명 + 이번 예상액 ≤ 월 한도`. 같은 달은 월 행 `FOR UPDATE`로 직렬화해 동시 요청이 같은 잔여를 중복 예약하지 않는다.
- 목적(`PRODUCT`/`TEST`/`RETRY`/`CARRYOVER`)은 구분해 기록하되 합계는 하나다. 재시도·시험 호출도 예약이 필요하다.
- 응답 유실·시간 초과·5xx는 UNKNOWN으로 예약액을 유지하고 환급하지 않는다. Live에서 usage 없이 끊긴 턴도 같다.
- 자동 유료 전환 없음: Pro는 구독 경로(`WAIT_LIMIT`/`WAIT_AUTH`/`WAIT_SUPPORT`)만 쓰고, 대기 상태에서는 다른 모델·호출을 하지 않는다(시험: 호출 스파이).

## 운영 절차
- 이월분 입력(예: 2026-10 기존 지출 약 1,520원): `npm run budget:carryover -w apps/server -- 2026-10 1520 voice-sessions-2026-10 "서버 세션 추정 합계"` (같은 멱등키는 한 번만 반영).
- 현황·불명 항목: `npm run budget:status -w apps/server -- [YYYY-MM]`.
- 불명 항목 정산은 제공자 사용량 확인 후 `MonthlyLedger.resolveUnknown(id, {charged, actualKrw?, evidence})`로만 한다(관리자 도구 연결은 후속).
- 단가·환율·세금 갱신: `DAILY_LOG_VOICE_PRICING_JSON` / `DAILY_LOG_VOICE_LIVE_PRICING_JSON`에 `usdKrw`, 단가, `fxMargin`(기본 0.05), `taxRate`(기본 0.1)를 지정하고 서버를 재시작한다. 원화 환산액에 `(1+fxMargin)(1+taxRate)`가 곱해진다. 기본 단가는 임시값이며 Wiki 07 값 확인이 필요하다(이 러너는 Wiki 원문 미열람).
- 배포 시 `npm run db:migrate`(0005) 후 음성 서버에 `DATABASE_URL`을 주고 이월분을 입력한다. 세션 상한(하루 1회·10분·700원)은 TASK-17이 이 원장을 사용한다.

## 한계
- 이미지 제공자 호출은 아직 구현체가 없어 `paidCall` 경계만 제공한다(해당 기능 Task에서 사용).
- Live는 턴 시작 시 예상액을 예약하고 usage로 확정한다. usage가 예상을 초과한 만큼은 확정 시 사실대로 반영되므로 한 턴 분량의 초과(한도 대비 소액)는 다음 예약부터 차단된다. 한도 직전에서 완전 무초과를 보장하려면 예상액 상향 또는 턴 단위 출력 토큰 제한이 필요하다.
