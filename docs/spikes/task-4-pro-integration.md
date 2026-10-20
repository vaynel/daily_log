# TASK-4: Pro 연동 지원과 한도 대기 검증

검증일: 2026-10-20 UTC. 기준 commit: `0962c94ba0ce34200ba1105ddcac9f566be0c336`.
작업 브랜치: `task-4-pro-spike`. 판정: **PARTIAL / BLOCKED**.

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

실제 shell `codex --help`: exit 127, `command not found`.
Node `spawnSync('codex', ['--help'])`: `ENOENT`, exitCode null. 두 표현은 같은 실행 파일 부재를 뜻한다.
버전, CLI 옵션, 구독 유형, 잔량, 계정 권한은 확인하지 못했다. 별도 CLI 설치나 인증 파일 탐색으로 개발 임시 인증을 우회하지 않았다.

| 시험 | 합성 입력/기대 | 결과 | 사유 |
|---|---|---|---|
| 텍스트 질문 | 오늘 독서에 관해 질문 1개 | NOT_RUN | 실행 가능한 CLI·검증된 제품 인증 없음 |
| 기록 정리 | 오늘 책을 10분 읽었다 → 사실 1개 요약 | NOT_RUN | 동일 |
| 허용 첨부 해석 | 단색 PNG → 색상 설명 | NOT_RUN | 동일; 모델별 첨부 지원도 미확인 |
| 실제 한도 오류 | 자연 관측 시 대기 | NOT_RUN | 한도 고의 소진하지 않음 |
| 실제 인증 만료/재연결 | 공식 재인증 후 같은 경로 확인 | NOT_RUN | 인증 폐기·복사하지 않음 |
| 오디오/비디오·전사 | 이 구독 경로에 전송 | 미지원(공식 문서) / 요청 NOT_RUN | 위 Preview limitations |

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

재현:

```sh
npm ci
npm run check
node scripts/pro-spike.mjs
npm run scan:secrets
```

관측 결과: 최초 모듈 부재로 수집 실패 후 인터페이스 stub에서 25/25 assertion 실패를 확인했다. 구현 후 `npm run check` exit 0: 새 통제 시험 25개와 기존 4개, 총 29개 통과. web은 테스트 파일 없음(exit 0)이며 UI 시험 통과로 세지 않는다. lint·typecheck·server/web build 통과. DB/Redis 변경 없음, 실서버·브라우저·실기기 시험 없음.

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
| AC-1 공식 근거 + 실제 계정 시험 | PARTIAL | 공식 문서 확인, 실제 계정 NOT_RUN |
| AC-2 요청 결과 또는 미지원 사유 구분 | PARTIAL | 시험표·문서상 제한 구분, 실제 3종 요청 NOT_RUN |
| AC-3 한도/만료 유료 대체 없음 | PARTIAL | 오프라인 25개 통제 시험 PASS; 실제 어댑터/계정 시험 없음 |
| AC-4 의존 착수 차단 조건 | PASS | TASK-9/13/19 차단·해제 조건 명시 |

공용 계획 D03-01/02/03은 미실행 근거와 함께 BLOCKED로 남긴다. D03-04만 문서 증거로 완료한다. 전체 완료·review-request를 보내지 않고 PARTIAL report와 block을 제출한다. 배포·유료 호출·인증 변경 없음. 원격 PR/아티팩트 발행은 수행하지 않았다.
