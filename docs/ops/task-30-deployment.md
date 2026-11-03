# TASK-30 배포 준비안 (PM scopeRevision 7)

상태: **개통 미완료 — 관리자 승인·외부 설정·실기기 시험 대기. 배포하지 않음.**

이 문서는 2026-10-31 격리 워커 검증 결과와 향후 관리자 실행 절차다. 운영 nginx/DNS/인증서/서비스/DB는 읽거나 변경하지 않았다. 실제 승인 기록은 없다. 아래 명령은 관리자 검토용이며 이 Task에서 운영에 실행하지 않는다.

## 기준과 기존 서비스 영향

앱 배포 기준은 `5680ca374afe6cd8065a3e43402b8c4d285f8312` (tree `ce4d4d09949fd5979bb2d009299c21f00ae292c3`)다. 승인된 휴지통·백업·제작 연결·결과 UI 병합본이며 제품 소스는 이번 작업에서 변경하지 않았다. 운영 도구는 TASK-30 제출 커밋의 `scripts/ops/`를 별도로 검토해 사용한다.

PM 제공 사실: `daily.log2u.me`는 현재 VPN/LAN 전용 nginx와 수동 갱신 인증서를 사용한다. 호스트 `push-test` 컨테이너가 `:3100`에서 실행 중이다. 호스트 경로·서비스 이름·현재 DNS 값·인증서 경로는 이 컨테이너에서 검증할 수 없으므로 아래 제안 경로와 구분한다. 기존 서버 전체 설정을 덮어쓰거나 :3100을 재사용하지 않는다.

| 변경 대상 | 제안·영향 | 승인 전 상태 / 복구 |
| --- | --- | --- |
| DNS A/AAAA `daily.log2u.me` | 관리자가 현행 레코드/TTL을 내보낸 뒤 도달 가능한 ingress 주소 확정. AAAA도 별도 도달 검증. 변경 후 TTL 동안 캐시 영향 | 주소 미확정. 현행 값으로 되돌리고 TTL 경과 검증 |
| 해당 도메인 nginx vhost만 | 443 TLS, `/api/`·`/auth/`는 `127.0.0.1:3300` 프록시, WebSocket 업그레이드와 긴 인터뷰 타임아웃 검토. 프런트는 빌드된 `apps/web/dist`만. 다른 vhost·push-test 무변경 | vhost 실제 경로 관리자 확정 후 사본 보존. `nginx -t` 실패 시 reload 금지 |
| HTTPS 인증서 | SAN `daily.log2u.me`, 유효 기간/체인, 수동 갱신 책임자·다음 갱신일 기록. 자동 발급/갱신 실행 없음 | 기존 인증서·개인키 그대로 보존, 새 키는 0600. 기존 인증서 참조로 복귀 |
| Google OAuth 앱 | origin `https://daily.log2u.me`; redirect `https://daily.log2u.me/auth/callback`, 별도 Drive 동의 `https://daily.log2u.me/auth/drive/callback` | 실제 등록·시험 관리자 수행 대기. 기존 허용 URI 삭제 금지; 신규 URI만 제거 가능 |
| 앱 API 프로세스 | `HOST=127.0.0.1 PORT=3300`, 제안 unit `daily-log-api.service`. 관리자 포트 충돌 확인 필수 | 앱만 정지/이전 릴리스로 복귀. :3100 음성 시험 서버는 기동하지 않음 |
| 작업기 | 제안 unit `daily-log-worker.service`, 단일 렌더러. DB 큐/예산 원장 공유. Chromium/ffmpeg 경로 명시 | 작업기 먼저 정지, 임대·유료 결과 불명확 상태 보존. 무조건 재전송 금지 |
| PostgreSQL | 기존 DB 인벤토리·버전·소유자 확인 후 마이그레이션. 원본·결과·백업·예산 원장 함께 덤프 | down SQL 없음. 정지 상태 백업에서 별도 복구 DB로 복원·대조 후 연결 전환 |
| 파일 | 제안 `/srv/daily-log/shared/files`, 서비스 사용자 전용 0700, 파일 0600/umask077. nginx alias/document root에 연결 금지 | 백업 tar에서 새 복구 디렉터리로 추출 후 SHA-256 대조. 기존 파일 덮어쓰기 금지 |
| 비밀/설정 | 제안 `/srv/daily-log/shared/runtime.env` 0600. DB·세션·Google·Drive 암호키·VAPID 등은 서버 전용 | 백업은 별도 접근 제한. 세션/Drive 키 보존(임의 재생성 시 세션·토큰 복호화 영향) |

