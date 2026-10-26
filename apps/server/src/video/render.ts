import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { frameHtml } from './frame.js';
import { cachedOverlay, type OverlayRenderer } from './overlay.js';
import type { NarrationSegment } from './narration.js';
import { MAX_TOTAL_SEC } from './scenePlan.js';
import type { SubtitleCue } from './subtitles.js';
import type { ZoomPlan } from './zoom.js';

const exec = promisify(execFile);

/**
 * 단일 렌더러(TASK-25): 장면 프레임(배경+캐릭터, TASK-23) · 자막 · 학습 확대(TASK-24) · 내레이션 음성을 FFmpeg 로 세로 MP4 한 개로 합성한다.
 * 출력은 H.264 영상 1개 + AAC 음성 1개뿐이다(배경 음악 트랙 없음). 외부 영상 생성 서비스는 부르지 않는다 — 입력은 모두 이미 만들어진 파일/버퍼다.
 * 임시 파일에 먼저 만들고 검증을 통과한 뒤에만 rename 으로 교체하므로 실패·중단 시 이전 결과가 그대로 남는다.
 */

export const OUT_W = 720;
export const OUT_H = 1280;
export const FPS = 24;
/** 렌더 하나가 쓰는 FFmpeg 스레드 상한(공유 서버: 워커 스레드 상한 고려). */
export const FFMPEG_THREADS = 2;
export const DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
/** 길이 허용 오차(초): 프레임 반올림과 AAC 패딩. */
const DURATION_TOLERANCE_SEC = 1;

export interface RenderScene { sceneKey: string; /** composeFrame 결과 JPEG(720x1280). */ frame: Buffer }
export interface RenderInput {
  scenes: RenderScene[];
  /** scenes 와 같은 순서. startSec·endSec 는 영상 전체 기준. */
  narration: NarrationSegment[];
  subtitles: SubtitleCue[];
  zooms: ZoomPlan[];
  totalSec: number;
}

export type RenderErrorCode = 'BAD_INPUT' | 'DISK_LOW' | 'DISK_FULL' | 'FFMPEG_FAILED' | 'TIMEOUT' | 'INVALID_OUTPUT' | 'OVERLAY_FAILED';
export class RenderError extends Error {
  constructor(readonly code: RenderErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); }
}

export function checkInput(i: RenderInput): void {
  const bad = (d: string) => { throw new RenderError('BAD_INPUT', d); };
  if (!i.scenes.length) bad('장면 없음');
  if (i.scenes.length !== i.narration.length) bad('장면과 내레이션 수가 다름');
  if (!(i.totalSec > 0) || i.totalSec > MAX_TOTAL_SEC) bad(`길이 ${i.totalSec}초는 1~${MAX_TOTAL_SEC}초 밖`);
  let prev = -1;
  i.scenes.forEach((s, k) => {
    const n = i.narration[k]!;
    if (n.sceneKey !== s.sceneKey) bad(`장면 ${s.sceneKey} 와 내레이션 ${n.sceneKey} 순서 불일치`);
    if (!s.frame.length || !n.audio.length) bad(`장면 ${s.sceneKey} 프레임 또는 음성이 비어 있음`);
    if (n.startSec < prev || n.endSec <= n.startSec) bad(`장면 ${s.sceneKey} 시간 구간이 올바르지 않음`);
    prev = n.endSec;
  });
  if (prev > i.totalSec + 0.01) bad('내레이션이 전체 길이를 넘음');
}

interface Timed { startSec: number; endSec: number }
const clampWin = (t: Timed, total: number): Timed | null => {
  const s = Math.max(0, t.startSec), e = Math.min(total, t.endSec);
  return e - s > 0.01 ? { startSec: s, endSec: e } : null;
};

export interface TrackEntry { html: string; startSec: number; endSec: number }

