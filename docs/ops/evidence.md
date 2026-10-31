# TASK-30 검증 기록

2026-10-31, `/workspace`, 기준 `5680ca374afe6cd8065a3e43402b8c4d285f8312`. 모든 제품 코드가 기준과 동일한 상태에서 아래 시험을 실행했다. 실행 중 실제 배포·유료 제공자·호스트 Docker 접근은 없었다. 선행 Task의 PASS를 재인용만 한 것이 아니라 병합본을 재실행했다.

환경: Node22.23.3 / npm10.9.9 / PostgreSQL17.11 / ffmpeg5.1.9 / Chromium154.0.8037.92. PostgreSQL client17.11과 libpq는 `/workspace/data/task30/pg`에 추출했다. 새 DB 생성 권한은 없었고, 제공된 격리 DATABASE_URL의 무작위 임시 스키마를 사용했다. 모든 설치·소스·임시 결과는 `/workspace` 안에 두었다. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`의 브라우저를 사용했다. Vite 서버는 기동하지 않았다.

| 검증 | 실행 명령 / 실제 결과 | 증거 |
| --- | --- | --- |
| 병합 파이프라인 | `npm run test -w apps/server -- src/video/pipeline.test.ts --no-file-parallelism --maxWorkers=1`: 5/5 PASS, 유료 제공자 mock | [pipeline.txt](evidence/pipeline.txt) |
| 빌드 | `npm run build`: server tsc + migration 복사, web Vite 모두 exit0 | 전체검사 요약에 기록 |
| 큐 복구 | `npm run test:queue-restart`: 일반/유료 2시나리오 PASS, 완료 단계 미재실행·원장 보존 | [queue-restart.txt](evidence/queue-restart.txt) |
| 제작 복구 | `npm run test:pipeline-restart`: 렌더 중/음성 응답 전/장면 사이 SIGKILL 3시나리오 PASS. 응답 전 종료는 재전송 없이 확인 대기 | [pipeline-restart.txt](evidence/pipeline-restart.txt) |
| 실제 worker 공존 | `node scripts/ops/worker-e2e.mjs`: 실제 `dist/worker.js`가 영상/백업 두 job을 각각 PRO_UNAVAILABLE/DRIVE_NOT_CONNECTED 권한 대기로 처리. 원장0, SIGTERM exit0 | [worker.txt](evidence/worker.txt) |
| 소스 묶음 | `node scripts/ops/bundle.mjs 5680ca374afe6cd8065a3e43402b8c4d285f8312 data/task30/release`: source.tar/manifest 생성·정확한 SHA 고정. symbolic HEAD 거부 시험 포함 | [bundle.txt](evidence/bundle.txt) |
| DB/파일 롤백 | `PG_BIN=.../postgresql/17/bin LD_LIBRARY_PATH=.../usr/lib/x86_64-linux-gnu node scripts/ops/rollback-e2e.mjs`: 0012 직전 스키마+합성 기록/RESULT/DONE/PASSED/VERIFIED 저장→pg_dump17→실제 migrate.js로0012 적용→전용 스키마 복원→DB/원본/완료파일 SHA256 일치 | [rollback.txt](evidence/rollback.txt) |
| 접근 | `node scripts/ops/access-e2e.mjs`: 실제 loopback HTTP 서버+모의 OIDC+Chromium Desktop Chrome/Pixel7. 각 비로그인4x401, 허용4x200 및 파일 바이트 확인, logout4x401, 비허용 로그인 거부+4x401 | [access.txt](evidence/access.txt) |
| 승인/상태 | `node --test scripts/ops/*.test.mjs`: 2/2 PASS (여러 거부 경우 포함). 승인 없을 때 current 불변, 만료/다른commit/백업미확인/외부미확인 거부, 유효한 합성 승인일 때 임시 symlink만 변경, 상태는 여전히 개통 미완료 | [ops-tests.txt](evidence/ops-tests.txt), [status.txt](evidence/status.txt) |

새 게이트·묶음 시험은 구현 전 실패를 확인한 뒤 구현 후 통과했다(`data/task30/{gate,bundle}-red.log`, `*-green.log`). 실제 관리자 승인 파일은 생성하지 않았으며 게이트 테스트의 `TEST ONLY` 승인은 임시 경로에서만 사용하고 삭제했다.

초기 검증 중 발견 사항: 복원 시험의 CREATE DATABASE는 SQLSTATE42501(권한 없음)로 거부되어 기존 DB의 시험 전용 임시 스키마로 수정했다. worker 시험은 처음 `job_events.code`에 상세 오류를 기대해 실패했으며 실제 계약(`job_events`는 PERMISSION, `jobs.error_code`는 상세 사유)을 확인해 조회를 수정하고 통과했다. 제품 병합 결함은 발견하지 않았다. 이 초기 실패를 최종 PASS로 숨겨 덮어쓰지 않고 여기 기록한다.

한계: 복원은 격리 PostgreSQL의 **합성 데이터**다. 파일의 mp4 이름은 해시 보존용 합성 바이트이며 영상 재생을 시험한 것이 아니다. 실제 영상 생성/메타데이터는 별도 pipeline/restart 시험에서 검증했다. 접근 시험의 `/`는 제품 인증 훅에 붙인 시험용 보호 경로이며 Vite 화면의 시각 검수가 아니다. PC/Pixel7은 에뮬레이션이며 실제 Android 기기나 외부 네트워크가 아니다. 실제 Google/DNS/TLS/운영 프록시/관리자 승인/운영 전환은 NOT_RUN, 관리자 수행 대기.

AC 판정은 원래 문구를 바꾸지 않고 **PM scopeRevision7 해석에 한해** 적용한다: AC1 문서, AC2 격리 인증 경계, AC3 복원 보존, AC4 승인 없을 때 전환 거부+양식, AC5 미개통 상태 출력. 실제 외부 시험과 실제 승인 존재를 PASS로 주장하지 않는다.

설치 관찰: `npm ci`는 exit0(289 packages)였고 npm 감사 출력은 기존 lockfile에서 **moderate 13건**을 보고했다. 이번 Task는 의존성 버전을 변경하거나 감사 취약점을 해결하지 않았으며 운영 승인 전에 별도 검토가 필요하다.

재실행 전 `/workspace`에서 `mkdir -p data/task30` 및 `npm ci`, `npm run build`를 수행한다. Vitest에는 `TMPDIR=/workspace/data/task30`를 적용하고 `--no-file-parallelism --maxWorkers=1`로 순차 실행한다. 원시 인증 로그는 모의 authorization code 등이 포함되어 커밋하지 않고 접근 결과 요약만 보존했다. 비밀 검사에서 실제 주입된 환경 값도 별도 비출력 비교한다.

전체 회귀 최종 결과: server Vitest **33파일/475 PASS**, web Vitest **6파일/39 PASS**, `npm run test:siwc` **37 PASS / 4 SKIP / 0 FAIL**. SKIP은 Windows 전용 launcher·저장소·트랜잭션 시험으로 Linux 환경에서 미실행이다. `npm run lint`, `npm run typecheck`, `npm run build`, `npm run scan:secrets`, `git diff --check` 모두 exit0. [`regression.txt`](evidence/regression.txt)에 명령별 요약을 보존했다. 주입된 DATABASE_URL/REDIS_URL/SESSION_SECRET 문자열이 제출 파일에 없는지도 값 비출력 비교로 확인했다.

BEFORE 이미지: HEAD·git status·기존 배포 파일 목록을 텍스트로 재현(REPRODUCTION), Mandu upload `d64df21c-2f2e-4ecb-a91f-e18533a5832f`. AFTER는 위 검사 결과와 미개통 상태 출력의 REPRODUCTION이며 Mandu에 별도 첨부한다. 화면 기능 변경은 없다.
