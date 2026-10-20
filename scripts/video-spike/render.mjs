// TASK-5 spike: synthetic 9:16 sample composed with FFmpeg only (no AI video API).
// usage: node scripts/video-spike/render.mjs <prepare|render|probe> [--out DIR] [--fontfile PATH] [--ulimit-kb N] [--kill-after S]
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(opt('out', join(here, 'out')));
const FONT = opt('fontfile', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc');
const W = 720, H = 1280, FPS = 24;
const spec = JSON.parse(readFileSync(join(here, 'scenes.json'), 'utf8'));
const SEC = spec.sceneSeconds, N = spec.scenes.length, TOTAL = SEC * N;
const assets = join(OUT, 'assets');

const run = (c, a, o = {}) => {
  const r = spawnSync(c, a, { encoding: 'utf8', ...o });
  if (r.status !== 0) throw new Error(`${c} failed (${r.status}): ${(r.stderr || '').slice(-400)}`);
  return r;
};
const dur = (f) => parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
// wrap Korean text at n chars (no AI, plain splitting on spaces)
const wrap = (s, n) => { const out = []; let l = ''; for (const w of s.split(' ')) { if ((l + ' ' + w).trim().length > n) { out.push(l); l = w; } else l = (l + ' ' + w).trim(); } if (l) out.push(l); return out.join('\n'); };

function prepare() {
  mkdirSync(assets, { recursive: true });
  // fixed character (same outfit all scenes): two mouth states, drawn with drawbox only
  const body = 'drawbox=60:230:200:200:0x2d5fa8:fill,drawbox=60:230:200:30:0xf2c14e:fill,drawbox=90:430:50:50:0x333333:fill,drawbox=180:430:50:50:0x333333:fill,drawbox=60:60:200:170:0xf5d0a9:fill,drawbox=60:40:200:40:0x3b2a20:fill,drawbox=100:120:30:30:0x111111:fill,drawbox=190:120:30:30:0x111111:fill';
  for (const [name, mouth] of [['closed', 'drawbox=130:190:60:8:0x7a2a2a:fill'], ['open', 'drawbox=140:185:40:28:0x7a2a2a:fill']])
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x490', '-vf', `${body},${mouth},colorkey=0x00ff00:0.01:0,format=rgba`, '-frames:v', '1', join(assets, `char_${name}.png`)]);
  // painted-style backgrounds (flat colour bands) per scene
  const pal = ['0xe8f1e4', '0xf3e9d2', '0xdce9f5', '0xf5dfe0'];
  spec.scenes.forEach((s, i) => {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${pal[i % 4]}:s=${W}x${H}`, '-vf', 'drawbox=0:900:720:380:0xb5a58a:fill,drawbox=0:880:720:20:0x8c7b60:fill', '-frames:v', '1', join(assets, `bg_${i}.png`)]);
    writeFileSync(join(assets, `cap_${i}.txt`), wrap(s.narration, 16));
    writeFileSync(join(assets, `key_${i}.txt`), wrap(s.key, 11));
    // test-only narration via espeak-ng (NOT the final voice selection)
    run('espeak-ng', ['-v', 'ko', '-s', '150', '-w', join(assets, `nar_${i}.wav`), s.narration]);
  });
  const nd = spec.scenes.map((_, i) => dur(join(assets, `nar_${i}.wav`)));
  writeFileSync(join(assets, 'durations.json'), JSON.stringify(nd));
  // narration track: each clip padded/trimmed to its scene slot
  const inputs = nd.flatMap((_, i) => ['-i', join(assets, `nar_${i}.wav`)]);
  const fc = nd.map((_, i) => `[${i}:a]aresample=44100,apad=whole_dur=${SEC},atrim=0:${SEC}[a${i}]`).join(';') + ';' + nd.map((_, i) => `[a${i}]`).join('') + `concat=n=${N}:v=0:a=1[o]`;
  run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', fc, '-map', '[o]', '-ac', '1', join(assets, 'narration.wav')]);
  console.log(JSON.stringify({ narrationSeconds: dur(join(assets, 'narration.wav')), clipSeconds: nd }));
}

function filterGraph() {
  const nd = JSON.parse(readFileSync(join(assets, 'durations.json'), 'utf8'));
  const f = FONT.replace(/:/g, '\\:');
  const mouthOn = nd.map((d, i) => `between(t,${i * SEC},${(i * SEC + Math.min(d, SEC)).toFixed(2)})`).join('+');
  // inputs: 0..N-1 backgrounds (loop, 1 per scene), N closed, N+1 open, N+2 narration
  const parts = [];
  // backgrounds -> concat, slow zoom-like drift via crop offset is skipped (CPU); scene change per 15s
  for (let i = 0; i < N; i++) parts.push(`[${i}:v]scale=${W}:${H},setsar=1,trim=duration=${SEC},setpts=PTS-STARTPTS,fps=${FPS}[b${i}]`);
  parts.push(parts.length ? Array.from({ length: N }, (_, i) => `[b${i}]`).join('') + `concat=n=${N}:v=1:a=0[bg]` : '');
  const cx = `(${W}-320)/2+20*sin(t*1.5)`, cy = `520+8*sin(t*6)`; // sway + bounce motion
  parts.push(`[bg][${N}:v]overlay=x='${cx}':y='${cy}':enable='1-(${mouthOn})*lt(mod(t,0.4),0.2)'[v1]`);
  parts.push(`[v1][${N + 1}:v]overlay=x='${cx}':y='${cy}':enable='(${mouthOn})*lt(mod(t,0.4),0.2)'[v2]`);
  let last = 'v2';
  for (let i = 0; i < N; i++) {
    const en = `between(t,${i * SEC},${(i + 1) * SEC})`;
    // key learning sentence: large, upper area, box behind; fades in over 0.5s
    parts.push(`[${last}]drawtext=fontfile='${f}':textfile='${join(assets, `key_${i}.txt`)}':fontsize=64:fontcolor=white:box=1:boxcolor=0x1d3557@0.92:boxborderw=24:line_spacing=14:x=(w-text_w)/2:y=150:enable='${en}':alpha='min(1,(t-${i * SEC})/0.5)'[k${i}]`);
    // full caption: bottom
    parts.push(`[k${i}]drawtext=fontfile='${f}':textfile='${join(assets, `cap_${i}.txt`)}':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=14:line_spacing=10:x=(w-text_w)/2:y=1060:enable='${en}'[c${i}]`);
    last = `c${i}`;
  }
  parts.push(`[${last}]format=yuv420p[vout]`);
  return parts.join(';');
}

// ffmpeg drawtext exits 0 with a bad fontfile (observed), so fail before rendering and keep the previous result.
function preflightFont() {
  const q = existsSync(FONT) ? spawnSync('fc-query', ['-f', '%{charset}', FONT], { encoding: 'utf8' }) : null;
  if (!q || q.status !== 0 || !/\bac00-d7a3\b|\bac00\b/.test(q.stdout)) {
    console.error(JSON.stringify({ exit: 3, published: false, error: 'FONT_MISSING_OR_NO_HANGUL', fontfile: FONT }));
    process.exit(3);
  }
}

function render() {
  if (!existsSync(join(assets, 'narration.wav'))) throw new Error('run prepare first');
  preflightFont();
  mkdirSync(OUT, { recursive: true });
  const tmpDir = join(OUT, '.tmp-render');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir);
  const tmpFile = join(tmpDir, 'sample.mp4');
  const final = join(OUT, 'sample.mp4');
  const fg = filterGraph();
  writeFileSync(join(tmpDir, 'filter.txt'), fg);
  const ff = ['-y', '-nostdin', '-v', 'error', '-threads', '2', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...Array.from({ length: N }, (_, i) => ['-loop', '1', '-framerate', String(FPS), '-t', String(SEC), '-i', join(assets, `bg_${i}.png`)]).flat(),
    '-loop', '1', '-framerate', String(FPS), '-t', String(TOTAL), '-i', join(assets, 'char_closed.png'),
    '-loop', '1', '-framerate', String(FPS), '-t', String(TOTAL), '-i', join(assets, 'char_open.png'),
    '-i', join(assets, 'narration.wav'),
    '-filter_complex_script', join(tmpDir, 'filter.txt'), '-map', '[vout]', '-map', `${N + 2}:a`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-r', String(FPS), '-c:a', 'aac', '-b:a', '64k', '-t', String(TOTAL),
    '-movflags', '+faststart', tmpFile];
  const ul = opt('ulimit-kb');
  const sh = `${ul ? `trap '' XFSZ; ulimit -f ${ul};` : ''} exec /usr/bin/time -v ffmpeg "$@"`;
  const t0 = Date.now();
  const before = existsSync(final) ? sha(final) : null;
  const child = spawn('sh', ['-c', sh, 'sh', ...ff], { stdio: ['ignore', 'inherit', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const ka = opt('kill-after');
  if (ka) setTimeout(() => spawnSync('pkill', ['-KILL', '-f', `ffmpeg -y -nostdin .*${OUT}`]), parseFloat(ka) * 1000);
  child.on('close', (code, sig) => {
    const wall = (Date.now() - t0) / 1000;
    const m = /Maximum resident set size \(kbytes\): (\d+)/.exec(err);
    const u = /User time \(seconds\): ([\d.]+)/.exec(err), s = /System time \(seconds\): ([\d.]+)/.exec(err);
    const tmpBytes = readdirSync(tmpDir).reduce((a, f) => a + statSync(join(tmpDir, f)).size, 0);
    const res = { exit: code, signal: sig, wallSeconds: wall, maxRssKB: m ? +m[1] : null, userSec: u ? +u[1] : null, sysSec: s ? +s[1] : null, tmpDirBytesAtEnd: tmpBytes, ffmpegStderrTail: err.split('\n').filter((l) => !/^\s+(Command|Exit|Page|Major|Minor|Volun|Invol|Swaps|File|Socket|Signals|Average|Percent|Elapsed|User|System|Maximum)/.test(l)).join('\n').slice(-300) };
    if (code === 0 && existsSync(tmpFile)) { renameSync(tmpFile, final); res.published = true; res.sha256 = sha(final); }
    else { res.published = false; res.previousResultSha256Before = before; res.previousResultSha256After = existsSync(final) ? sha(final) : null; }
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(JSON.stringify(res, null, 1));
    process.exit(code === 0 ? 0 : 1);
  });
}

function probe() {
  const f = join(OUT, 'sample.mp4');
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).stdout);
  const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  const vol = spawnSync('ffmpeg', ['-nostdin', '-i', f, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  console.log(JSON.stringify({ width: v.width, height: v.height, ratio: v.width / v.height, nineSixteen: v.width * 16 === v.height * 9, fps: v.r_frame_rate, vcodec: v.codec_name, acodec: a?.codec_name, durationSec: +j.format.duration, le180: +j.format.duration <= 180, bytes: +j.format.size, meanVolume: /mean_volume: (\S+)/.exec(vol)?.[1], maxVolume: /max_volume: (\S+)/.exec(vol)?.[1], sha256: sha(f) }, null, 1));
}

const fn = { prepare, render, probe }[cmd];
if (!fn) { console.error('usage: prepare|render|probe'); process.exit(2); }
fn();
