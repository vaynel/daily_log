import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NarrationSegment } from './narration.js';
import type { OverlayRenderer } from './overlay.js';
import type { RenderInput } from './render.js';
import { buildSubtitles } from './subtitles.js';
import { planZoom } from './zoom.js';
import type { Scene } from './scenePlan.js';

/** 시험용 모의 자산(실제 이미지·음성 생성 없음): lavfi 로 만든 단색 JPEG 프레임, 사인파 WAV, 반투명 PNG 오버레이. */
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });

export function tmpDir(prefix = 'render-test-') { return mkdtempSync(path.join(os.tmpdir(), prefix)); }
export const rm = (d: string) => rmSync(d, { recursive: true, force: true });

export function mockFrame(color = 'steelblue'): Buffer {
  const d = tmpDir();
  try { ff(['-f', 'lavfi', '-i', `color=c=${color}:s=720x1280`, '-frames:v', '1', path.join(d, 'f.jpg')]); return readFileSync(path.join(d, 'f.jpg')); } finally { rm(d); }
}
export function mockWav(sec: number, hz = 440): Buffer {
  const d = tmpDir();
  try { ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=24000:duration=${sec}`, '-ac', '1', path.join(d, 'a.wav')]); return readFileSync(path.join(d, 'a.wav')); } finally { rm(d); }
}

let pngCache: Buffer | null = null;
let emptyCache: Buffer | null = null;
function emptyPng(): Buffer {
  if (!emptyCache) {
    const d = tmpDir();
    try { ff(['-f', 'lavfi', '-i', 'color=c=0x00000000:s=720x1280,format=rgba', '-frames:v', '1', path.join(d, 'e.png')]); emptyCache = readFileSync(path.join(d, 'e.png')); } finally { rm(d); }
  }
  return emptyCache;
}
export const mockOverlay = (calls?: { n: number }): OverlayRenderer => async (html) => {
  if (calls) calls.n++;
  if (!html.includes('id="sub"') && !html.includes('id="zoom"')) return emptyPng();
  if (!pngCache) {
    const d = tmpDir();
    try { ff(['-f', 'lavfi', '-i', 'color=c=0xff000080:s=720x1280,format=rgba', '-frames:v', '1', path.join(d, 'o.png')]); pngCache = readFileSync(path.join(d, 'o.png')); } finally { rm(d); }
  }
  return pngCache;
};

const scene = (n: number, type: Scene['type'], narration: string): Scene => ({ key: `sc${n}`, order: n, type, narration, visual: 'v', evidenceIds: ['e1'], photoId: null, timeStatus: 'NONE', estimated: false, emphasis: false, estimatedSec: 5 });

/** 장면 durations(초) 목록으로 합성 입력을 만든다. 두 번째 장면은 학습(확대 화면 포함). */
export function mockInput(durations: number[]): RenderInput {
  const scenes: Scene[] = durations.map((_, k) => scene(k + 1, k === 1 ? 'LEARNING' : 'DAILY', k === 1 ? '오늘은 에코 버그를 고쳤다. 값을 따로 넘기면 안전하다.' : '아침에 일어나 천천히 걸었다. 날씨가 맑았다.'));
  let cursor = 0;
  const narration: NarrationSegment[] = scenes.map((s, k) => {
    const seg: NarrationSegment = { sceneKey: s.key, voiceName: 'Achird', mime: 'audio/wav', audio: mockWav(durations[k]!, 300 + k * 100), durationSec: durations[k]!, startSec: cursor, endSec: cursor + durations[k]!, entryId: `e${k}` };
    cursor += durations[k]! + 0.5;
    return seg;
  });
  const totalSec = Math.round((cursor - 0.5) * 100) / 100;
  const code = 'const a = 1;\nreturn a;';
  const subtitles = scenes.flatMap((s, k) => buildSubtitles(s, narration[k]!, s.type === 'LEARNING' ? code : null));
  const z = planZoom({ sceneKey: 'sc2', kind: 'CODE', original: code }, narration[1] ?? { startSec: 0, endSec: 6 });
  return { scenes: scenes.map((s, k) => ({ sceneKey: s.key, frame: mockFrame(['steelblue', 'seagreen', 'tomato'][k % 3]) })), narration, subtitles, zooms: z.ok && durations.length > 1 ? [z.plan] : [], totalSec };
}
