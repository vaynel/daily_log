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
