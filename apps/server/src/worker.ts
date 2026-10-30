import { loadConfigOrExit } from './config.js';
import { MonthlyLedger } from './budget/ledger.js';
import { createPool } from './db/pool.js';
import { JobQueue } from './jobs/queue.js';
import { VIDEO_JOB_KIND } from './briefing/briefing.js';
import { buildVideoRuntime } from './video/pipelineRuntime.js';
import { NotificationService } from './notify/service.js';
import { UnconfiguredSender, WebPushSender, loadVapidKeys } from './notify/sender.js';

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
let stopping = false;

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

// 단계 처리기(kind → stage → handler). 큐는 재시작 복구·대기 재개·1회 자동 재시도를 맡고, 제작 단계는 video/pipeline.ts 가 채운다.
const ledger = new MonthlyLedger(pool);
const video = await buildVideoRuntime({ config, pool, ledger });
const queue = new JobQueue({ pool, ledger, handlers: { [VIDEO_JOB_KIND]: video.handlers }, onStopped: video.onStopped });

const notifier = new NotificationService({ pool, sender: config.vapidKeysFile ? new WebPushSender(loadVapidKeys(config.vapidKeysFile)) : new UnconfiguredSender() });

console.log('worker started');
console.log(`recovered ${await queue.recover()} interrupted job(s)`);
while (!stopping) {
  try {
    await queue.wakeWaiting();
    while (!stopping && (await queue.tick())) { /* 대기열이 빌 때까지 */ }
  } catch (e) {
    console.error('worker loop error:', e instanceof Error ? e.name : 'ERROR'); // 본문·키는 기록하지 않음
  }
  await notifier.run(); // 알림 단계는 내부에서 오류를 격리한다(작업 큐와 독립)
  await new Promise((r) => setTimeout(r, config.workerPollIntervalMs));
}
await video.close();
await pool.end();
console.log('worker stopped');
