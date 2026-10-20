# TASK-47: TASK-5 독립 검수

2026-10-20. 판정: **CHANGES_REQUESTED**. 영상 성능·보존 동작은 아래 한정 범위에서 재현했지만, 검증 도구의 거짓 성공 P2 두 건을 원 담당에게 회송한다. 출시 승인·배포를 수행하지 않았다. 제품 구현은 수정하지 않았다.

## 고정 제출과 무결성

- 원 개발 run: `23477fdc-34de-4041-970d-19bf4d192886`
- 검수 run: `3725e2de-de50-4bb7-bbe9-8aed412170c4`
- 검수 packet: `17a7dc724eef1e764dd6bb7f0e63048c49776e90d97ed5e584a7baec3eb0371f`
- 실제 origin: `https://github.com/vaynel/daily_log.git`
- 기준 commit: `ac08e0c45af12f11c117dec42b9fc3259b86eb9b`
- tree: `5e2ca4748cd0f06ea44d389b117c043c68c6edc3`
- 영상 SHA256: `ebecf326b8d53aa69ebfdae3b7bf3f0c3f5d9d6f5164272d812a2058a4857e9d`

`/run/mandu/MANDU-HANDOFF.json`과 get_task.dependencies의 고정 제출, 실제 HEAD/tree/영상 해시를 대조했다. checkout 복사본 handoff는 사용하지 않았다. handoff의 bundle SHA256 `d867dc45443647735787efe3d63d06ae8ee20cd3546542d60c2dfae4c5bfe876`은 기록만 확인했다. bundle 바이트는 호스트 전용 경로에 있어 재계산은 **NOT_RUN**이며, checkout tree 일치와 bundle 전송 무결성을 혼동하지 않는다. runner claim/ACK/recovery/artifact publication은 수행하지 않았다.

## 원래 완료 조건 검수표

| 원래 조건 | 결과 | 실제 증거와 범위 |
|---|---|---|
| AC-1. 샘플은 9:16이며 재생 시간이 180초 이하이다. (검증: 파일 메타데이터) | PASS | `task-47-evidence/submitted-probe.json`: 720×1280, 24fps, h264+aac, 180초, 2,138,651 bytes. 독립 재렌더도 동일 SHA256. |
| AC-2. 렌더 시간·최대 메모리·임시 파일 용량과 시험 환경이 기록된다. (검증: 측정 로그) | PASS | 제출 measure 로그 4개와 독립 `environment.txt`, `render.txt` 대조. N100, cgroup 2코어/3GiB, FFmpeg 5.1.9. 독립 wall 47.603초, maxRSS 546,740KB, 종료 직전 임시 폴더 2,147,697 bytes. 측정 wrapper의 실패 전파 결함은 F2로 별도 기록. |
| AC-3. 실패 시 기존 입력과 이전 결과가 보존된다. (검증: 중단 시험) | PASS (시험한 3경로) | `independent-failures.txt`: SIGKILL, 없는 폰트, RLIMIT_FSIZE/EFBIG 각각 실제 실패 원인 확인, nonzero exit, published=false, 입력 파일별/이전 영상 SHA 불변, tmp 정리. 별도 assert harness 종료 0. 원본 failure suite의 신뢰성 결함 F1은 미해결. 실제 ENOSPC·부모 프로세스 강제 종료는 NOT_RUN. |
| AC-4. AI 동영상 생성 API 호출이 없다. (검증: 의존성·호출 기록) | PASS (제출 코드/실행 범위) | render.mjs·measure.sh·failure-tests.sh·scenes.json 전체 확인. child process는 FFmpeg/ffprobe/espeak-ng/fc-query/time/pkill과 로컬 shell. HTTP 클라이언트/URL 호출 검색 0건, package.json/lock diff 없음. 유료 API 호출 없음. 패킷 캡처 감사는 NOT_RUN. |

## 필수 수정

### F1 — P2: 실패 시험이 미실행·잘못된 실패를 성공 보존으로 판정

대상: `scripts/video-spike/failure-tests.sh:6-15`.

```sh
mkdir -p data/qa5/missing
sh scripts/video-spike/failure-tests.sh data/qa5/missing
```

입력/영상이 없고 renderer가 `run prepare first`로 끝나도 세 사례 모두 `PRESERVED`를 출력하고 suite exit=0이다 (`failure-missing.txt`). `h()`의 내부 find/sha 실패는 pipeline 마지막 해시의 성공에 가려진다. `check()`는 변조/잔여 tmp도 출력만 하며 실패 종료하지 않는다. 주석과 달리 예상 실패 코드/원인 검증이 없다.

유효한 입력·이전 영상을 넣고 기본 폰트만 없는 별도 디렉터리에서도 T1 중단/T3 용량 시험이 모두 FONT_MISSING_OR_NO_HANGUL로 조기 종료하는데 `PRESERVED`, exit=0이다 (`failure-font-misclassified.txt`). SIGKILL/EFBIG가 실행되지 않았는데도 통과로 오인할 수 있다.

수정 요구: 필수 fixture와 hash 명령 성공 확인, 사례별 기대 실패 원인·exit·published 확인, 변조/정리 실패 시 suite nonzero 반환. 정상 3경로와 잘못된 사전 조건을 모두 회귀 검증해야 한다.

