# TASK-23 사진 기반 그림 배경과 캐릭터 자산

코드: `apps/server/src/video/{imageInput,imageProvider,assetStore,sceneAssets}.ts`, 시험 `sceneAssets.test.ts`.

## 흐름
1. `generateBackground(ctx, scene, photo)`: 설명 문장 중 제외 분류(정치·비방·뒷담화·형사) 문장 제거 → 사진 메타데이터(EXIF·GPS) 제거·축소 → 프롬프트(색연필 스케치, 글자·상표 금지, 캐릭터 제외) 구성.
2. 모든 호출은 `paidCall`(TASK-13)로 예약→호출→확정. 장당 추정 100원(`IMAGE_ESTIMATE_KRW`). 멱등키 = 범위+자산키+입력해시+시도 번호.
3. 결과는 `AssetStore`에 임시 파일→이름 변경으로 저장. 실패·대기는 `status.json`에만 기록하고 기존 이미지·메타는 바꾸지 않는다.
   - 예산 부족 → `WAITING_BUDGET`(제공자 호출 0회), 4xx 거절 → `FAILED`(예약 해제), 5xx·네트워크·빈 응답 → `WAITING_RESULT_UNKNOWN`(예약 유지, 같은 요청 재전송 없음), 사진 그대로 반환 → `SAME_AS_INPUT`.
4. `generatePose`: 기준 시트 `assets/character/A-ref-v1.jpg`(SHA-256 고정)를 참조로 보내고 메타에 시트 해시를 기록. 같은 표정·동작 조합은 재사용(비용 0).
5. `buildLayers`/`composeFrame`: 배경(글자 없음)·캐릭터·학습 문장은 별도 레이어. 학습 문장은 그림에 굽지 않고 `learning.lines`로 전달(자막 합성은 TASK-24).

## 실제 제공자
`GeminiImageProvider`(gemini-3.1-flash-image, 9:16). 키는 `DAILY_LOG_GEMINI_KEY_FILE`(0600, `voice/keys.ts` 방식). 러너에서는 호출하지 않았고 요청 형식은 가짜 fetch로만 시험했다. 실제 API 응답 형식·화풍·구조 보존 품질은 PM 서버 실측 필요.

## 한계
- 모의 제공자는 FFmpeg 윤곽선 변환이라 화풍 근거가 아니다(경로 검증 전용).
- 장면 배경이 사진의 구조를 보존하는지는 자동 판정하지 않는다(시각 검수).
- 작업 큐 단계·API 라우트 연결은 포함하지 않았다(후속 합성 Task에서 호출).
