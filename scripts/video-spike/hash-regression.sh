#!/bin/sh
# Run as a non-root user inside the bounded, network-disabled media container.
set -eu
out=/tmp/video-audit
node scripts/video-spike/render.mjs prepare --out "$out" > /tmp/prepare.log 2>&1
cp scripts/video-spike/out/sample.mp4 "$out/sample.mp4"
node scripts/video-spike/hash-state.mjs "$out" >/tmp/original-hash
printf 'with spaces\n' > "$out/assets/name with spaces.txt"
node scripts/video-spike/hash-state.mjs "$out" >/tmp/changed-hash
if cmp -s /tmp/original-hash /tmp/changed-hash; then exit 1; fi
chmod 000 "$out/assets/name with spaces.txt"
set +e
sh scripts/video-spike/failure-tests.sh "$out" > scripts/video-spike/out/pm-after-unreadable.log 2>&1
rc=$?
set -e
[ "$rc" -eq 2 ]
! grep -q 'OVERALL: PASS' scripts/video-spike/out/pm-after-unreadable.log
printf 'UNREADABLE: exit=%s, no false PASS\n' "$rc"
chmod 600 "$out/assets/name with spaces.txt"
sh scripts/video-spike/failure-tests.sh "$out" > scripts/video-spike/out/pm-failure-tests.log 2>&1
printf 'INJECTED FAILURES: '
tail -1 scripts/video-spike/out/pm-failure-tests.log
# Regression of post-render hashing errors, not just baseline preconditions.
mkdir .pm-hash-node
cat > .pm-hash-node/node <<'EOF'
#!/bin/sh
case "$1" in
  */hash-state.mjs)
    count=$(cat /tmp/hash-count 2>/dev/null || echo 0)
    count=$((count + 1)); echo "$count" > /tmp/hash-count
    if [ "$count" -gt 1 ]; then echo 'controlled hash failure' >&2; exit 1; fi
    ;;
esac
exec /usr/local/bin/node "$@"
EOF
chmod +x .pm-hash-node/node
set +e
PATH="$(pwd)/.pm-hash-node:$PATH" sh scripts/video-spike/failure-tests.sh "$out" > scripts/video-spike/out/pm-after-hash-error.log 2>&1
rc=$?
set -e
[ "$rc" -eq 1 ]
grep -q 'cannot verify inputs/previous result' scripts/video-spike/out/pm-after-hash-error.log
! grep -q 'OVERALL: PASS' scripts/video-spike/out/pm-after-hash-error.log
printf 'POST-RENDER HASH FAILURE: exit=%s, no false PASS\n' "$rc"
rm .pm-hash-node/node
rmdir .pm-hash-node
# Current raw measurement is included in this submission.
sh scripts/video-spike/measure.sh "$out" > scripts/video-spike/out/pm-measure.log 2>&1
ffprobe -v error -show_entries stream=codec_name,width,height -show_entries format=duration -of json "$out/sample.mp4" > scripts/video-spike/out/pm-probe.json
sha256sum "$out/sample.mp4" scripts/video-spike/out/sample.mp4 > scripts/video-spike/out/pm-video-hashes.txt
cat scripts/video-spike/out/pm-probe.json
sh -n scripts/video-spike/failure-tests.sh scripts/video-spike/measure.sh
printf 'ALL REGRESSIONS PASS\n'
