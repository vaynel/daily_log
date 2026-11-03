# TASK-133 독립 검수

판정: **CHANGES_REQUESTED** (2026-11-03 UTC). 검수 활동 AC-1~3은 완료했으나 TASK-132 구현에 P2 결함 1건이 있다. 운영 배포 및 서비스/설정 변경 없음.

## 검수 대상 및 증거

- 제출: TASK-132 run `8e23c9eb-9c36-4289-8dcf-14af3e5bd7e5`, commit `e7613e0652cc864c5da0e1b30096fc449021f415`, tree `8fd39b68f91d788553509584bcccb8857792c89f`.
- `/run/mandu/MANDU-HANDOFF.json` 불변 증거와 Mandu get_task 선행 제출, 최초 clean checkout HEAD/tree가 일치했다. 저장소 origin도 일치했다.
- 선행 BEFORE/AFTER 이미지 2장을 read_screenshot으로 직접 열었다. 둘 다 실제 명령 출력의 REPRODUCTION이며 운영 화면이 아니다.
- 기존 시험: `node --test --test-concurrency=1 scripts/ops/*.test.mjs` → 9 PASS / 0 FAIL.
- 독립 재현: `node scripts/ops/task133-review.mjs` → 24/28 PASS, 4 FAIL, 종료 1. g/G 파서 2건 및 release 전환 2건은 동일 원인이다. 모든 파일/전환은 `/workspace/data/task133` 합성 fixture에서만 실행했다.
- 대상 4개 구현/시험 파일 및 재현 스크립트 ESLint 종료 0. `npm run scan:secrets` 최종 401 files OK; `git diff --check` 종료 0.
- 최초 lint는 의존성 미설치로 실행되지 않았다. `/workspace`에서 `npm ci --no-audit --no-fund` 성공 후 위 검사를 수행했다.
- 원본 로그: `data/task133/ops.log`, `data/task133/boundaries.log`. REVIEW 이미지: `data/task133/review.png` (합성 입력에 대한 실제 출력 브라우저 렌더링). Mandu 첨부 `31741bcd-4553-4072-8810-b64e69fc4bcd`, 업로드 완료 확인.

## P2: 정상 g/G 크기를 FAIL로 오판해 릴리스를 차단

위치: `scripts/ops/preflight.mjs:67` 및 68. 정규식이 k/K/m/M만 허용하며 변환 배율에도 g가 없다.

재현:

1. `node scripts/ops/task133-review.mjs` 실행.
2. `server { listen 443 ssl; client_max_body_size 1g; }`와 `1G` 모두 기대 PASS, 실제 FAIL.
3. 정상 worker `on-failure/10s/0` 및 합성 승인 fixture를 사용한 `release switch`도 둘 다 종료 2, `WAITING_PREFLIGHT`, `current=releases/previous`.
4. 같은 용량인 `1024m`로 바꾸면 종료 0, `SWITCHED_PENDING_VERIFICATION`으로 전환된다.

1GiB는 요구 경계 10,486,784바이트보다 큰 유한값이다. nginx 공식 구현에서도 [client_max_body_size](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_core_module.c)는 off slot을 사용하고, [off slot 처리](https://github.com/nginx/nginx/blob/master/src/core/ngx_conf_file.c)는 [ngx_parse_offset](https://github.com/nginx/nginx/blob/master/src/core/ngx_parse.c)을 호출하며 g/G에 1024³ 배율을 적용한다(2026-11-03 원문 확인).

영향: g/G를 사용하는 유효한 설정에서 확정적으로 배포 전환을 잘못 차단한다. 데이터 손실이나 차단 우회는 재현되지 않았다. 필수 조치: g/G 파싱·배율을 지원하고 동일 크기의 k/K/m/M/g/G 및 release 회귀 검증을 추가한다. 구현은 원 담당에게 회송하며 검수자가 수정하지 않았다.

## TASK-132 완료 조건 판정

| 조건 | 판정 | 독립 근거 |
| --- | --- | --- |
| AC-1 업로드 한도 | FAIL | 누락·1m·10m·0·정확 경계값 거부 및 11m/k/K/M 통과는 정상. 그러나 앱 한도 초과인 1g/1G를 FAIL로 오판. 주석·location 우선·상속·따옴표 경계는 통과. |
| AC-2 worker 정책 | PASS | 기존 시험 및 추가 정상/always/no/0/시작 제한/대문자 비정상/CRLF 샘플 모두 기대와 일치. |
| AC-3 FAIL 차단·NOT_RUN | PASS | 기존 release 시험이 nginx/worker FAIL에서 current 불변 확인. 실제 비특권 UID EACCES 및 누락은 NOT_RUN. g/G의 잘못된 FAIL 자체는 AC-1 결함. |
| AC-4 회귀·운영 무변경·문서 | PASS | 기존 bundle/release 포함 9/9. 자동 명령·한계 문서 확인, lint/secret 검사 통과. 검수 중 운영 변경·비밀 노출 없음. |

후속 관찰(필수 결함과 별도): 배포 문서 83행의 과거 설명은 release가 승인 JSON만 검사한다고 하지만 225행 이후 새 절은 자동 preflight를 설명한다. 문구 정리를 권장한다. NOT_RUN 비차단, 외부 include 미전개, 모든 location 보수 검사는 명시된 동작이다.

## 미실행 및 참조

운영 nginx/systemd 실효 상태, nginx 바이너리 구문 검사(격리 컨테이너에 바이너리 없음), 실제 DB 장애 복구·배포는 NOT_RUN. 일반 앱 전체 시험/DB·Redis 통합/UI·Android 실기기는 ops 독립 검수 범위에서 실행하지 않았다. nginx 단위 해석은 공식 소스 대조로 확인했다.

읽은 참조: 고정 begin 패킷과 Task 공통 계획, 불변 handoff, README, TASK-132 선행 보고/이미지, 변경 6개 파일, attachments policy/routes, nginx 공식 소스 3개. Wiki/Flowchart 원문은 미열람. `verification-before-completion` 및 결함 원인 추적 시 `systematic-debugging` 고정 지침 적용.