### F2 — P2: 성능 측정 wrapper가 렌더 실패를 성공 종료로 숨김

대상: `scripts/video-spike/measure.sh:5-17`.

```sh
mkdir -p data/qa5/missing
sh scripts/video-spike/measure.sh data/qa5/missing
```

렌더러는 입력 누락으로 실패하지만 wrapper exit=0 (`measure-missing.txt`). `{ ... } | tee`의 최종 종료 상태가 tee 성공이어서 `set -e`만으로 렌더 오류가 호출자에게 전달되지 않는다. 필수 실행 실패를 nonzero로 전파하고, 성공 측정과 실패 로그를 분리해야 한다. 제출된 성공 로그 자체가 허위라는 뜻은 아니다.

## 독립 재현 방법 및 환경 조정

컨테이너에 ffmpeg/ffprobe/espeak-ng/time/Noto 폰트가 없었다. Debian 패키지를 `data/qa5/apt`에 다운로드하고 `data/qa5/deps`로 추출했다. 설치 의존성·시험 입력은 모두 /workspace 내부이며 호스트 Docker/운영 서비스에 접근하지 않았다.

`data/qa5/env.sh`로 PATH와 LD_LIBRARY_PATH(기본 lib, blas, lapack)를 설정했다. espeak-ng wrapper는 `--path=/workspace/data/qa5/deps/usr/lib/x86_64-linux-gnu`를 추가했다.

원본 `prepare`/`probe`를 실행했다. 렌더는 `data/qa5/render-copy/render.mjs`에 원본을 복사하고 **`/usr/bin/time` 한 곳만 `/workspace/data/qa5/deps/usr/bin/time`으로 교체**했다. scenes.json은 원본 그대로 복사했다. 폰트는 기존 `--fontfile` 옵션으로 workspace의 NotoSansCJK-Bold.ttc를 전달했다. 렌더 로직 수정은 없지만 바이트 단위 무수정 실행이라고 주장하지 않는다.

```sh
. data/qa5/env.sh
node scripts/video-spike/render.mjs prepare --out data/qa5/repro
node data/qa5/render-copy/render.mjs render --out data/qa5/repro \
  --fontfile /workspace/data/qa5/deps/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc
node scripts/video-spike/render.mjs probe --out data/qa5/repro
python3 docs/reviews/task-47-evidence/reproduce-failures.py
```

독립 렌더 1회 성공. 실패 harness는 입력/이전 영상 존재와 파일별 SHA256, 실패 원인, 정리 상태를 assert한다. 3/3 통과(exit=0). 이 검수용 harness는 원본 결함을 수정하거나 원 담당의 회귀 테스트를 대체하지 않는다.

## 시각 검수와 미실행 범위

선행 이미지 `690d6c48-2c72-45e7-bb59-87f55a737365`, `22994db2-0bfd-4e04-b69e-94527b238731`를 read_screenshot으로 열람했다. 제출 영상에서 100초 프레임을 독립 추출해 캐릭터·한글 학습 문구·하단 자막을 확인했다. 지정 helper로 REVIEW 이미지 `1b452267-8807-43f7-87ff-6585f899f6ab`를 첨부했다. **합성 성능시험 영상의 추출 프레임이며 실제 앱 화면이 아니다.** helper가 provenance를 LIVE로 저장했지만 caption에는 재현 이미지임을 명시했다. BEFORE는 신규 spike에 해당 상태가 없어서 만들지 않았다.

- 실제 ENOSPC, 전원 손실/부모 강제 종료, 동시 renderer, 조용한 호스트 단독 성능, 1080×1920, 실제 사진, 최종 한국어 음색·주관적 음질, Android 실기기, 실제 사용자 기록: **NOT_RUN**, 지원 보장 아님.
- 음량 -22.6dB와 오디오 트랙은 기계 검사 결과이며 실제 청취 검수가 아니다.
- `--ulimit-kb 512`는 shell의 단위 해석에 의존한다. 이번 EFBIG 임시 폴더는 271,190 bytes였다. 실제 ENOSPC/정확한 512KiB 한도로 표현하지 않는다.
- Wiki 04/07/09 원문 조회 도구 없음. F03 URL은 웹 도구 접근 실패. 원문 **미열람**이며 고정 패킷·원래 4개 AC만 적용했다.
- 전체 앱 CI는 실행하지 않았다. 이 검수의 구현 변경은 없으며 관련 렌더/실패 재현에 한정했다.

## TASK-47 자체 완료 조건

1. AC-1 PASS: 원 개발 4개 완료 조건을 위 표에서 실제 산출물·실행 증거와 대조했다.
2. AC-2 PASS: 독립 실행, 경로 조정, NOT_RUN 및 환경 제약을 분리했다.
3. AC-3 PASS: CHANGES_REQUESTED와 필수 P2 수정 2건, 미실행 후속 관찰을 기록했다.

읽은 참조: get_task/begin_task 고정 패킷 전체, immutable handoff, 저장소 README, video-spike 전체 소스/README/제출 로그, 두 선행 이미지. AGENTS.md는 저장소에서 발견되지 않았다. 적용 스킬: 고정 verification-before-completion, systematic-debugging, 검수 체크리스트. 신규 spike라 differential-review의 제외 조건에 따라 일반 코드 검수를 수행했다.