/** 오버레이를 두 줄(자막, 학습 확대)로 나눈다. 한 줄 안에서는 겹치지 않게 시작을 앞 항목의 끝 뒤로 민다. */
export function overlayTracks(i: RenderInput): { subtitle: TrackEntry[]; zoom: TrackEntry[] } {
  const norm = (items: (Timed & { html: string })[]): TrackEntry[] => {
    const out: TrackEntry[] = [];
    let end = 0;
    for (const it of items.sort((x, y) => x.startSec - y.startSec)) {
      const w = clampWin(it, i.totalSec);
      if (!w) continue;
      const startSec = Math.max(w.startSec, end);
      if (w.endSec - startSec <= 0.01) continue;
      out.push({ html: it.html, startSec, endSec: w.endSec });
      end = w.endSec;
    }
    return out;
  };
  return {
    subtitle: norm(i.subtitles.map((c) => ({ ...c, html: frameHtml({ cue: c, transparent: true }) }))),
    zoom: norm(i.zooms.flatMap((z) => z.chunks.map((c) => ({ ...c, html: frameHtml({ zoom: c, transparent: true }) })))),
  };
}

/** 빈 투명 오버레이(항목 사이 빈 구간용). */
export const EMPTY_OVERLAY_HTML = frameHtml({ transparent: true });

/** concat demuxer 목록: 항목 사이 빈 구간은 투명 PNG 로 채우고 전체 길이를 totalSec+1 까지 덮는다. 항목마다 프레임 하나(가변 프레임률)라 디코드 비용이 작다. */
export function concatList(entries: { file: string; startSec: number; endSec: number }[], emptyFile: string, totalSec: number): string {
  const rows: { file: string; dur: number }[] = [];
  let t = 0;
  for (const e of entries) {
    if (e.startSec > t + 0.001) rows.push({ file: emptyFile, dur: e.startSec - t });
    rows.push({ file: e.file, dur: e.endSec - e.startSec });
    t = e.endSec;
  }
  rows.push({ file: emptyFile, dur: Math.max(0.1, totalSec + 1 - t) });
  const q = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  return [...rows.map((r) => `file ${q(r.file)}\nduration ${f3(r.dur)}`), `file ${q(rows[rows.length - 1]!.file)}`].join('\n') + '\n';
}

const f3 = (n: number) => n.toFixed(3);

