# TASK-24 내레이션·자막·학습 확대

흐름: 장면 계획(TASK-21 `SCENE_PLAN`) → `runNarrationStage` (`apps/server/src/video/narrationStage.ts`)
→ 장면별 음성(`narration.ts`) → 자막(`subtitles.ts`) → 학습 확대(`zoom.ts`) → 프레임 HTML(`frame.ts`).

- 목소리·읽기 지시는 `assets/voice/voice.json`(`loadVoiceConfig`)만 쓴다. 계획의 `narration.voiceName` 이 다르면 `VOICE_MISMATCH` 로 합성 전에 멈추며, 예비 목소리(Zubenelgenubi)로 자동 대체하지 않는다.
- TTS 는 `paidCall`(예약→확정)로 장면마다 호출. 멱등키 = 날짜·브리핑 버전·장면·목소리/지시/대사 해시. 같은 키 재요청은 새 과금 없이 `TTS_UNKNOWN` 으로 멈춘다(결과 확인 후 처리).
- 실패(5xx·불명 `TTS_UNKNOWN`, 4xx `TTS_FAILED`, 무음·빈 오디오 `TTS_EMPTY`, 예산 `BUDGET_EXCEEDED`, 실제 길이 180초 초과 `OVER_MAX_SEC`)는 모두 `ok:false`. 자막·확대만 있는 결과는 만들지 않는다.
- 자막: 일상=대사 전체(52px), 학습=핵심 문장 최대 2문장·3컷(60px). 글자는 대사 원문에서만 가져오고, 시간은 실제 음성 구간을 글자 수 비례로 나눈다(문장 경계는 추정). 자막 영역 y 1340~1700, 좌우 72px 안전 여백, 최대 2줄.
- 학습 확대: 코드·수식·노트 원문 불변. 줄 경계(빈 줄 우선)에서 조각내고 긴 줄은 보이기만 접고, 접혀 이어지는 줄은 왼쪽 거터(안전 여백 띠, 본문 폭 불변)에 ↳를 그려 실제 줄바꿈과 구분한다(↳는 원문 글자가 아님). 조각당 2.5초를 못 채우면 줄이지 않고 `TOO_MANY_CHUNKS`.
- 학습 자료(`LearningMaterial`)는 호출자가 근거 기록의 원문으로 넘긴다. 자료가 없는 학습 장면은 핵심 자막만 나온다.

## 검증
- `cd apps/server && npx vitest run src/video` (DATABASE_URL 필요: 원장 연동 시험)
- 휴대폰 세로 배치 점검(브라우저, 실기기 아님): `E2E_SHOT_DIR=/tmp/shots node scripts/subtitle-layout-check.mjs` — 한글 글꼴이 없으면 exit 2(`--allow-missing-font` 는 진단용).

## 미검증(PM·관리자 수행)
- 실제 Gemini TTS 호출(`geminiNarrationTts`, 읽기 지시를 요청 앞 문장으로 붙이는 방식이 지시를 읽어 버리지 않는지), 청취, 휴대폰 실기기 자막·확대 가독성, 한글 글꼴 설치 환경에서의 폭 확인.
