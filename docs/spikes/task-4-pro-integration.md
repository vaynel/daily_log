# TASK-4: Pro 연동 지원과 한도 대기 검증

검증일: 2026-10-20 UTC. 기준 commit: `0962c94ba0ce34200ba1105ddcac9f566be0c336`.
재시험 seed: `85c51ca30d998eff25038ca3c72d930d65854650` (이전 제출 보존). 격리 `/workspace`에서 작업. 판정: **PARTIAL / BLOCKED**.

## 결정

조건부 공식 연동 경로는 존재한다. 그러나 이 프로젝트의 실제 계정·호스팅·입력 조합은 검증되지 않았다.
현재 제품 구독 연동을 활성화하지 않는다. 개발용 Codex 러너가 이 작업을 수행하는 사실은 제품 서비스 지원의 증거가 아니다.
지원 불가로 확정한 것과 환경 부재로 시험하지 못한 것을 구분한다.

## 공식 근거 (조회일 기준)

- [ChatGPT plan usage 개요](https://developers.openai.com/siwc/token-sharing-open-source): OSS/로컬 앱에서 사용자 동의 아래 eligible Responses 요청에 구독을 사용할 수 있다. 유료/원격 호스팅 앱은 별도 관심 등록 경로를 안내한다. 개인 서버라는 이유만으로 적용을 확정할 수 없다.
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): OSS 앱 VM에 별도 host ID와 보호된 인증 세션을 사용하는 절차가 있다. 이 문서의 인증 이전 예시는 이번 작업의 인증 복사 금지를 해제하지 않는다. 실제로 인증 파일을 읽거나 옮기지 않았다.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): 모델이 받는 텍스트·이미지·파일 입력은 후보. 이 경로는 오디오/비디오 입력, Files 업로드, 전사 API를 지원하지 않는다. HTTP Responses는 `store:false`, `stream:true`와 명시적 입력 문맥을 요구한다. 따라서 음성 인터뷰 전체를 Pro 연동 하나로 해결한다고 가정할 수 없다.
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery): 권한 누락은 추론을 막는다. 오류는 유료 경로로 자동 전환하지 않는다. 429 구독 사용량 오류는 앱별 한도일 수도 있으므로 전체 잔량이나 리셋 시각을 추정하지 않는다. 401/403은 인증·권한 확인, 503은 자격정보를 보존한 제한적 재시도 대상이다.
- [Codex authentication](https://learn.chatgpt.com/docs/auth): 구독 로그인과 사용량 기반 API 키 인증은 구분된다.
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): `codex exec` 자동화와 저장된 CLI 인증 재사용을 설명한다. 이는 임시 개발 인증을 제품 인증으로 재사용해도 된다는 근거가 아니다.

Wiki 07/09 및 F04 원문 조회 도구가 없어 원문 미열람. 고정 Task 패킷의 PM 요약, 선행 TASK-1/2 보고서, README를 읽었다. `/run/mandu/MANDU-HANDOFF.json`만 제출 기준 증거로 읽었으며 수정하지 않았다.

## 실제 관측과 최소 요청 시험표

이전 `codex --help` exit 127 / `spawnSync('codex')` ENOENT는 **PATH 탐색 실패**였다. CLI 자체 미설치라는 이전 해석을 정정한다.
이번 `node /opt/codex/bin/codex.js --version`은 `codex-cli 0.157.1`, `--help`와 `exec --help`는 exit 0이다.
`login status`는 ChatGPT 로그인을 보고했다(원문은 출력·보관하지 않고 인증 방식만 분류). Pro 등급·계정 잔량·제품 SIWC 권한은 확인하지 않았다.
CODEX_HOME은 현재 격리 세션 값을 유지했고 인증 파일·토큰을 읽거나 복사하지 않았다. 모델을 지정·교체하지 않았다.

[실제 요청 증거](task-4-live-evidence.json)는 **개발 세션**의 기존 로그인으로 실행한 합성 요청이다. 각 건에서 exit 0, `turn.completed`, 기대 내용 일치, 도구 호출 0을 확인했다. 개인 원문이나 응답 원문 대신 불리언 판정만 남겼다.

