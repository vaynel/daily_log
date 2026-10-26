# TASK-102 독립 검수

판정: **PASS — TASK-101 비파괴 검증 준비 범위**. TASK27 제품 최종 승인이나 실제 Google Drive 검증 완료가 아니다. 발견한 범위 내 P0~P2 결함 없음.

## 고정 근거

- 선행 run: `610bf975-32a8-490b-8f53-d32bc5f95f57`.
- 검수 run: `23403f24-9ed5-4878-b5c6-e39858bee754`.
- 검수 대상 SHA: `749464fc13d8b0e64adbd86e24b21aab743edbb9`.
- tree: `8d2e5c5681d1b37ccd9ed378c838057c14e2b42f`.
- `/run/mandu/MANDU-HANDOFF.json`의 immutable 입력과 실제 HEAD/tree 일치. 호스트 artifact 경로와 checkout 동명 파일은 사용하지 않았다.
- TASK27 `4230ea0e67dde723d7671ec6cd95ad9b1c8ca0e6` 대비 변경은 harness 4파일 및 문서/증거 9파일뿐이다. 검수 중 앱·harness·lockfile 수정 없음.

## 선행 완료 조건 대조

| 조건 | 결과 | 독립 근거 |
| --- | --- | --- |
| TASK101 AC-1: 기존 통합 재사용과 비파괴 분리 | PASS | verify.ts가 기존 buildApp/auth/BackupService/JobQueue를 import한다. 주입 테스트 DB의 새 schema `task101_23a3047bf645b90b`, 새 디렉터리 `data/task101/run-XHAF0h`에서 실제 실행. 공통 코드 diff 없음. |
| TASK101 AC-2: PG/fake Drive 버전·무결성·음성제외·live | PASS | fake-pg-drive.txt: RECORD/ATTACHMENT/VIDEO 3종 원본 바이트·버전·size·SHA256·MD5 대조, audio_segments 1건 제외, live true/비live null, 원격 MD5 손상·401·새 버전 미복사 false. 중복 업로드 방지·구버전 유지·원본 보존. |
| TASK101 AC-3: 안전 preflight·OAuth 안내·금지 경계 | PASS | preflight-tests.txt 4/4, preflight.txt에서 DB/OAuth 미검증 및 realUploadEnabled=false. 업로드 인자 거부. 한국어 문서의 별도 실제 앱 wiring, 인간 로그인/drive.file 동의, 정확한 callback URI와 loopback 도달 조건 확인. |

안전성의 핵심은 실제 모드가 없고, DB는 주입된 테스트 서비스의 새 schema를 사용하며, fetch 대상은 이번 실행의 loopback fake 서버 두 origin으로 제한된다는 점이다. 코드의 redirect 수동 처리와 실제 클라이언트의 fetch 사용을 대조했다. fake Drive/OIDC는 127.0.0.1에만 바인딩한다. DriveApi에는 삭제/덮어쓰기 API가 없고 실행 로그의 DELETE/PATCH는 0건이다. 원본 영상 SHA256 `ebecf326b8d53aa69ebfdae3b7bf3f0c3f5d9d6f5164272d812a2058a4857e9d`도 실행 후 동일하다. 마이그레이션의 DROP CONSTRAINT는 새 시험 schema의 제약 변경이며 기존 DB/파일 삭제 실행은 아니다. 시험 schema와 합성 파일은 보존했다.

## 실행 결과와 한계

정확한 명령/종료코드는 [commands.json](task-102-evidence/commands.json), 원시 출력은 같은 디렉터리의 txt 파일에 있다. preflight, preflight 4개 테스트, 실제 격리 PG/fake Drive harness, TypeScript, ESLint, 비밀값 검사가 모두 종료 0이다.

처음에는 의존성이 설치되지 않아 tsx import와 tsc/eslint 실행에 실패했다. 해당 원시 출력과 종료코드는 initial-* 파일에 보존했다. `timeout 120s npm ci --ignore-scripts --no-audit --no-fund`가 종료 0(289 packages)으로 끝난 후 동일 소스를 재실행했다. 초기 실패를 제품 결함이나 통과로 계산하지 않는다. 의존성은 /workspace/node_modules에 설치되었다.

actualGoogleDrive **NOT_RUN**, 실제 인간 OAuth **NOT_RUN**, Android **NOT_RUN**, 전체 앱 회귀 suite **NOT_RUN**, 배포 **NOT_RUN**. fake issuer의 성공은 인간 동의 증거가 아니다. 실제 Google 검증은 별도 앱 연결과 본인의 로그인 및 drive.file 동의 후 수행해야 한다. 현재는 사용자 로그인 요청이 필요하지 않다. 네트워크 차단 증거는 이 harness의 fetch 경로에 한정되며 OS 전체 네트워크 감사가 아니다.

## TASK102 완료 조건

- AC-1 PASS: 위 고정 SHA에서 선행 AC 세 항목을 코드 및 새 실행 근거로 대조했다.
- AC-2 PASS: 실제 Google/OAuth 미실행과 fake 범위, 초기 환경 실패를 분리했다.
- AC-3 PASS: 검수 판정과 구체 근거를 기록했다. TASK27 최종 승인으로 확장하지 않으며 사람 검토를 요청한다.

읽은 참조: immutable handoff, Mandu begin_task 패킷/공용 계획 및 선행 보고, verification-before-completion 고정 스킬, README, task-101-drive-validation.md, task-27-drive-backup.md, preflight 및 테스트, verify.ts/tsconfig, root package.json, backup의 drive/plan/service/routes/fakeDrive, auth/oidc.ts, app/mock-issuer의 연결·바인딩 부분 및 migration 검색 결과.
