// 수동 표본: 모의 배경(그라디언트)+기준 시트 캐릭터+사인파 음성으로 실제 Chromium 오버레이를 거쳐 세로 MP4 를 만든다. 실제 사용자 하루·최종 음성이 아니다.
// 사용: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx tsx src/video/renderSample.ts <출력.mp4>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromiumOverlay } from './overlay.js';
import { renderVideo } from './render.js';
import { composeFrame } from './sceneAssets.js';
import { mockInput, mockWav, tmpDir } from './render.testutil.js';

const out = process.argv[2];
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!out || !exe) throw new Error('사용법: <출력.mp4> 와 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 필요');
const d = tmpDir();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=720x1280:c0=0xe8f1e4:c1=0xf3e9d2:d=1:r=1', '-frames:v', '1', path.join(d, 'bg.jpg')]);
const sheet = readFileSync(path.resolve(import.meta.dirname, '../../../../assets/character/A-ref-v1.jpg'));
const frame = await composeFrame(readFileSync(path.join(d, 'bg.jpg')), sheet);
const input = mockInput([5, 7, 5]);
input.scenes.forEach((s) => { s.frame = frame; });
input.narration.forEach((n) => { n.audio = mockWav(n.durationSec); });
const ov = await chromiumOverlay(exe);
try {
  console.log(JSON.stringify(await renderVideo({ overlay: ov.render, workDir: path.join(d, 'work') }, input, out)));
} finally { await ov.close(); }
