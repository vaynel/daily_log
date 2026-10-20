#!/bin/sh
# D05-04 failure injection in a dedicated dir. Never touches host services or fills the real disk.
# Requires: render.mjs prepare already run for $OUT. Verifies previous result + inputs are byte-identical after each failure.
OUT=${1:-scripts/video-spike/out}
R="node scripts/video-spike/render.mjs"
h() { (cd "$OUT" && find assets -type f | sort | xargs sha256sum; sha256sum sample.mp4) | sha256sum | cut -d' ' -f1; }
check() { # name expected_nonzero_exit
  A=$(h); echo "--- $1: state hash before=$B after=$A"
  [ "$A" = "$B" ] && echo "RESULT $1: PRESERVED (inputs+previous sample unchanged)" || echo "RESULT $1: CHANGED!"
  [ -d "$OUT/.tmp-render" ] && echo "WARN $1: tmp dir left behind" || echo "tmp dir cleaned"
}
B=$(h)
echo "== T1 abort (SIGKILL after 8s)"; $R render --out "$OUT" --kill-after 8 | grep -E '"(exit|signal|published|previousResult)'; check abort
echo "== T2 missing font"; $R render --out "$OUT" --fontfile /nonexistent/font.ttc 2>&1 | grep -E "exit|published|error"; check missing-font
echo "== T3 disk-full simulation (RLIMIT_FSIZE 512KB => EFBIG on write, not real ENOSPC)"; $R render --out "$OUT" --ulimit-kb 512 | grep -E '"(exit|published|ffmpegStderrTail)'; check fsize-limit