외부 방화벽은 ingress 443만 허용하고 DB·Redis·API3300은 외부에 열지 않는다. 앱 shell 정적 자산은 로그인 전에도 내려갈 수 있으나 개인 데이터는 포함하지 않는다. 개인 기록/첨부/영상은 반드시 인증 API를 경유한다. URL 퍼센트 인코딩 우회도 기존 전역 인증 훅으로 차단한다. 프록시가 `/api` 경로를 다른 정적 위치로 재작성해서는 안 된다. Google 콜백 쿼리·쿠키·개인 원문을 프록시 로그에 남기지 않도록 해당 vhost 로그 정책도 관리자 검토 대상이다.

## TASK-127 재발 방지: 업로드 한도와 worker 기동 순서

TASK-114 실사용에서 보고된 nginx 413(약 3.2MB 사진)과 DB보다 먼저 뜬 worker의 시작 제한 실패를 예방하는 절차다. 아래는 관리자 실행용이며 TASK-127에서 운영 설정을 변경하거나 배포하지 않는다. 기존 TASK-30 검증 이력과 현재 운영 상태를 혼동하지 않는다.

### nginx 사진 업로드 한도

앱의 `apps/server/src/attachments/policy.ts`는 사진 한 장을 **10MiB(10 × 1024 × 1024 bytes)**까지 허용한다. `routes.ts`의 요청 본문 한도는 이 값 + 1024 bytes다. nginx는 앱보다 먼저 요청을 거부할 수 있으므로 **`client_max_body_size 11m;`**(11MiB, 사진 한도보다 1MiB 여유)를 설정한다. `10m`은 여유가 없고, `0`은 무제한이므로 이 운영 기준에서는 사용하지 않는다. 앱 자체의 10MiB 검증은 그대로 유지한다.

위치: 관리자가 확인한 `/etc/nginx/conf.d/daily-log.conf`의 `server_name daily.log2u.me`를 가진 **HTTPS `server` 블록 안**. 기존 TLS·proxy·정적 파일 설정은 보존하고 다음 한 줄을 추가한다(완성된 vhost 대체 파일이 아님).

```nginx
client_max_body_size 11m;
```

`/api/records/:id/attachments`에 매칭되는 `location`과 그 `include`에 더 작은 값이 있으면 그 값이 우선하므로 함께 확인한다. 다른 vhost의 설정만 바꾸거나 HTTP 리디렉션 블록에만 넣어서는 해결되지 않는다. 앞단 프록시가 있다면 그 요청 한도도 확인한다.

관리자가 해당 vhost 사본을 별도 보존한 후 편집하고, 기존 관리 권한 세션에서 아래 명령을 수행한다. 검사 실패 시 reload하지 않고 원인을 해결하거나 사본으로 복구한다.

```sh
nginx -t && systemctl reload nginx
```

공식 기준: [nginx client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)는 기본값 `1m`, 설정 범위 `http/server/location`, 초과 응답 `413`을 정의한다.

### DB 지연 시 worker 재시작 정책

`apps/server/src/worker.ts`는 시작 시 `queue.recover()`를 호출하며 이 단계의 DB 연결 실패는 루프의 오류 처리 밖이다. 단순 `After=`는 DB 연결 준비를 보장하지 않는다. 프로세스 실패 후 **10초 간격으로 재시작하고 시작 횟수 제한을 해제**하여 DB가 나중에 준비되면 다음 시작에서 복구하게 한다. 앱의 작업별 자동 재시도 횟수·예산 정책은 바꾸지 않는다.

TASK-114에서 보고된 사용자 서비스 기준 drop-in 위치:
`~/.config/systemd/user/daily-log-worker.service.d/db-wait.conf` (서비스를 소유한 사용자의 홈). 관리자가 기존 파일을 보존한 뒤 다음 내용을 병합한다.

