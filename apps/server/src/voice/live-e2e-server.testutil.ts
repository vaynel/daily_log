// 브라우저 E2E 전용: 모의 Live 서버 + /voice-live (키·네트워크 없음). tsx 로 실행.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceApp } from './app.js';
import { loadLiveConfig } from './live.js';
import { mockTransports } from './mock.testutil.js';
import { startMockLive } from './live-mock.testutil.js';

const KEY = 'e2e-sentinel-key-not-real-0001';
const scenario = process.env.LIVE_E2E_SCENARIO ?? 'normal';
const mock = await startMockLive({ expectedKey: KEY, vadSilenceMs: 250, firstAudioDelayMs: 60, audioChunks: 4 });
const config = loadLiveConfig(scenario === 'bad-key' ? 'wrong-key' : KEY, {
  DAILY_LOG_VOICE_LIVE_URL: mock.url,
  DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS: '2000',
  DAILY_LOG_VOICE_LIVE_COMPRESSION_TARGET_TOKENS: '1200',
});
const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'dl-live-e2e-'));
const app = buildVoiceApp({
  transports: mockTransports().t, sessionDir, budgetKrw: Number(process.env.LIVE_E2E_BUDGET ?? 1000), logger: false,
  live: scenario === 'disabled' ? null : config,
});
app.get('/e2e/mock', async () => mock.state);
app.get('/e2e/session-dir', async () => ({ sessionDir, key: KEY }));
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
console.log('E2E_READY');
