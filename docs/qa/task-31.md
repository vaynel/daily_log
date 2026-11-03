# TASK-31 격리 백업 복원 시험

기준: `7c7fc423bcd0c584e6b3ffb56878f34831247999`, Mandu scope revision 6.
운영 배포·실제 Google Drive·유료 API·운영 DB는 사용하지 않았다.

## 실행

Node 22+, npm 의존성, ffmpeg와 **격리 시험 DB**의 `DATABASE_URL`이 필요하다.
저장소 루트에서:

```sh
npm ci
npm test -w apps/server -- src/backup/restore.test.ts src/backup/backup.test.ts src/retention/retention.test.ts --no-file-parallelism --maxWorkers=1
```

시험은 합성 기록·Markdown 첨부·ffmpeg로 만든 64×64 파란색 0.2초 H.264 mp4(음성 없음)를 사용한다. 실제 `buildBackupPlan`과 `GoogleDriveClient`로 로컬 `fakeDrive.testutil.ts` 서버에 업로드한다. 선택한 백업의 파일 ID·종류·키·버전·크기·MD5·SHA-256은 `data/task31/manifest.json`, 복원/API 결과는 `data/task31/drill.json`에 기록된다. 시험이 생성한 DB 스키마·파일 공간은 종료 때 정리하며 증거 JSON은 남긴다. DB 환경변수가 없으면 Vitest가 건너뛰므로 **skipped는 PASS가 아니다**.

## 구현 계약

`apps/server/src/backup/restore.ts`의 `restoreDrill`은 명시적으로 호출하는 시험용 도구다. 앱·워커에는 등록하지 않는다. 입력은 격리 DB URL, 서로 겹치지 않는 원본 파일 디렉터리/시험 부모 디렉터리, 신뢰한 `RestoreManifest`, 로컬 모의 Drive URL이다. manifest 소유자는 운영 계정 인증을 대신하는 값이 아니며 합성 시험용 매핑이다.

- Drive 주소는 `http://127.0.0.1:<port>/drive/v3`만 허용하고 리디렉션은 거부한다. 실계정 토큰을 받지 않는다.
- 먼저 모든 파일의 크기·MD5·SHA-256과 Drive 버전 속성을 검증한다. 스냅샷이 요구하는 첨부·최신 영상이 manifest에 없으면 실패한다.
- 경로는 `realpath`로 비교하고 원본과 겹치는 시험 경로를 거부한다. 파일 이름도 검증한다. 대상 디렉터리는 `mkdtemp`, DB 스키마는 무작위 `restore_drill_*`로 새로 생성한다. 기존 대상 이름을 지정하거나 덮어쓸 수 없다.
- 프로젝트 DB 마이그레이션과 복원 INSERT는 새 스키마의 트랜잭션 안에서 실행한다. 쓰기 실패 시 롤백하고 생성한 파일 디렉터리만 정리한다. 성공 결과는 commit 이후 반환한다.
- `record.json` 원본 바이트를 별도로 보존한다. 실제 앱 `buildApp`은 새 스키마의 `RecordStore`와 새 파일 경로로 구동한다. 대화/요약/첨부 연결을 검사하고, 첨부/결과 API 바이트 해시를 원본과 비교한다.
- 스냅샷의 검수·대체 상태를 보존한다. 거절·대체된 최신 영상은 기존 앱 규칙대로 409이다. 백업 상태·작업 큐·음성·Drive 자격증명은 복원하지 않는다.

## 백업 형식과 제한

기존 schema 1 스냅샷에는 대화 ID·원본 시작 시각·제작/검수 상태·결과 대체 표식이 없어 안전하게 앱 상태를 재구성할 수 없었다. `plan.ts`는 이 정보를 포함한 **schema 2**를 만든다. 업로드 중 달라지는 `pipeline.backup`은 포함하지 않아 백업 자체가 새 백업을 반복 생성하지 않는다. 이전 Drive 파일을 수정/삭제하지 않으며 새 스냅샷은 새 해시 버전으로 저장된다.

이 도구는 schema 1을 `UNSUPPORTED_SNAPSHOT`으로 거부한다. 구형 백업의 자동 변환·운영 복원은 이번 구현에 포함하지 않는다. 기존 백업 계약대로 파일 복원 대상은 첨부와 **최신 RESULT 영상**이며 이전 RESULT 파일 전체를 복원한다고 주장하지 않는다. 스냅샷에 없던 항목별 저장 시각/첨부 EXIF는 복원하지 못하고, 생성한 행의 시각은 기록 createdAt으로 설정한다. API의 기록 JSON은 조회용 표현이므로 스냅샷 파일 해시와 직접 비교하지 않고 대화·요약·연결을 대조한다.