```ini
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=on-failure
RestartSec=10s
```

`StartLimitIntervalSec`는 `[Unit]`, `Restart`와 `RestartSec`는 `[Service]`에 둔다. 기존 `Restart=always`도 허용한다. `RestartPreventExitStatus`가 DB 실패 종료 코드를 막고 있거나 다른 drop-in이 위 값을 덮어쓰는 경우를 제거/조정해야 한다. 서비스 본체의 `ExecStart`, 환경 파일, 작업 디렉터리는 기존 검증된 값을 보존한다.

관리자 적용 명령(사용자 서비스 소유자로 실행):

```sh
systemctl --user daemon-reload
systemctl --user reset-failed daily-log-worker.service
systemctl --user restart daily-log-worker.service
```

시스템 서비스로 설치했다면 경로는 `/etc/systemd/system/daily-log-worker.service.d/db-wait.conf`이고 위 명령과 아래 점검 명령에서 `--user`를 뺀다. 두 manager에 같은 worker를 중복 기동하지 않는다. 사용자 서비스의 부팅 시 실행은 관리자에게 enable 및 linger 상태를 별도로 확인받는다. 이 문서의 기존 백업·롤백 예시는 시스템 서비스 기준이므로 실제 설치 유형에 맞춰 일관되게 선택한다.

이 정책은 DB 지연에 대한 재시작을 지속하지만 잘못된 자격 증명·마이그레이션·설정 오류도 반복할 수 있다. 재시작 횟수가 계속 증가하면 관리자가 원인을 조사하며 정상 복구로 기록하지 않는다. 수동 stop은 자동 재시작 대상으로 간주하지 않는다. 공식 기준: [systemd 시작 제한](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval), [Restart/RestartSec](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=).

### 릴리스 전 읽기 전용 체크리스트 (필수)

`release.mjs status`는 승인 JSON과 아래 TASK-132 자동 사전 점검을 실행한다. 외부 include와 실제 서비스의 모든 실효 설정까지 검증하지는 않는다. `READY_FOR_ADMIN_SWITCH`만으로 아래 항목을 통과 처리하지 않는다. 단순 문자열 검색은 다른 vhost·주석·덮어쓴 drop-in을 오인할 수 있어 이 단계는 관리자가 실효 설정을 대조하는 체크리스트로 제공한다. 파일을 읽을 수 없거나 설정 범위를 확인하지 못하면 **NOT_RUN**, 누락·기준 미달이면 **FAIL**로 기록하고 릴리스를 보류한다.

- [ ] **업로드 한도**: 해당 HTTPS vhost 및 업로드 경로에 적용되는 include/location을 읽고 `client_max_body_size 11m;`가 실효 값인지 확인한다. 명시값이 없으면 상위 상속까지 추적한다. 모든 범위에서 누락이면 기본 `1m`이므로 FAIL; `10m` 이하 또는 무제한 `0`도 이 기준에서는 FAIL. 값·적용 범위만 기록하고 전체 nginx 설정 출력은 보고서에 붙이지 않는다.
- [ ] **worker 정책**: 아래 읽기 전용 명령의 실효 값이 `Restart=on-failure`(또는 `always`), `RestartUSec=10s`, `StartLimitIntervalUSec=0`인지 확인한다. 서비스 미설치(`LoadState`가 `loaded` 아님), `Restart=no`, 시작 제한이 0이 아님, 재시작 간격 누락/기준 불일치, DB 실패를 막는 `RestartPreventExitStatus`가 있으면 FAIL로 기록하고 위 drop-in 절차를 안내한다. `StartLimitBurst`만 늘리는 것으로 대체하지 않는다.

```sh
systemctl --user show daily-log-worker.service \
  -p LoadState -p Restart -p RestartUSec -p StartLimitIntervalUSec \
  -p RestartPreventExitStatus -p ActiveState -p SubState -p NRestarts
```