| 시험 | 합성 입력/내용 검증 | 개발 세션 결과 | 제품 SIWC 결과 |
|---|---|---|---|
| 텍스트 질문 | 오늘 책을 10분 읽었다 → 책에 관한 질문과 물음표 | PASS | NOT_RUN: 제품용 동의·권한 미검증 |
| 기록 정리 | 동일 기록에서 읽은 시간 숫자 10 추출 | PASS (최소 사실 추출만) | NOT_RUN: 동일 |
| 허용 첨부 해석 | 합성 32×32 단색 PNG → red | PASS | NOT_RUN: 동일 |
| 실제 한도 오류 | 자연 관측 시 대기 | NOT_RUN: 한도를 고의 소진하지 않음 | NOT_RUN |
| 실제 인증 만료/재연결 | 공식 재인증 후 같은 경로 확인 | NOT_RUN: 인증을 폐기하지 않음 | NOT_RUN |
| 오디오/비디오·전사 | 이 구독 경로에 전송 | 미지원(공식 SIWC 문서) / 요청 NOT_RUN | NOT_RUN |

최초 이미지 명령은 `-i`의 가변 인자가 뒤의 프롬프트까지 소비하여 추론 전 exit 1(stdout 0 bytes)로 종료됐다. `--`로 프롬프트를 분리한 뒤 3종 시험을 수행했다. 중간 별도 `Reply only OK` smoke 명령은 exit 0이었으나 내용 판정을 보관하지 않아 위 3종 증거로 세지 않는다. 총 exec 실행은 5회(시작 전 실패 1, smoke 1, 본 시험 3). 이는 CLI 실행 수이며 제공자 청구 로그나 내부 HTTP 시도 횟수가 아니다.

## 구현 및 통제 시험

`apps/server/src/spikes/pro-request.ts`는 **오프라인 검증용 호출 경계**다. HTTP API/worker에 연결하지 않았고 실제 OAuth/CLI/Responses 어댑터는 없다. 프로덕션 전체의 과금 안전성이 검증됐다고 주장하지 않는다.

- support/auth/quota가 명시적으로 확인되지 않으면 0회 호출로 대기한다.
- 현재 spike는 텍스트만 허용한다. 이미지·파일은 upstream 전체 미지원이 아니라 프로젝트 미검증으로 보수적으로 차단한다.
- 주입한 구독 어댑터만 최대 1회 호출한다. API 키·다른 모델·유료 fallback·자동 retry 경로가 없다.
- 429 → WAIT_LIMIT, 401 → WAIT_AUTH, 403 → WAIT_SUPPORT, unsupported capability → UNSUPPORTED_INPUT, 503 → WAIT_RETRY. 그 외는 WAIT_REVIEW.
- 전송 예외/응답 유실 → WAIT_RECONCILIATION. 실제 처리 여부가 불명확하므로 즉시 재전송하지 않는다.
- 성공은 어댑터가 전체 응답 완료를 확인한 경우에만 반환해야 한다. HTTP 200이나 스트림 시작만으로 성공을 반환하면 안 된다.
- 반환 증거는 상태와 호출 횟수만 포함한다. 원문·토큰·외부 오류 메시지를 로그에 남기지 않는다.

[실행 증거 JSON](task-4-evidence.json)은 `scripts/pro-spike.mjs`가 생성했다. CONTROLLED는 합성 어댑터이며 실제 OpenAI 응답이 아니다. 호출 배열은 이 경계의 어댑터 호출만 센다. externalInferenceCalls=0은 이 오프라인 실행의 구조상 외부 추론이 없다는 뜻이며 제공자 청구 로그를 조회했다는 뜻이 아니다.

오프라인 JSON의 `liveAccount: NOT_RUN`은 그 **오프라인 실행에서** 실제 요청을 하지 않았다는 뜻이다. 실제 개발 세션 관측은 별도의 LIVE_DEVELOPMENT_SESSION JSON만 참조한다.

경로 수정은 실행파일과 인자를 문자열 배열로 받으며 shell을 사용하지 않는다. 회귀 테스트에서 빈 PATH와 공백 포함 경로로 RED(ENOENT) → GREEN을 확인했다. 존재하지 않는 명시 경로는 다른 CLI로 대체하지 않는다.
`pro-live-spike.mjs`는 승인된 수동 시험 전용이며 `--run`이 필요하다. 로그인 상태가 ChatGPT가 아니면 요청 0회, API 키 환경변수는 자식 프로세스에서 제거한다. 실패 시 남은 시험을 NOT_RUN으로 멈추고 자동 재시도·유료 대체를 하지 않는다. `--ephemeral`, read-only와 도구 사용 금지 프롬프트를 사용한다. timeout은 처리 여부 불명확으로 보고 재요청하지 않는다. CLI 내부 동작 전체나 청구 내역을 감시하는 보안 경계는 아니다.

재현:

```sh
npm ci
npm run check
node scripts/pro-spike.mjs node /opt/codex/bin/codex.js
# 기존 개발 세션 요청에 대한 승인 범위 안에서만 별도 실행
node scripts/pro-live-spike.mjs --run node /opt/codex/bin/codex.js
npm run scan:secrets
```

