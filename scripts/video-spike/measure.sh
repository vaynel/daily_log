#!/bin/sh
# Records environment + one timed render. usage: sh scripts/video-spike/measure.sh OUTDIR
set -e
OUT=${1:-scripts/video-spike/out}
{
echo "date_utc=$(date -u +%FT%TZ)"
echo "cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2)"
echo "cgroup_cpu_max=$(cat /sys/fs/cgroup/cpu.max) cgroup_memory_max=$(cat /sys/fs/cgroup/memory.max)"
echo "ffmpeg=$(ffmpeg -version | head -1)"
echo "loadavg_before=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "cgroup_memory_peak_before=$(cat /sys/fs/cgroup/memory.peak)"
echo "du_assets_bytes=$(du -sb $OUT/assets | cut -f1)"
node scripts/video-spike/render.mjs render --out "$OUT"
echo "cgroup_memory_peak_after=$(cat /sys/fs/cgroup/memory.peak)"
echo "cgroup_memory_events=$(tr '\n' ' ' </sys/fs/cgroup/memory.events)"
echo "loadavg_after=$(cut -d' ' -f1-3 /proc/loadavg)"
} 2>&1 | tee "$OUT/measure-$(date -u +%H%M%S).log"