- [ ] **관리자 적용 후 확인**: nginx 검사/reload 결과, 실효 worker 정책 재조회 결과를 기록한다. 설정 변경 전 체크리스트와 구분한다. 설정이나 환경 전체를 출력하는 `systemctl show`/`cat` 또는 `nginx -T` 출력을 공유하지 않는다.
- [ ] **별도 검증 환경 재현**: 유료 제작을 비활성화한 격리 환경에서 DB 미기동 상태로 worker를 시작하고, 기존 5회 실패를 넘도록 60초 이상 재시작이 지속되는지 확인한 뒤 DB를 기동한다. worker가 수동 reset 없이 active 상태를 유지하고 DB 복구가 완료되는지 확인한다. 시각·종료 코드·재시작 횟수만 기록한다. 운영 DB를 이 시험 때문에 정지하지 않는다.
- [ ] **업로드 실사용 확인**: 관리자 시험 계정으로 유효한 약 3.2MiB 및 10MiB 사진을 업로드해 nginx 413이 사라지고 앱 저장에 성공하는지 확인한다. 10MiB 초과 파일은 앱에서 거부되어야 한다. 인증/형식 오류는 성공 증거가 아니다. 개인 사진·쿠키·토큰은 증거에 포함하지 않는다.

체크리스트 기록 양식: `commit / 설치 유형(user 또는 system) / 항목 / PASS·FAIL·NOT_RUN / 실효 값 또는 비민감 결과 / 확인자·시각`. TASK-127의 저장소 문서 검증은 이 운영 확인을 대신하지 않는다.

## 버전 고정 묶음과 실행 전제

```sh
# 검토된 TASK-30 checkout에서 실행; 빌드와 저장소는 /workspace 안
node scripts/ops/bundle.mjs 5680ca374afe6cd8065a3e43402b8c4d285f8312 /workspace/data/task30/release
sha256sum /workspace/data/task30/release/source.tar
cat /workspace/data/task30/release/manifest.json
```

동일 출력 위치는 덮어쓰지 않는다. 묶음은 **잠금 소스**이며 실행 바이너리/의존성이 들어 있는 컨테이너 이미지가 아니다. npm lockfile과 Git tree를 고정하고, 아래 설치·빌드를 별도 릴리스 디렉터리에서 완료해야 한다. 설치 시 인터넷 npm 레지스트리 접근이 필요하며 lockfile integrity를 사용한다. 실제 결과:

- source.tar SHA-256: `29872e541e13ecd46babc87963c39a2269aa5c95ab989d4061dee31b55797f80`
- package-lock.json SHA-256: `e5ec0c1723ae501d2c3a79929ed5bf0de5d807d39ec23b2beb3a1d099e16efd7`
- 이번 검증 Node `22.23.3`, PostgreSQL 클라이언트/서버 `17.11`; npm 버전·ffmpeg/Chromium 버전은 evidence.md 참조. 운영은 이 실행 환경을 관리자가 검증하여 준비해야 하며 `engines >=22`만으로 동등성을 주장하지 않는다.

```sh
# 새 릴리스 디렉터리에서만 (제안 경로, 관리자 수행)
RELEASE=5680ca374afe6cd8065a3e43402b8c4d285f8312
ROOT=/srv/daily-log
mkdir -p "$ROOT/releases/$RELEASE"
tar -xf source.tar -C "$ROOT/releases/$RELEASE"
cd "$ROOT/releases/$RELEASE"
npm ci
npm run build
# 앱: node apps/server/dist/main.js
# 작업기: node apps/server/dist/worker.js
# runtime.env는 서비스 관리자가 공급. Vite dev 서버 운영 사용 금지.
```

필수: `DATABASE_URL`, `FILE_STORAGE_DIR`, `SESSION_SECRET`; 인증: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, `PUBLIC_BASE_URL=https://daily.log2u.me`, `APP_URL=https://daily.log2u.me/`. `GOOGLE_ISSUER`는 운영에서 기본 Google 값, mock issuer 금지. `DRIVE_TOKEN_KEY`는 기존 값 보존. 제공된 격리 `REDIS_URL`은 이번 Task에서 변경하지 않았으며 큐의 지속 상태는 PostgreSQL이다.

제작 준비의 한계: 현재 실제 작업기는 Pro·TTS·이미지 설정 없으면 권한 대기한다. `pipelineRuntime.ts`의 품질 근거 제공자 `quality: null`은 `QUALITY_EVIDENCE_UNAVAILABLE`로 멈춘다. 모의 파이프라인 PASS가 실서비스 제작 완료를 의미하지 않는다. 운영 개통 판단에서 이 조건을 별도로 해결/검토해야 한다. 실제 유료 호출은 수행하지 않았다.

