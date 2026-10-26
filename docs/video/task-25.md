# TASK-25 단일 렌더러 · 세로 영상 합성

흐름: 장면 프레임(`composeFrame`, TASK-23) + 내레이션 구간(`NarrationSegment`) + 자막(`SubtitleCue`) + 학습 확대(`ZoomPlan`, TASK-24) → `renderVideo` (`apps/server/src/video/render.ts`) → 9:16 MP4.

- 출력: 720x1280, 24fps, H.264(yuv420p) 1개 + AAC 1개. 다른 트랙(배경 음악 등)은 없고 `checkOutput` 이 트랙 구성·9:16·180초 이하·기대 길이를 검사한다. FFmpeg 는 `-threads 2`.
- 글자: 자막·확대 HTML(`frameHtml({transparent:true})`)을 Chromium 으로 투명 PNG(720x1280)로 그려(`overlay.ts`) 두 줄(자막/확대)로 얹는다. 항목마다 한 프레임인 concat 목록이라 렌더 비용이 작다. 같은 HTML 은 해시로 캐시해 재사용한다(중간 결과 재사용).
- 동시성(AC-2): `RenderGate` — 프로세스 안 FIFO + pool 을 주면 PostgreSQL advisory lock 으로 프로세스 사이에서도 한 번에 하나.
- 임대(TASK-78 관찰): `StageContext.heartbeat()` 가 `JobQueue.renewLease` 로 임대를 연장한다. `createRenderHandler` 가 렌더(대기 포함) 동안 `heartbeatMs`(큐 leaseMs 의 1/3 이하 권장)마다 호출한다.
- 장애(AC-4): 출력 폴더의 `.<이름>.<pid>.<rand>.part.mp4` 에 렌더 → 검증(ffprobe + 전체 디코드) → fsync → rename. 실패(`DISK_LOW`·`DISK_FULL`·`TIMEOUT`·`FFMPEG_FAILED`·`INVALID_OUTPUT`·`OVERLAY_FAILED`)는 임시 파일만 지우고 이전 결과와 입력 기록을 건드리지 않는다. FFmpeg 는 쓰기 오류에도 종료 코드 0 을 줄 수 있어 `-v error` 출력이 있으면 실패로 본다.
- 오류 재시도: 입력 오류(`BAD_INPUT`)는 `NonRetryableError`, 그 외는 큐의 자동 재시도 1회 규칙을 따른다. 품질 재제작 1회는 이 Task 범위가 아니다.

## 검증
- `cd apps/server && npx vitest run src/video/render.test.ts` (FFmpeg·ffprobe 필요, 모의 자산, 약 3분)
- `src/video/renderQueue.test.ts` — 임대 연장·advisory lock (DATABASE_URL 필요)
- 실제 Chromium 오버레이 표본: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx tsx src/video/renderSample.ts out.mp4`

## 미검증(PM·관리자)
실제 자산(이미지·TTS)으로 만든 첫 영상, Android·PC 재생(AC-5), N100 에서의 렌더 시간(이 러너 4코어 공유: 179초 영상 약 92초).
