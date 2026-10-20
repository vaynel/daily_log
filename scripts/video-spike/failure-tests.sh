#!/bin/sh
# D05-04 failure injection in a dedicated dir. Never touches host services or fills the real disk.
# Requires: render.mjs prepare + one successful render already run for $OUT.
# Each case must (a) pass its preconditions, (b) fail for the EXPECTED cause, (c) leave inputs + previous
# result byte-identical and no tmp dir. Any violation, or a precondition that is not met, exits non-zero.
OUT=${1:-scripts/video-spike/out}
R="node scripts/video-spike/render.mjs"
FAILS=0
fail() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
h() { node scripts/video-spike/hash-state.mjs "$OUT"; }

# Preconditions: without inputs and a previous result, "preserved" would be meaningless.
[ -f "$OUT/sample.mp4" ] || { echo "PRECONDITION FAILED: $OUT/sample.mp4 missing (run render first)"; exit 2; }
[ -f "$OUT/assets/narration.wav" ] || { echo "PRECONDITION FAILED: $OUT/assets missing (run prepare first)"; exit 2; }
[ -n "$(find "$OUT/assets" -type f)" ] || { echo "PRECONDITION FAILED: assets empty"; exit 2; }
[ -f "${FONT:-/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc}" ] || { echo "PRECONDITION FAILED: default font missing, cannot isolate font case"; exit 2; }
B=$(h) || { echo "PRECONDITION FAILED: cannot hash all inputs and previous result"; exit 2; }
[ -n "$B" ] || { echo "PRECONDITION FAILED: empty baseline hash"; exit 2; }
echo "baseline state hash=$B"

# run_case NAME EXPECT_REGEX EXPECT_EXIT_DESC render-args...
# EXPECT_REGEX must match the render's combined output, proving the failure came from the injected fault.
run_case() {
  name=$1; expect=$2; shift 2
  echo "== $name"
  outf=$(mktemp); $R render --out "$OUT" "$@" >"$outf" 2>&1; rc=$?
  tail -c 600 "$outf"
  [ "$rc" -ne 0 ] && echo "exit=$rc (non-zero, expected)" || fail "$name: render exit 0 (fault not triggered)"
  grep -Eq "$expect" "$outf" && echo "cause matched: $expect" || fail "$name: expected cause /$expect/ not found in output"
  grep -q '"published": *true' "$outf" && fail "$name: result was published"
  rm -f "$outf"
  A=$(h) || { fail "$name: cannot verify inputs/previous result"; return 1; }
  [ -n "$A" ] || { fail "$name: empty verification hash"; return 1; }
  echo "state hash before=$B after=$A"
  [ "$A" = "$B" ] && echo "RESULT $name: PRESERVED" || fail "$name: inputs/previous result CHANGED"
  [ -d "$OUT/.tmp-render" ] && fail "$name: tmp dir left behind" || echo "tmp dir cleaned"
}

run_case "T1 abort (SIGKILL after 8s)" '"signal": *"SIGKILL"' --kill-after 8
run_case "T2 missing font" 'FONT_MISSING_OR_NO_HANGUL' --fontfile /nonexistent/font.ttc
run_case "T3 disk-full simulation (RLIMIT_FSIZE 512KB => EFBIG, not real ENOSPC)" 'File too large' --ulimit-kb 512

if [ "$FAILS" -ne 0 ]; then echo "OVERALL: FAIL ($FAILS problem(s))"; exit 1; fi
echo "OVERALL: PASS (3/3 cases failed for the injected cause and preserved state)"