## 백업·마이그레이션·정확한 롤백 순서 (관리자 전용)

사전 조건: 아래 unit 이름/ROOT는 제안이며 설치 전 관리자 확인 필요. `PGSERVICEFILE`의 `daily_log` 및 빈 `daily_log_recovery` 연결은 관리자가 별도 작성(0600), PostgreSQL 17 도구 사용. DB/파일 스냅샷 시각을 맞추려면 **API와 워커 모두 정지**해야 한다. pg_dump만으로 파일 일관성을 보장하지 않는다. 이번 워커에서 운영 명령은 실행하지 않았다.

```sh
set -eu
umask 077
ROOT=/srv/daily-log
SNAP="$ROOT/backups/pre-task30"
mkdir -p "$SNAP"
# 동일 snapshot 재사용/덮어쓰기 금지
 test ! -e "$SNAP/db.dump"
systemctl stop daily-log-worker.service daily-log-api.service
readlink "$ROOT/current" > "$SNAP/previous-release.txt"
cp -p "$ROOT/shared/runtime.env" "$SNAP/runtime.env"
# PGSERVICEFILE는 관리자 설정; 비밀번호를 명령 인자나 로그로 출력하지 않음
PGSERVICE=daily_log pg_dump --format=custom --no-owner --no-acl --file="$SNAP/db.dump"
tar -cf "$SNAP/files.tar" -C "$ROOT/shared/files" .
(cd "$ROOT/shared/files" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$SNAP/files.sha256"
(cd "$SNAP" && sha256sum db.dump files.tar > snapshot.sha256)
# 별도 복구 DB/파일에서 아래 복원·해시 확인을 먼저 완료하여 backupVerified 기록
# 새 릴리스 checkout에서 서비스 관리자에게 받은 환경으로 (비밀 출력 금지)
node apps/server/dist/db/migrate.js
```

마이그레이션 실행기는 `schema_migrations`와 advisory lock을 쓰며 파일별 transaction이다. 전체 적용이 한 transaction은 아니므로 중간 실패 시 부분 적용 상태를 확인하고 정지 상태를 유지한다. 동일 버전 재실행은 적용 이력을 건너뛴다. `db:seed`는 운영에 실행하지 않는다.

```sh
# 롤백: API/워커 정지 유지, 기존 DB와 파일은 폐기하지 않는다.
set -eu
umask 077
ROOT=/srv/daily-log
SNAP="$ROOT/backups/pre-task30"
systemctl stop daily-log-worker.service daily-log-api.service
(cd "$SNAP" && sha256sum -c snapshot.sha256)
# daily_log_recovery는 DBA가 생성한 빈 별도 DB. 기존 DB에 --clean 금지.
PGSERVICE=daily_log_recovery pg_restore --exit-on-error --no-owner --no-acl --dbname='service=daily_log_recovery' "$SNAP/db.dump"
mkdir "$ROOT/shared/files-recovery"
tar -xf "$SNAP/files.tar" -C "$ROOT/shared/files-recovery"
(cd "$ROOT/shared/files-recovery" && sha256sum -c "$SNAP/files.sha256")
# 원본 설정 사본 복귀; 이후 관리자가 DB와 파일 경로 두 값만 복구 대상으로 편집
cp -p "$SNAP/runtime.env" "$ROOT/shared/runtime.env.recovery"
# DATABASE_URL -> daily_log_recovery, FILE_STORAGE_DIR -> files-recovery
# 담당자 검토·DB 행 수/완료 RESULT·예산 원장 대조 후:
mv "$ROOT/shared/runtime.env.recovery" "$ROOT/shared/runtime.env"
PREVIOUS=$(cat "$SNAP/previous-release.txt")
ln -s "$PREVIOUS" "$ROOT/current.rollback"
mv -Tf "$ROOT/current.rollback" "$ROOT/current"
# 기존 vhost를 바꿨다면 백업한 해당 파일만 복구. 실제 경로는 관리자 기록에서 가져옴.
# cp -p "$SNAP/nginx-vhost.conf" "$VERIFIED_VHOST_PATH"
# nginx -t && systemctl reload nginx
# DNS는 기록한 이전 A/AAAA/TTL로 복구, Google 신규 redirect만 제거.
# 검증 후 관리자만 앱 서비스 재개:
systemctl start daily-log-api.service daily-log-worker.service
```

