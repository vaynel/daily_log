import { loadConfigOrExit } from './config.js';
import { MonthlyLedger } from './budget/ledger.js';
import { createPool } from './db/pool.js';
import { JobQueue } from './jobs/queue.js';
import path from 'node:path';
import { createProInfer, loadSiwcRuntime } from './briefing/pro.js';
import { PgRuleStore } from './briefing/rules.js';
import { RecordStore } from './records/store.js';
import { loadPricing } from './voice/pricing.js';
import { readKeyFile } from './voice/keys.js';
import { openaiStt } from './voice/transports.js';
import { AssetStore } from './video/assetStore.js';
import { geminiNarrationTts, loadVoiceConfig } from './video/narration.js';
import { chromiumOverlay } from './video/overlay.js';
import { RenderGate } from './video/renderGate.js';
import { geminiImage } from './video/sceneAssets.js';
import { syncPipelineState, videoHandlers } from './video/pipeline.js';
import { NonRetryableError } from './jobs/queue.js';
import { NotificationService } from './notify/service.js';
import { UnconfiguredSender, WebPushSender, loadVapidKeys } from './notify/sender.js';

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
let stopping = false;

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

// 영상 제작 단계 처리기(kind → stage → handler). 키·Pro·브라우저 설정이 빠지면 해당 제공자는 null 이 되고, 작업은 유료 호출 전에
// VIDEO_PROVIDERS_UNAVAILABLE 로 멈춘다(설정 후 수동 재시도). 큐는 재시작 복구·대기 재개·1회 자동 재시도를 맡는다.
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const assetsDir = process.env.DAILY_LOG_ASSETS_DIR?.trim() || path.join(repoRoot, 'assets');
const gemini = readKeyFile('DAILY_LOG_GEMINI_KEY_FILE', process.env.DAILY_LOG_GEMINI_KEY_FILE);
const openai = readKeyFile('DAILY_LOG_OPENAI_KEY_FILE', process.env.DAILY_LOG_OPENAI_KEY_FILE);
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const overlay = chromiumPath ? await chromiumOverlay(chromiumPath) : null;
const ledger = new MonthlyLedger(pool);
const leaseMs = 60_000;
const queue = new JobQueue({
  pool, ledger, leaseMs,
  handlers: videoHandlers({
    pool, ledger, records: new RecordStore(pool), rules: new PgRuleStore(pool),
    infer: await createProInfer(process.env, loadSiwcRuntime),
    voice: loadVoiceConfig(path.join(assetsDir, 'voice/voice.json')),
    pricing: loadPricing(),
    tts: 'key' in gemini ? geminiNarrationTts(gemini.key) : async () => { throw new NonRetryableError('VIDEO_PROVIDERS_UNAVAILABLE'); },
    stt: 'key' in openai ? openaiStt(openai.key) : null,
    image: 'key' in gemini ? geminiImage(gemini.key) : null,
    assets: new AssetStore(path.join(config.fileStorageDir, 'video-assets')),
    referenceSheetPath: path.join(assetsDir, 'character/A-ref-v1.jpg'),
    attachmentsDir: path.join(config.fileStorageDir, 'attachments'),
    videoDir: path.join(config.fileStorageDir, 'videos'),
    workDir: path.join(config.fileStorageDir, 'video-work'),
    gate: new RenderGate(pool),
    render: { overlay: overlay?.render ?? (async () => { throw new Error('OVERLAY_UNAVAILABLE'); }), workDir: path.join(config.fileStorageDir, 'video-work/render') },
    heartbeatMs: leaseMs / 3,
  }),
});

const notifier = new NotificationService({ pool, sender: config.vapidKeysFile ? new WebPushSender(loadVapidKeys(config.vapidKeysFile)) : new UnconfiguredSender() });

console.log('worker started');
console.log(`recovered ${await queue.recover()} interrupted job(s)`);
while (!stopping) {
  try {
    await queue.wakeWaiting();
    for (let job; !stopping && (job = await queue.tick()); ) await syncPipelineState(pool, job); // 대기열이 빌 때까지
  } catch (e) {
    console.error('worker loop error:', e instanceof Error ? e.name : 'ERROR'); // 본문·키는 기록하지 않음
  }
  await notifier.run(); // 알림 단계는 내부에서 오류를 격리한다(작업 큐와 독립)
  await new Promise((r) => setTimeout(r, config.workerPollIntervalMs));
}
await overlay?.close();
await pool.end();
console.log('worker stopped');
