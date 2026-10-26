import type { QualityInput } from './quality.js';
export const input = (): QualityInput => ({
  file: 'result.mp4', sha256: 'a'.repeat(64), scriptVersion: 2,
  probe: { streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '5' } },
  expectedSec: 5, rules: [], excludedTexts: [],
  scenes: [{ key: 's1', script: '인증 보안을 배웠다.', visual: '책상에서 학습하는 캐릭터', transcript: '인증 보안을 배웠다.', subtitles: ['인증 보안을 배웠다.'], zooms: ['인증 보안'], versions: { image: 2, voice: 2, subtitles: 2, zoom: 2 },
    facts: { passed: true, evidence: 'briefing:item1' }, image: { passed: true, evidence: 'frame:sha256' }, learning: { passed: true, evidence: 'source:item1' }, readability: { passed: true, evidence: 'layout:checked' } }],
});