API 재개 전에 복원 DB의 기록·RESULT 버전·pipeline DONE/PASSED·예산 원장을 백업과 비교한다. 시험 단계에서만 전환하여 새 쓰기가 없을 때 위 스냅샷 복귀를 사용한다. **전환 뒤 쓰기가 발생했다면** 먼저 현행 DB/파일을 별도 보존하고, 새 기록/완료 결과/원장을 병합할 복구 계획을 관리자에게 제출한다. 오래된 스냅샷을 바로 서비스에 연결하면 최신 결과가 누락되므로 자동 롤백하지 않는다. Drive 백업을 삭제하거나 과금 결과 불명 작업을 재전송하지 않는다.

## 승인 게이트와 승인 양식

게이트는 제안 ROOT의 `approval.json`을 읽는다. 관리자 이름, 정확한 릴리스 SHA, 승인/만료 시각, 백업 확인 및 DNS/HTTPS/Google/Android/PC 확인이 모두 필요하다. 이 파일은 서비스 계정이 작성할 수 없는 관리자 소유 디렉터리에 두며 승인자의 실제 판단은 사람의 책임이다. 서명 검증·승인자 신원 인증 시스템을 구현한 것은 아니다.

아래는 **빈 양식**이다. 승인 기록이 아니며 그대로 쓰면 거부된다. 실제 관리자 승인을 만들어내지 않았다.

```json
{
  "commit": "5680ca374afe6cd8065a3e43402b8c4d285f8312",
  "administrator": "",
  "approvedAt": "",
  "expiresAt": "",
  "backupVerified": false,
  "externalChecks": { "dns": false, "https": false, "google": false, "android": false, "pc": false },
  "evidence": { "backup": "", "externalTests": "", "approvalTicket": "", "previousRelease": "" }
}
```

```sh
# TASK-30 도구 checkout에서, 상태 조회는 변경 없음
node scripts/ops/release.mjs status /srv/daily-log 5680ca374afe6cd8065a3e43402b8c4d285f8312
# 아래는 관리자 승인 후 별도 운영 작업에서만. 이번 Task 실행 금지.
node scripts/ops/release.mjs switch /srv/daily-log 5680ca374afe6cd8065a3e43402b8c4d285f8312
```

`switch`는 승인 검사 뒤 `current` symlink만 원자 교체하며 DNS/서비스/DB는 건드리지 않는다. 누락/만료/다른 커밋은 `WAITING_APPROVAL`, 외부 조건 미완료는 `WAITING_EXTERNAL_CHECKS`, 준비 완료는 `READY_FOR_ADMIN_SWITCH`, 포인터 교체 뒤에도 `SWITCHED_PENDING_VERIFICATION`이다. 모두 `deployed:false`, ‘개통 미완료’를 출력한다. 게이트 통과가 서비스를 개통하거나 최종 승인한 것으로 표시되지 않는다. 최종 개통 기록은 관리자 별도 이력으로 남겨야 한다.

## 검증 범위와 관리자 대기 항목

격리 시험은 제공된 PostgreSQL17의 임시 스키마와 `/workspace/data/task30/` 임시 파일, 모의 OIDC, Chromium PC/Pixel7 에뮬레이션을 사용했다. 실제 외부망·Google OAuth·Android 실기기·운영 nginx·TLS는 **NOT_RUN / 관리자 수행 대기**다. 승인 양식의 외부 확인 값을 격리 시험만으로 true로 채우면 안 된다.

관리자: 별도 네트워크에서 실제 PC/Android 로그인, 허용/비허용/비로그인 앱·첨부·영상 직접 URL, 로그아웃/만료, HTTPS/리디렉션/쿠키, WebSocket, 실제 영상 재생, 기존 push-test 및 다른 vhost 무영향을 기록한다. 원본 파일은 정적 경로로 노출되지 않는지 별도로 검증한다. 미확인 상태에서는 VPN/LAN 접근을 유지하며 개통 완료로 표시하지 않는다.

