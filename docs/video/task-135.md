# TASK-135 운영 품질 근거 제공자

기준: `7c7fc423bcd0c584e6b3ffb56878f34831247999`.

`buildVideoRuntime`에서 Gemini 음성 전사·장면/고정 캐릭터 비교, Pro 구독 사실·학습 판정, 실제 자막/확대 매니페스트의 결정적 배치 검사를 연결한다. 사실 판정에는 장면의 evidenceIds에 해당하는 확정 브리핑과 원 사용자 ANSWER를 함께 전달한다. 원자료가 없거나 응답 형식/근거가 비어 있으면 통과하지 않는다. 출력의 원문은 보고서 대신 해시로 남긴다.

자막은 기존 흰 글자에 불투명 `#111` 배경을 추가하여 장면 색상과 무관하게 대비를 확보했다. 확대 화면은 기존 밝은 글자/어두운 배경을 유지하며 글자 크기·줄 폭·줄 수·노출 시간·상자 겹침·표시 원문 보존을 검사한다.

## 설정과 실패 처리

- 기존 `DAILY_LOG_GEMINI_KEY_FILE`(0600), 기존 `createProInfer`/SIWC 지원 확인을 사용한다. 없으면 각각 `QUALITY_GEMINI_UNAVAILABLE`, `PRO_UNAVAILABLE` 권한 대기이며 외부 호출/예산 예약은 없다.
- `DAILY_LOG_QUALITY_MODEL` 기본값은 `gemini-3.8-flash`. 유료 모델로의 Pro 대체 경로는 없다.
- `DAILY_LOG_QUALITY_PRICING_JSON`은 `usdKrw`, `fxMargin`, `taxRate`, `inputUsdPerMTok`, `outputUsdPerMTok`을 덮어쓴다. 기본값은 각각 1500, 0.05, 0.1, 3, 15의 보수적 예산 단가이며 실제 청구 단가나 실측액이 아니다.
- Gemini 요청 전 `MonthlyLedger.reserve`, 응답 후 보수적 예약액으로 `confirm`. Pro도 0원 예약/확정을 기록한다. 명시적 Pro 한도/권한 대기는 0원으로 확정하고 이후 재개 가능하다.
- 응답 유실/HTTP 실패는 안전한 코드 `QUALITY_EXTERNAL_UNKNOWN`으로 정지하고 UNKNOWN 금액을 유지한다. 예약 상태는 남지 않지만 불명 금액은 월 한도에서 계속 점유한다. 확인 없이 환급하지 않는다.
- 요청 내용·미디어·모델의 해시로 원장 키를 만들고 검수 결과는 비공개 작업 디렉터리의 원자적 캐시에 보관한다. 재시작 시 재사용하며, 원장만 있고 응답 캐시가 없으면 중복 호출 없이 확인 대기한다.
- 기존 품질 재제작 1회 및 처리 오류 재시도 1회 큐 정책을 변경하지 않았다. 잘못된 증거/버전은 실패, 품질 반려는 기존 컴포넌트→단계 매핑을 사용한다.

## 추가 비용 상한 추정

`qualityVideoEstimateKrw`는 180초 음성, 장면당 전사 1회와 비전 1회, Pro 0원으로 계산한다. 각 호출은 최대 텍스트 16,000바이트, 출력 2,048토큰, 오디오 초당 32토큰, 이미지 2장 총 16,384토큰을 보수적으로 잡는다. 기본 설정에서:

| 장면 수 | 검수 1회 | 품질 재제작 1회까지 총 2회 |
| --- | ---: | ---: |
| 3 | 1,103.70원 | 2,207.40원 |
| 10 | 3,609.14원 | 7,218.29원 |
| 60 | 21,505.18원 | 43,010.35원 |

장면 계획은 최소 추정 3초/최대 180초이므로 정상 계획의 상한은 60장면이다. 위 수치는 품질 검수의 추가분이며 기존 음성·이미지 생성 비용은 별도다. 전체 월 50,000원 원장이 남은 한도를 매 호출 전에 검사하므로 기존 지출이 있으면 중간에도 예산 대기할 수 있다. 동일 입력 재검수는 캐시가 남아 있으면 추가 비용 0원이다. 실유료 API 호출은 이 작업에서 실행하지 않았다.

## 검증 자료

`task-135-evidence/`에 기준 코드 재현, 실패 전 회귀 시험, 집중·통합·전체 회귀 출력, lint/typecheck 및 BEFORE/AFTER 이미지를 기록한다. BEFORE 이미지는 실제 HEAD/status와 코드 검색 결과를 표시한 REPRODUCTION 화면이며 제품 화면으로 위장하지 않았다.

참조: README, begin_task 고정 패킷, 기존 pipeline/quality/scenePlan/narration/subtitles/zoom/frame, MonthlyLedger, createProInfer, RecordStore.
외부 API 형식은 [공식 generateContent](https://ai.google.dev/api/generate-content), [음성 입력](https://ai.google.dev/gemini-api/docs/audio), [이미지 입력](https://ai.google.dev/gemini-api/docs/image-understanding)을 확인했다. 운영 배포는 하지 않았다.

Gemini 3.8의 요청 설정은 [공식 모델 안내](https://ai.google.dev/gemini-api/docs/latest-model)에 맞춰 `thinkingLevel: LOW`를 사용하며 지원하지 않는 `thinkingBudget: 0`/`minimal`을 보내지 않는다. 응답이 `STOP`으로 끝나지 않거나 JSON 판정이 잘못되면 실패 처리한다.

## 최종 실행 결과

- 영상: 최초 순차 실행에서 10파일/120시험 통과, 추가 경계/통합 2파일 실패는 원인 수정 후 17+1시험 모두 통과. 최종 집중 실행은 이 18개와 narration/runtime 26개를 포함해 4파일/44시험 통과(`final-focused.txt`). 영상 영역의 최종 고유 시험은 총 138개다.
- 나머지 서버: 24파일/360시험 통과(`server-rest.txt`). 따라서 서버 전체 36파일/498개를 순차 범위 실행으로 검증했다.
- 웹: 6파일/39시험 통과. SIWC/voice-measure: 37 통과, Windows 전용 4개 SKIP, 실패 0.
- lint, typecheck, build: 모두 종료 코드 0(`check-exits.json`).
- 최초 RED와 보강 중 실패 출력은 `red.txt`, `red-extended.txt`로 보존했다. 통합 시험의 중간 실패는 같은 요청 원장을 별도 캐시 경로에서 재사용한 시험 구성 때문에 발생했으며, 중복 호출 차단을 우회하지 않고 최초 검수를 운영 런타임에서 수행하도록 시험을 수정했다.
- Wiki 원문은 이 scoped MCP에 조회 기능이 없어 직접 열람하지 못했다. 작업 기준은 begin_task 고정 패킷과 저장소의 실제 구현이다. 실유료 호출·실계정 검수·운영 배포는 미실행이며 작업 제약에 따른다.
