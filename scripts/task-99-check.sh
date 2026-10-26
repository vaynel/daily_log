#!/usr/bin/env bash
# Run each package.json check stage with an independent deadline and exit record.
# Requires the provided isolated services and existing npm dependencies.
set -u
cd "$(dirname "$0")/.."
out=docs/video/task-99-b-evidence
mkdir -p "$out"
failed=0
for stage in lint typecheck test build test:spike test:records-crash test:queue-restart test:notify-e2e; do
  name=${stage//:/-}
  printf 'START %s\n' "$stage"
  # The preserved full server suite took 263s; allow its real FFmpeg work to finish.
  limit=240s
  if [ "$stage" = test ]; then limit=480s; fi
  timeout --kill-after=10s "$limit" npm run "$stage" > "$out/check-$name.log" 2>&1
  result=$?
  printf '\nexit_code=%s\n' "$result" >> "$out/check-$name.log"
  printf 'END %s exit_code=%s\n' "$stage" "$result"
  if [ "$result" -ne 0 ]; then failed=1; fi
done
exit "$failed"