재현 명령과 실제 결과·한계는 [evidence.md](evidence.md)에 기록한다. Wiki07/08/09 및 Flowchart 원문은 scoped MCP에 읽기 도구가 없어 미열람이며, Task 패킷 scopeRevision7과 저장소 구현을 기준으로 작성했다.

## TASK-132 읽기 전용 자동 사전 점검

- [ ] 검토된 도구 checkout에서 자동 점검 JSON과 종료 코드를 기록한다. 기본 nginx 경로는 `/etc/nginx/conf.d/daily-log.conf`이며 worker는 `systemctl --user show daily-log-worker`의 제한된 속성만 읽는다. 서비스 상태 변경·설정 수정은 하지 않는다.

```sh
node scripts/ops/preflight.mjs
# 별도 파일을 검사할 때 (설정 원문이나 비밀값은 결과에 출력하지 않음)
node scripts/ops/preflight.mjs --nginx-config /path/to/daily-log.conf \
  --worker-properties /path/to/worker-properties.txt
# 조회에도 같은 인자를 사용할 수 있다. 인자를 생략하면 위 기본 소스를 읽는다.
node scripts/ops/release.mjs status /srv/daily-log <40자리-commit> \
  --nginx-config /path/to/daily-log.conf --worker-properties /path/to/worker-properties.txt
```

`worker-properties.txt`는 `systemctl --user show daily-log-worker -p Restart -p RestartUSec -p StartLimitIntervalUSec -p LoadState` 출력 형식이다. 임의의 예제 파일은 실제 운영 검증 근거가 아니며, 관리자는 해당 서버의 최신 출력인지 확인한다.

- nginx: 앱 `policy.ts`의 `photoBytes + 1024`(현재 10,486,784바이트)보다 **큰 유한값**을 요구한다. `11m`과 `1g`/`1G`는 PASS이며, 바이트 및 k/K/m/M/g/G 단위를 지원한다. 누락·`1m`·`10m`·`0`은 FAIL이다. HTTPS server와 모든 하위 블록의 상속 및 location 재정의를 검사하며, 여러 HTTPS server가 있으면 모두 통과해야 한다. 업로드와 무관한 location도 보수적으로 검사한다. 주석·따옴표를 구분하지만 완전한 `nginx -t` 대체 도구는 아니다.
- 외부 `include`는 자동으로 펼치지 않는다. include 존재·HTTPS server 부재·구문/앱 정책 해석 불가는 NOT_RUN이며 실효 설정을 별도로 확인한다. 확인된 한도 위반은 NOT_RUN보다 우선하여 FAIL이다.
- worker: `Restart=on-failure|always`, 유한한 `RestartUSec>0`, `StartLimitIntervalUSec=0`을 요구한다. 지속 복구를 위해 유한한 시작 제한은 크기와 무관하게 FAIL이다. 입력에 LoadState가 있으면 loaded여야 한다. 기존 체크리스트의 `RestartPreventExitStatus`와 실제 DB 복구 시험은 별도 수동 확인 항목이다.
- 파일 없음·읽기 권한 없음·systemctl 조회 불가는 NOT_RUN이다. 결과는 `{checks:[{id,result,detail}]}`이며 단독 점검은 FAIL이 하나라도 있으면 종료 코드 1, 그 외 0이다. **종료 코드 0만으로 모든 항목 PASS를 판단하지 않는다.**
- release `status`/`switch`에는 `preflight` 결과가 포함된다. FAIL이면 `WAITING_PREFLIGHT`(종료 코드 2)로 거부하며 `current`는 바뀌지 않는다. NOT_RUN은 자동 차단하지 않지만 출력에 남고, 기존 관리자 승인·외부 확인 게이트는 계속 적용한다. switch의 선택 인자는 status와 같다. 실제 전환은 기존 관리자 전용 절차를 따른다.

회귀 시험은 순차 실행한다:

```sh
mkdir -p /workspace/data/task30
node --test --test-concurrency=1 scripts/ops/*.test.mjs
```
