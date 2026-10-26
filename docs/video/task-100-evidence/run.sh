#!/usr/bin/env bash
set -u
cd /workspace
out=docs/video/task-100-evidence
run() {
 name=$1; shift
 printf 'START %s\n' "$name"
 "$@" > "$out/$name.log" 2>&1
 result=$?
 printf '\nexit_code=%s\n' "$result" >> "$out/$name.log"
 printf 'END %s exit_code=%s\n' "$name" "$result"
}
run quality timeout --kill-after=10s 180s npm test -w apps/server -- src/video/quality.test.ts src/video/qualityQueue.test.ts src/video/qualityStage.test.ts
run build timeout 120s npm run build -w apps/server
run quality-restart timeout 60s node scripts/quality-restart-e2e.mjs
run check timeout --kill-after=10s 900s npm run check
