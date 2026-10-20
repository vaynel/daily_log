# TASK-5 영상 합성 성능 시험 (N100, FFmpeg 전용)

합성 자산만 사용하며 AI 동영상 생성 서비스·외부 네트워크 호출이 없다 (`grep -E "https?://|fetch\(" scripts/video-spike` → 0건, package.json/lock 변경 없음, 사용 도구: ffmpeg/ffprobe/espeak-ng/fc-query/pkill).
espeak-ng 음성은 **성능 시험용**이며 최종 한국어 음색 선정이 아니다. 문구는 합성 학습 예시이며 실제 사용자 기록이 아니다.

## 절차
```sh
node scripts/video-spike/render.mjs prepare --out scripts/video-spike/out   # 에셋(캐릭터·배경·자막·음성) 생성
sh scripts/video-spike/measure.sh scripts/video-spike/out                    # 환경 기록 + 시간·maxRSS 측정 렌더
node scripts/video-spike/render.mjs probe --out scripts/video-spike/out      # ffprobe 메타데이터
sh scripts/video-spike/failure-tests.sh scripts/video-spike/out              # 중단·폰트 누락·용량 제한 시험
```
렌더는 `.tmp-render/`에 쓰고 성공 시에만 `sample.mp4`로 atomic rename한다. 결과: `out/sample.mp4`, `out/measure-*.log`, `out/failure-tests.log` (assets는 gitignore, prepare로 재생성).

## 결과 (2026-10-20, Intel N100, cgroup cpu 2코어 / mem 3GiB, ffmpeg 5.1.9)
- 샘플: 720x1280(9:16) 24fps h264+aac, 180.0s, 2.1MB, 음성 트랙(평균 -22.6dB, 음성 약 90s + 무음 패딩), 음악 없음. 재렌더 sha256 동일(결정적).
- 렌더(단일 ffmpeg, -threads 2, x264 veryfast crf28) 3회: wall 46.5/47.4/48.3s (약 0.26x 실시간), maxRSS ≈547MB, user CPU ≈88s(≈1.9코어), 임시 출력 2.1MB, 에셋 20MB, cgroup oom/max 0.
- 한계: 호스트에 다른 러너가 병렬 실행 중(loadavg 3.2~4.9)이라 조용한 단독 값이 아니다. cgroup memory.peak는 리셋 불가(누적)라 maxRSS를 사용. 1080x1920·실제 사진 변환·실제 한국어 음색은 미측정.
- 실패 시험(모두 이전 결과 sha·입력 에셋 hash 보존, 임시 폴더 정리): SIGKILL 중단, 폰트 누락(preflight exit 3), RLIMIT_FSIZE 512KB(EFBIG; 실제 ENOSPC가 아닌 모의).
- 발견: 존재하지 않는 `fontfile`이면 ffmpeg drawtext가 **오류 없이 exit 0**으로 끝나 이전 결과를 덮어썼다. 그래서 렌더 전 `preflightFont()`가 폰트 존재·한글 글리프를 확인한다.

종료 코드: `measure.sh`는 렌더의 종료 코드를 그대로 반환한다(렌더 실패 → non-zero). `failure-tests.sh`는 입력·이전 결과·폰트가 없으면 시험 전제 실패(exit 2), 각 케이스가 주입한 원인(SIGKILL / FONT_MISSING_OR_NO_HANGUL / File too large)으로 실패하지 않거나 상태 hash가 바뀌거나 tmp가 남으면 exit 1, 전부 충족할 때만 exit 0.

## 해시 읽기 오류 회귀 수정 (2026-10-20)

- 이전 셸 파이프는 `sha256sum`의 읽기 오류를 숨겼다. 읽기 불가 파일을 추가하면 오류가 발생해도 `OVERALL: PASS`, exit 0이었다(`out/pm-before-unreadable.log`).
- `hash-state.mjs`는 모든 파일을 읽은 뒤에만 전체 해시를 출력한다. 파일 경로에 공백이 있어도 안전하게 처리하며, 읽기 오류·누락·비정규 파일은 non-zero로 종료한다.
- 기준 해시를 만들 수 없으면 시험 전제 실패(exit 2), 주입 시험 이후 해시를 만들 수 없으면 검증 실패(exit 1)로 처리한다. 빈 해시도 허용하지 않는다.
- 비루트 사용자·네트워크 없는 미디어 컨테이너에서 `sh scripts/video-spike/hash-regression.sh`로 재현한다. `/tmp/video-audit`와 `.pm-hash-node`는 이 회귀 시험 전용 경로다.
- 실제 검증: 읽기 불가 입력 exit 2, 사후 해시 오류 주입 exit 1, 정상 중단·폰트 누락·EFBIG 보존 시험 3/3 통과. 공백 경로 파일 추가가 해시를 바꾸는 것도 확인했다. 대응 원시 로그는 `out/pm-after-unreadable.log`, `out/pm-after-hash-error.log`, `out/pm-failure-tests.log`.
- 최신 측정 로그는 제출본에 포함했다(`out/pm-measure.log`, `out/pm-probe.json`, `out/pm-video-hashes.txt`). N100·CPU 2·메모리 3GiB 제한에서 180초 영상 렌더 49.351초, 최대 RSS 547292KB, 임시 출력 2146905바이트. 720×1280, h264+aac이며 기존 제출 영상과 SHA256이 같다.
- 위 수치는 다른 개발 러너와 병렬 실행 중인 측정이다. 실제 ENOSPC·Android 재생·최종 음질·1080p는 미시험이며 성능 시험용 합성 영상의 범위를 넘는 보장은 하지 않는다.