## 완료 조건별 검증

| 조건 | 재실행 가능한 증거 |
|---|---|
| AC-1 | `restore.test.ts`: 실제 앱 기록/첨부/결과 API 200, 대화·요약·첨부 연결 일치, 첨부/mp4 SHA-256 일치. 비로그인 401, 타 소유자 404. |
| AC-2 | 서로 다른 DB 스키마/파일 경로, 복원 전후 합성 원본 DB 행과 파일 바이트 동일. 원본 경로 겹침 거부 및 DB 쓰기 오류의 스키마/파일 롤백. |
| AC-3 | 파일 누락 `BACKUP_MISSING`, 잘린 저장 파일/다운로드 `SIZE_MISMATCH`, 메타데이터/전송 바이트 MD5 변조 `MD5_MISMATCH`, SHA-256 변조 `SHA256_MISMATCH`; 성공 결과나 새 대상 없음. |
| AC-4 | `retention.test.ts`: 최신 백업 확인 후 한 달 원본 정리, 즉시 영구 삭제·휴지통 30일 만료에도 Drive/영상 유지. 백업 없음/구버전/MD5 손상/401/미연결 시 원본 보존. `restore.test.ts`: 실제 purge 후 시험 공간만 복원하고 원본 삭제 상태·Drive/영상 해시 유지, Drive DELETE/PATCH 0. |
| AC-5 | 기존 말일·윤년·연말·만료 ±1ms·처리 중 보류 시험 재실행. 추가 `TASK-31: 중단·미변환 음성은 Drive 연결 해제 뒤...` 시험: 정상 음성 조기 삭제, 미변환/중단 1월31일→2월28일 만료, 연결 해제 후 Drive 호출 0, 업로드 종류 RECORD/ATTACHMENT/VIDEO만, 백업·영상 해시 보존. |

음성 원본은 현재 저장소에서 별도 파일로 관리하지 않으므로 음성 삭제 증거는 `audio_segments`의 `DELETED` 상태와 사유다. 실제 기기 녹음·실제 Google Drive·영상 제작 파이프라인은 범위 밖이며 검증하지 않았다.

BEFORE/AFTER는 실행 출력의 브라우저 렌더링인 **REPRODUCTION** 증거다. 제품 화면이나 실제 Android 촬영으로 표시하지 않는다. 원본 출력·manifest·시연 JSON·이미지는 `task-31-evidence/` 참조.

참조: Mandu get_task/begin_task 패킷·공통 계획, 읽기 전용 `/run/mandu/MANDU-HANDOFF.json`, TASK-29/TASK-114 선행 보고, README, `docs/jobs/task-27-drive-backup.md`, 실제 backup/records/retention/DB/API 코드. Wiki 05/07/09와 F05 원문은 scoped MCP에 열람 도구가 없어 읽지 못했으며 패킷의 최신 정책/PM 범위를 적용했다.

## 실제 실행 결과 (2026-11-03 UTC)

- 최초 RED: 복원 모듈 부재로 `Cannot find module './restore.js'`, 실행된 테스트 0건. 동작 실패를 재현했다고 과장하지 않는다. BEFORE는 실제 기준 HEAD와 도구 부재를 기록했다.
- 전체 서버: `npm test -w apps/server -- --no-file-parallelism --maxWorkers=1` → **34 파일 / 494 테스트 PASS**, 종료 0, 442.02초.
- 원본 DB의 pipeline/대체 상태까지 해시 증거를 보강한 최종 관련 시험: 위 실행 명령에 `--reporter=verbose` → **3 파일 / 67 테스트 PASS**, 종료 0, 26.15초.
- `npm run lint`, `npm run typecheck`(server/web), `npm run build -w apps/server`, `git diff --check` 통과. 출력은 evidence 디렉터리에 보관한다.
- `server-all.txt`와 `targeted-final.txt`는 Fastify 요청 JSON 로그만 제거한 실제 Vitest 출력이다. 67개 시험 이름과 결과를 보존했다.
- `synthetic.mp4`는 시연에 사용한 실제 합성 샘플이다. 해시는 `drill.json`과 같다. 증거의 DB 스키마와 시험 파일 디렉터리는 시험 종료 뒤 정리되며 JSON·샘플은 보존한다.
