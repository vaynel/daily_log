// 브라우저 E2E 전용 서버: 모의 transport만 사용한다(키·네트워크 없음). tsx 로 실행.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceApp } from './app.js';
import { mockTransports } from './mock.testutil.js';

const scenario = process.env.VOICE_E2E_SCENARIO ?? 'normal';
const { t, calls } = mockTransports({ sttText: scenario === 'stt-empty' ? '' : undefined, delayMs: 40 });
const app = buildVoiceApp({
  transports: t,
  sessionDir: mkdtempSync(path.join(os.tmpdir(), 'dl-voice-e2e-')),
  budgetKrw: Number(process.env.VOICE_E2E_BUDGET ?? 1000),
  logger: false,
});
app.get('/e2e/calls', async () => calls);
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
console.log('E2E_READY');
