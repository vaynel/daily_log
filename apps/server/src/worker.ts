import { loadConfigOrExit } from './config.js';
import { MonthlyLedger } from './budget/ledger.js';
import { createPool } from './db/pool.js';
import { JobQueue } from './jobs/queue.js';
import { NotificationService } from './notify/service.js';
import { loadAuthConfig } from './auth/config.js';
import { OidcClient } from './auth/oidc.js';
import { PgDriveConnections } from './backup/connections.js';
import { createDriveFactory } from './backup/drive.js';
import { BACKUP_KIND, BackupService } from './backup/service.js';
import { TokenVault } from './backup/vault.js';
import { RetentionService } from './retention/service.js';
import { UnconfiguredSender, WebPushSender, loadVapidKeys } from './notify/sender.js';

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
let stopping = false;

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

// 단계 처리기(kind → stage → handler)는 후속 Task 가 등록한다. 큐는 재시작 복구·대기 재개·1회 자동 재시도를 맡는다.
// Drive 백업 단계(preflight → copy → finalize). Google 설정이 없으면 Drive 호출은 DRIVE_NOT_CONNECTED 로 권한 대기한다.
const connections = new PgDriveConnections(pool, new TokenVault(process.env.DRIVE_TOKEN_KEY?.trim() || config.sessionSecret));
const authCfg = loadAuthConfig();
const driveFor = createDriveFactory({ connections, oidc: authCfg ? new OidcClient(authCfg) : null });
const handlers: ConstructorParameters<typeof JobQueue>[0]['handlers'] = {};
const queue: JobQueue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers, permissionRestored: (job) => backup.permissionRestored(job) });
const backup: BackupService = new BackupService({ pool, queue, fileStorageDir: config.fileStorageDir, drive: driveFor, connections });
handlers[BACKUP_KIND] = backup.handlers();
const sweepEveryMs = Number(process.env.BACKUP_SWEEP_INTERVAL_MS ?? '3600000');
let lastSweep = 0;
// 수명 훑기(음성 삭제·휴지통 만료·한 달 서버 사본 정리·파일 삭제 재시도). Drive 에는 읽기 확인만 하고 삭제 요청은 없다.
const retention = new RetentionService({ pool, fileStorageDir: config.fileStorageDir, backup });
const retentionEveryMs = Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? '900000');
let lastRetention = 0;

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
  if (Date.now() - lastSweep >= sweepEveryMs) { // 변경이 없으면 작업을 만들지 않는 멱등 훑기: 하루에 여러 번 돌아도 중복 복사가 없다.
    lastSweep = Date.now();
    await backup.sweep().catch((e) => console.error('backup sweep error:', e instanceof Error ? e.name : 'ERROR'));
  }
  if (Date.now() - lastRetention >= retentionEveryMs) {
    lastRetention = Date.now();
    const r = await retention.sweepAll();
    console.log('retention sweep', JSON.stringify(r));
  }
  await notifier.run(); // 알림 단계는 내부에서 오류를 격리한다(작업 큐와 독립)
  await new Promise((r) => setTimeout(r, config.workerPollIntervalMs));
}
await pool.end();
console.log('worker stopped');
