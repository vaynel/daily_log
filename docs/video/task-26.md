# TASK-26 — 품질 검수와 자동 재제작 1회

기준: `6978a0c88d1b738b7a664ecdcda6d5583192a59e`. 유료 호출·배포 없음.

## 동작과 연결

- `quality.ts`: 렌더 결과의 대본 버전·파일 SHA, 대본/장면 시각 설명/음성 전사/자막/학습 확대 화면을 검수한다. TASK-20 `classifyExclusion`, TASK-22 `matchRule` 및 이번 영상 제외 내용을 적용한다. 사실·그림·학습 의미·가독성은 명시된 검수 결과와 근거가 필요하다. 누락은 통과로 간주하지 않는다. 검수 기록에는 원문 대신 구성 요소 해시·근거 해시·실패 코드를 넣는다.
- `createQualityHandler`: `render` 다음 마지막 단계에 등록한다. `loadInput(ctx)`가 현재 제외 규칙·전사·검수 근거와 렌더된 대본 버전을 제공해야 한다. 렌더 처리기의 loadInput은 scriptVersion을 함께 제공해야 한다. 렌더 단계가 저장한 파일명/SHA/scriptVersion과 일치해야 하며 실제 파일을 해싱하고 ffprobe로 포맷/길이를 다시 확인한다. 전사/STT·의미/그림 판정 제공자는 주입 경계이며 이 작업에서 실제 유료 호출을 추가하지 않았다.
- `repairStages`: 실패 구성 요소별로 다시 생성할 단계와 의존 단계를 명시한다. 예: 자막 → captions, 대본 → script/voice/captions. 렌더와 검수는 자동으로 포함된다. 다른 완료 단계는 그대로 재사용한다. 후속 단계는 항상 ctx.results에서 최신 결과를 읽어야 한다.
- `permissionGranted(ctx)`는 실패 판정 때마다 현재 제작 권한을 조회한다. 각 유료 생성 처리기도 외부 전송 직전에 권한을 확인해야 한다(기존 큐 PermissionDeniedError 계약). 큐는 재제작 전체 예상 비용을 확인하고, 실제 유료 호출별 원장 예약으로 월 50,000원 상한을 다시 적용한다.
- 기존 `worker.ts`의 빈 처리기 레지스트리는 변경하지 않았다. TASK-25와 같은 처리기 팩터리 연결 방식이며, 실제 레지스트리 구성/계정/STT 연결은 운영 통합 시 필요하다. 재현 시험은 실제 JobQueue에 render와 quality 처리기를 등록하여 실행한다.

## 지속 상태와 보존

`0010_video_quality.sql` 마이그레이션을 적용한다. `jobs.quality_regenerations_used`는 DB 제약으로 0~1이며 기존 `auto_retries_used`와 별개다. 품질 실패 시 트랜잭션에서 이전 단계 결과·검수 근거를 `job_quality_reviews`에 보존하고, 조건이 허용될 때만 품질 횟수를 증가시키고 대상 단계를 무효화한다. 예산/권한 대기는 횟수를 소비하지 않는다. 재시작·수동 재시도는 횟수를 초기화하지 않는다.

렌더 파일명은 `<기존이름>.<jobId>.q0.mp4` / `.q1.mp4`로 분리되어 검수 실패 파일을 덮어쓰지 않는다. 유료 요청 식별자는 시도 번호를 유지하고 q1 접미사로 재제작 호출을 구분한다. 외부 결과 불명은 기존 큐 조회/대기 정책을 따른다.

검수 실패는 `pipeline_states.review=REJECTED`로 기록하며 성공한 검수 단계 결과를 만들지 않는다. 소진+예산 부족+권한 부족은 `quality_reasons` 배열로 함께 보존한다. 기록 목록/상세 API가 전달하고 상세 화면이 모두 표시한다. 이번 변경은 미통과 파일의 개인 다운로드 정책을 바꾸지 않는다. 공개 서비스/SNS는 범위 밖이다.

## 재현

```sh
npm ci
# 격리 PostgreSQL의 DATABASE_URL을 환경에 설정
npm run check
DATABASE_URL="$DATABASE_URL" npm run test -w apps/server -- src/video/quality.test.ts src/video/qualityQueue.test.ts src/video/qualityStage.test.ts
npm run build -w apps/server
node scripts/quality-restart-e2e.mjs
# 별도 터미널에서 npm run dev -w apps/web -- --host 127.0.0.1 --port 5173
node scripts/quality-ui-e2e.mjs AFTER
```

이번 컨테이너에는 DATABASE_URL/REDIS_URL이 주입되지 않아 최초 PG 시험은 skip됐다. 이후 `/workspace/data/task26-pg`에 테스트 전용 PostgreSQL 18.4 바이너리/클러스터를 설치하고 localhost:55432에서 실행했다. 운영/호스트 Docker 접근 없음. npm 제품 의존성에는 PostgreSQL 바이너리를 추가하지 않았다. Redis는 이 PG 큐 구현에서 사용하지 않는다.

## 검증 범위와 한계

- 누출 시험은 각 구성 요소, 상시 제외/사용자 반복 제외/이번 영상 제외, 누락·버전·길이 실패를 검증한다. 키워드 기반 기존 분류의 의미적 누락 가능성은 그대로이며 실제 모델 분류 정확도를 주장하지 않는다.
- 전사·그림/사실/학습/가독성 근거는 합성 fixture다. 실제 STT, 유료 모델, 사용자 원문, Android 실기기 검수는 하지 않았다.
- 실제 FFmpeg MP4 → SHA/ffprobe 검수 → 자막만 재제작 → 파일 SHA 보존 → 재검수 성공/상태 전환을 시험했다.
- 실제 워커 프로세스를 재제작 렌더 도중 SIGKILL한 후 새 프로세스로 복구하여 품질=1, 처리 오류=1, 최종 QUALITY_EXHAUSTED를 확인했다.
- 브라우저는 제공된 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH를 사용했다. 스크린샷은 합성 API fixture를 표시한 실제 React 화면이며 실제 계정/실데이터 화면이 아니다.
- 읽은 근거: Mandu 작업/실행 패킷, immutable `/run/mandu/MANDU-HANDOFF.json`, TASK-15/25 보고, 기존 큐·원장·제외 규칙·렌더·기록 코드 및 로컬 설계 문서. scoped MCP에 Wiki/Flowchart/list_team 도구가 없어 해당 원문과 최신 팀 조회는 미실행. 실행 패킷의 확정 요구에 따라 구현했다.
