import path from 'node:path';
import { buildApp } from './app.js';
import { loadAuthConfig } from './auth/config.js';
import { MonthlyLedger } from './budget/ledger.js';
import { loadConfigOrExit } from './config.js';
import { createPool } from './db/pool.js';
import { PgRuleStore } from './briefing/rules.js';
import { PgLiveUsageStore } from './interview/usage.js';
import { createProInfer, loadSiwcRuntime } from './briefing/pro.js';
import { RecordStore } from './records/store.js';
import { readKeyFile } from './voice/keys.js';
import { loadLiveConfig, type LiveConfig } from './voice/live.js';
import { NotificationService } from './notify/service.js';
import { OidcClient } from './auth/oidc.js';
import { PgDriveConnections } from './backup/connections.js';
import { createDriveFactory } from './backup/drive.js';
import { BackupService } from './backup/service.js';
import { TokenVault } from './backup/vault.js';
import { JobQueue } from './jobs/queue.js';
import { UnconfiguredSender, loadVapidKeys } from './notify/sender.js';
import { RetentionService } from './retention/service.js';

const config = loadConfigOrExit();
const auth = loadAuthConfig();
const pool = createPool(config.databaseUrl);

// 실시간 음성 인터뷰: 키 파일(0600)이 없거나 잘못되면 대화 시작만 fail closed 로 막고 나머지 기능은 그대로 동작한다.
let live: LiveConfig | null = null;
let liveProblem: string | null = null;
const key = readKeyFile('DAILY_LOG_GEMINI_KEY_FILE', process.env.DAILY_LOG_GEMINI_KEY_FILE);
if ('problem' in key) liveProblem = key.problem;
else live = loadLiveConfig(key.key, process.env);

// 브리핑 Pro 정리(구독 경로). 설정이 없거나 잘못되면 null → 브리핑 생성은 PRO_UNAVAILABLE 로 막히고 제작 작업은 만들어지지 않는다.
const briefingInfer = await createProInfer(process.env, loadSiwcRuntime);

const connections = new PgDriveConnections(pool, new TokenVault(process.env.DRIVE_TOKEN_KEY?.trim() || config.sessionSecret));
// 웹 서버는 작업을 만들고 상태를 보여 줄 뿐이며 단계 실행은 워커가 한다(handlers 없음).
const backupQueue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers: {} });
const backup = new BackupService({ pool, queue: backupQueue, fileStorageDir: config.fileStorageDir, connections, drive: createDriveFactory({ connections, oidc: auth ? new OidcClient(auth) : null }) });

const vapid = config.vapidKeysFile ? loadVapidKeys(config.vapidKeysFile) : null;
const app = buildApp({
  notifications: new NotificationService({ pool, sender: new UnconfiguredSender() }),
  vapidPublicKey: vapid?.publicKey ?? null,
  auth,
  drive: connections,
  backup,
  sessionSecret: config.sessionSecret,
  fileStorageDir: config.fileStorageDir,
  records: new RecordStore(pool),
  retention: new RetentionService({ pool, fileStorageDir: config.fileStorageDir, readiness: (o, i) => backup.cleanupReadiness(o, i, { live: true }) }),
  briefing: { infer: briefingInfer, rules: new PgRuleStore(pool) },
  entries: { list: async () => (await pool.query('SELECT id, entry_date, body FROM sample_entries ORDER BY entry_date DESC')).rows },
  interview: {
    usage: new PgLiveUsageStore(pool),
    live,
    monthly: new MonthlyLedger(pool),
    sessionDir: process.env.DAILY_LOG_VOICE_SESSION_DIR?.trim() || path.join(config.fileStorageDir, 'live-sessions'),
  },
});
if (!auth) app.log.warn('Google 로그인 설정(GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/ALLOWED_EMAILS) 없음: 보호 경로는 모두 차단됩니다');
if (!briefingInfer) app.log.warn('브리핑 Pro 정리 설정(DAILY_LOG_SIWC_DIR/DAILY_LOG_VOICE_PRO_MODEL/DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED=true) 없음: 브리핑 생성이 차단됩니다');
if (liveProblem) app.log.warn({ code: liveProblem }, '실시간 음성 대화 키(DAILY_LOG_GEMINI_KEY_FILE) 문제: 대화 시작이 차단됩니다');
await app.listen({ port: config.port, host: config.host });