이전 실행 관측 결과: 최초 모듈 부재로 수집 실패 후 인터페이스 stub에서 25/25 assertion 실패를 확인했다. 구현 후 `npm run check` exit 0: 새 통제 시험 25개와 기존 4개, 총 29개 통과. web은 테스트 파일 없음(exit 0)이며 UI 시험 통과로 세지 않는다. lint·typecheck·server/web build 통과. DB/Redis 변경 없음, 실서버·브라우저·실기기 시험 없음.

재시험 `npm run check` exit 0: lint·typecheck·server/web build 및 서버 29개 통제/기존 시험, CLI 경계 회귀 5개 통과. web은 테스트 파일 없음. `npm run scan:secrets`는 42 files OK, `git diff --check` exit 0. CLI 경계 시험은 합성 자식 프로세스로 정상 완료 3회, API 인증 시 0회, 한도 오류 시 1회 뒤 중단을 검증한다. 실제 구독 한도·만료 관측이나 제품 재연결 시험으로 세지 않는다.
`npm ci`는 기존 잠금파일 기준 취약점 3건(중간 1·치명 2)을 보고했다. 의존성 업그레이드는 이 수정에 포함하지 않았다.

## 호출 경계·인증 보관·재개 계약

향후 제품 어댑터는 지원되는 앱/호스팅 범위와 사용자 구독 권한을 먼저 검증해야 한다. 요청자가 전달한 support/auth/quota 값을 신뢰하면 안 된다. spike context는 그 계약의 모형이며 현재 서버 인가를 구현한 것이 아니다.

인증은 제품 소유의 공식 로그인·동의 흐름으로 마련하고 보호된 서버 저장소에 한정한다. 브라우저 응답·로그·Git·일반 기록 백업에 넣지 않는다. 개발 러너 인증은 읽거나 복사하지 않는다. 토큰 갱신과 host ID 수명주기는 선정한 공식 흐름에 맞춰 별도 검증한다.

WAIT_LIMIT은 확인된 한도 회복 후 재개, WAIT_AUTH는 공식 인증 확인 후 재개한다. 403은 무한 재로그인으로 해결하지 않는다. WAIT_RETRY는 영속 작업 정책에서 처리 오류 재시도 1회 제한을 적용해야 한다. 이 spike는 자동 재시도를 하지 않는다. 응답 유실은 제공자 결과 확인 후 처리하며 영상 품질 재제작 1회와 별도 상태로 관리해야 한다. 영속 큐·스케줄러·재연결 구현은 아직 없다.

## 의존 기능 착수 차단과 해제 조건

TASK-9/13/19의 구독 의존 실행 부분은 **지원·계정 검증 미완료**로 대기해야 한다. 이 문서는 차단 사유를 기록하며 배정되지 않은 Task 상태를 변경하지 않는다.

해제에는 (1) OSS/개인 서버 배치가 공식 지원 범위에 속한다는 확인, (2) 제품용 공식 인증과 구독 사용 권한, (3) 실제 텍스트·요약·허용 첨부 최소 요청 결과 및 비밀값 제거 증거, (4) 어댑터 통합 후 한도/만료 통제 시험과 안전한 재연결 확인이 필요하다. 음성 전사 등 미지원 경로에는 별도 지원 검증이 필요하다. 유료 대안은 자동 선택하지 않으며 별도 승인·권한·월 50,000원 예산 검사가 선행돼야 한다.

## AC 판정

| 조건 | 판정 | 근거 |
|---|---|---|
| AC-1 공식 근거 + 실제 계정 시험 | PARTIAL | 공식 문서·개발 계정 CLI 시험 확인; 제품 SIWC 권한/호스팅 미검증 |
| AC-2 요청 결과 또는 미지원 사유 구분 | PASS | 개발 세션 실제 3종 PASS와 제품 경로 NOT_RUN/공식 입력 제한을 시험표에서 구분 |
| AC-3 한도/만료 유료 대체 없음 | PARTIAL | 오프라인 경계 및 CLI 중단 통제 시험; 제품 어댑터 통합/재연결 NOT_RUN |
| AC-4 의존 착수 차단 조건 | PASS | TASK-9/13/19 차단·해제 조건 명시 |

공용 계획 D03-01/03은 제품 경로 미검증 근거와 함께 BLOCKED로 남긴다. D03-02는 개발 세션 3종 최소 시험 증거로, D03-04는 경계·결정 문서 증거로 완료한다. 전체 완료·review-request를 보내지 않고 PARTIAL report와 block을 제출한다. 배포·유료 호출·인증 변경 없음. 원격 PR/아티팩트 발행은 수행하지 않았다.