/** FFmpeg 인자와 filter_complex. 입력 파일 경로는 호출자가 정한다(시험에서 그래프 모양을 직접 검사). */
export function buildFfmpegArgs(o: {
  frames: string[]; audios: string[]; /** concat 목록 파일(자막·확대). */ tracks: string[]; slots: number[]; totalSec: number; out: string;
}): string[] {
  const n = o.frames.length;
  const args = ['-y', '-nostdin', '-v', 'error', '-threads', String(FFMPEG_THREADS), '-filter_threads', '1', '-filter_complex_threads', '1'];
  o.frames.forEach((f, k) => args.push('-loop', '1', '-framerate', String(FPS), '-t', f3(o.slots[k]!), '-i', f));
  o.audios.forEach((a) => args.push('-i', a));
  o.tracks.forEach((t) => args.push('-f', 'concat', '-safe', '0', '-i', t));
  const parts: string[] = [];
  for (let k = 0; k < n; k++) parts.push(`[${k}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${FPS},format=yuv420p[s${k}]`);
  parts.push(`${Array.from({ length: n }, (_, k) => `[s${k}]`).join('')}concat=n=${n}:v=1:a=0,tpad=stop_mode=clone:stop_duration=1[v0]`);
  let last = 'v0';
  o.tracks.forEach((_, k) => {
    parts.push(`[${n + n + k}:v]scale=${OUT_W}:${OUT_H},format=rgba[o${k}]`);
    parts.push(`[${last}][o${k}]overlay=eof_action=pass:format=auto[v${k + 1}]`);
    last = `v${k + 1}`;
  });
  parts.push(`[${last}]format=yuv420p[vout]`);
  for (let k = 0; k < n; k++) parts.push(`[${n + k}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${f3(o.slots[k]!)},atrim=0:${f3(o.slots[k]!)},asetpts=PTS-STARTPTS[a${k}]`);
  parts.push(`${Array.from({ length: n }, (_, k) => `[a${k}]`).join('')}concat=n=${n}:v=0:a=1[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '2500k', '-bufsize', '5000k', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1', '-t', f3(Math.min(o.totalSec, MAX_TOTAL_SEC)), '-movflags', '+faststart', '-f', 'mp4', o.out);
  return args;
}

// ---- 검증 ----

export interface ProbeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string }
export interface Probe { streams: ProbeStream[]; format: { duration?: string } }

export async function probeVideo(file: string, ffprobe = 'ffprobe'): Promise<Probe> {
  const r = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 1 << 22 });
  return JSON.parse(r.stdout) as Probe;
}

export type OutputIssue = 'STREAM_LAYOUT' | 'NOT_H264_AAC' | 'NOT_9_16' | 'OVER_MAX_SEC' | 'DURATION_MISMATCH' | 'NOT_YUV420P';

/** 완성 파일 규칙: 9:16, 180초 이하, 영상 1개+음성 1개(H.264+AAC)만, 기대 길이와 일치. */
export function checkOutput(p: Probe, expectedSec: number): OutputIssue[] {
  const issues: OutputIssue[] = [];
  const v = p.streams.filter((s) => s.codec_type === 'video'), a = p.streams.filter((s) => s.codec_type === 'audio');
  if (v.length !== 1 || a.length !== 1 || p.streams.length !== 2) issues.push('STREAM_LAYOUT');
  if (v[0] && a[0] && (v[0].codec_name !== 'h264' || a[0].codec_name !== 'aac')) issues.push('NOT_H264_AAC');
  if (v[0] && (!v[0].width || !v[0].height || v[0].width * 16 !== v[0].height * 9)) issues.push('NOT_9_16');
  if (v[0] && v[0].pix_fmt !== 'yuv420p') issues.push('NOT_YUV420P');
  const d = Number(p.format.duration);
  if (!(d > 0) || d > MAX_TOTAL_SEC) issues.push('OVER_MAX_SEC');
  else if (Math.abs(d - expectedSec) > DURATION_TOLERANCE_SEC) issues.push('DURATION_MISMATCH');
  return issues;
}

// ---- 실행 ----

interface RunResult { code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }

/** FFmpeg 를 sh 를 거쳐 실행해 파일 크기 상한(ulimit -f)을 건다. 상한을 넘으면 SIGXFSZ 를 무시해 쓰기 오류로 끝나게 한다. */
function runFfmpeg(ffmpeg: string, args: string[], o: { fileSizeLimitKb?: number; timeoutMs: number }): Promise<RunResult> {
  const sh = `${o.fileSizeLimitKb ? `trap '' XFSZ; ulimit -f ${Math.floor(o.fileSizeLimitKb)}; ` : ''}exec "$0" "$@"`;
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', sh, ffmpeg, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', timedOut = false;
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr, timedOut }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, signal: null, stderr: 'spawn error', timedOut }); });
  });
}

export interface RenderDeps {
  overlay: OverlayRenderer;
  /** 오버레이 PNG 캐시와 렌더 임시 파일 위치. 기본은 출력 폴더 옆 .render-work. */
  workDir?: string;
  ffmpeg?: string;
  ffprobe?: string;
  minFreeBytes?: number;
  /** 시험·운영 한도: 출력 파일 크기 상한(KB). */
  fileSizeLimitKb?: number;
  timeoutMs?: number;
  /** 시험에서 남은 디스크 용량을 흉내 낸다. */
  freeBytes?: (dir: string) => Promise<number>;
}

export interface RenderOutcome { file: string; sha256: string; bytes: number; durationSec: number; overlays: number; overlaysReused: number }

const defaultFree = async (dir: string) => { const s = await statfs(dir); return s.bavail * s.bsize; };

/**
 * 렌더 한 번. outFile 은 검증을 통과했을 때만 새 내용으로 바뀐다.
 * 실패하면 RenderError 를 던지고 outFile 과 입력(RenderInput 이 가리키는 기록)은 건드리지 않는다. 동시 실행 제한은 RenderGate 가 맡는다.
 */
export async function renderVideo(deps: RenderDeps, input: RenderInput, outFile: string): Promise<RenderOutcome> {
  checkInput(input);
  const ffmpeg = deps.ffmpeg ?? 'ffmpeg';
  const outDir = path.dirname(outFile);
  await mkdir(outDir, { recursive: true });
  // 이전 중단이 남긴 임시 파일 정리(렌더러는 하나뿐이라 남의 진행 중 파일이 아니다).
  for (const f of await readdir(outDir)) if (/^\..*\.part\.mp4$/.test(f)) await rm(path.join(outDir, f), { force: true });
  const free = await (deps.freeBytes ?? defaultFree)(outDir);
  if (free < (deps.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES)) throw new RenderError('DISK_LOW', `여유 ${Math.floor(free / 1048576)}MB`);

  const work = deps.workDir ?? path.join(outDir, '.render-work');
  await mkdir(work, { recursive: true });
  const run = await mkdtemp(path.join(work, 'run-'));
  const tmp = path.join(outDir, `.${path.basename(outFile)}.${process.pid}.${Math.random().toString(36).slice(2)}.part.mp4`);
  try {
    const frames: string[] = [], audios: string[] = [];
    for (const [k, s] of input.scenes.entries()) {
      const f = path.join(run, `frame-${k}.jpg`); await writeFile(f, s.frame); frames.push(f);
      const n = input.narration[k]!;
      const a = path.join(run, `nar-${k}.${n.mime.includes('wav') ? 'wav' : n.mime.includes('mpeg') || n.mime.includes('mp3') ? 'mp3' : 'bin'}`);
      await writeFile(a, n.audio); audios.push(a);
    }
    const starts = input.narration.map((n, k) => (k === 0 ? 0 : n.startSec));
    const slots = starts.map((s, k) => (k < starts.length - 1 ? starts[k + 1]! : input.totalSec) - s);
    let reused = 0, count = 0;
    const draw = async (html: string) => {
      try {
        const o = await cachedOverlay(path.join(work, 'overlays'), deps.overlay, html);
        if (o.reused) reused++;
        count++;
        return o.file;
      } catch (e) { throw new RenderError('OVERLAY_FAILED', e instanceof Error ? e.name : 'ERROR'); }
    };
    const emptyFile = await draw(EMPTY_OVERLAY_HTML);
    const tracks: string[] = [];
    for (const [k, track] of Object.values(overlayTracks(input)).entries()) {
      const entries: { file: string; startSec: number; endSec: number }[] = [];
      for (const it of track) entries.push({ file: await draw(it.html), startSec: it.startSec, endSec: it.endSec });
      const list = path.join(run, `track-${k}.txt`);
      await writeFile(list, concatList(entries, emptyFile, input.totalSec));
      tracks.push(list);
    }

    const args = buildFfmpegArgs({ frames, audios, tracks, slots, totalSec: input.totalSec, out: tmp });
    const r = await runFfmpeg(ffmpeg, args, { fileSizeLimitKb: deps.fileSizeLimitKb, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (r.timedOut) throw new RenderError('TIMEOUT');
    // FFmpeg 는 쓰기 오류(디스크 부족·크기 상한)에도 종료 코드 0 을 줄 수 있어 오류 출력이 있으면 실패로 본다(-v error).
    if (r.code !== 0 || r.stderr.trim()) {
      if (/No space left|File size limit|File too large|Disk quota/i.test(r.stderr) || r.signal === 'SIGXFSZ') throw new RenderError('DISK_FULL');
      throw new RenderError('FFMPEG_FAILED', r.signal ?? (r.code !== 0 ? `exit ${r.code}` : 'STDERR'));
    }
    // 검증: 메타데이터 + 끝까지 디코드. 통과해야만 교체한다.
    let probe: Probe;
    try { probe = await probeVideo(tmp, deps.ffprobe); } catch { throw new RenderError('INVALID_OUTPUT', 'PROBE_FAILED'); }
    const issues = checkOutput(probe, input.totalSec);
    if (issues.length) throw new RenderError('INVALID_OUTPUT', issues.join(','));
    const dec = await runFfmpeg(ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-i', tmp, '-f', 'null', '-'], { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (dec.code !== 0 || dec.stderr.trim()) throw new RenderError('INVALID_OUTPUT', 'DECODE_ERRORS');
    const fh = await open(tmp, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, outFile);
    const bytes = await readFile(outFile);
    return { file: outFile, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, durationSec: Number(probe.format.duration), overlays: count, overlaysReused: reused };
  } finally {
    await rm(tmp, { force: true });
    await rm(run, { recursive: true, force: true });
  }
}

export const defaultWorkDir = () => path.join(os.tmpdir(), 'daily-log-render');
