import path from 'node:path';
import { buildApp } from './app.js';
import { loadAuthConfig } from './auth/config.js';
import { MonthlyLedger } from './budget/ledger.js';
import { loadConfigOrExit } from './config.js';
import { createPool } from './db/pool.js';
import { PgLiveUsageStore } from './interview/usage.js';
import { RecordStore } from './records/store.js';
import { readKeyFile } from './voice/keys.js';
import { loadLiveConfig, type LiveConfig } from './voice/live.js';
import { NotificationService } from './notify/service.js';
import { UnconfiguredSender, loadVapidKeys } from './notify/sender.js';

const config = loadConfigOrExit();
const auth = loadAuthConfig();
const pool = createPool(config.databaseUrl);

// 실시간 음성 인터뷰: 키 파일(0600)이 없거나 잘못되면 대화 시작만 fail closed 로 막고 나머지 기능은 그대로 동작한다.
let live: LiveConfig | null = null;
let liveProblem: string | null = null;
const key = readKeyFile('DAILY_LOG_GEMINI_KEY_FILE', process.env.DAILY_LOG_GEMINI_KEY_FILE);
if ('problem' in key) liveProblem = key.problem;
else live = loadLiveConfig(key.key, process.env);

const vapid = config.vapidKeysFile ? loadVapidKeys(config.vapidKeysFile) : null;
const app = buildApp({
  notifications: new NotificationService({ pool, sender: new UnconfiguredSender() }),
  vapidPublicKey: vapid?.publicKey ?? null,
  auth,
  sessionSecret: config.sessionSecret,
  fileStorageDir: config.fileStorageDir,
  records: new RecordStore(pool),
  entries: { list: async () => (await pool.query('SELECT id, entry_date, body FROM sample_entries ORDER BY entry_date DESC')).rows },
  interview: {
    usage: new PgLiveUsageStore(pool),
    live,
    monthly: new MonthlyLedger(pool),
    sessionDir: process.env.DAILY_LOG_VOICE_SESSION_DIR?.trim() || path.join(config.fileStorageDir, 'live-sessions'),
  },
});
if (!auth) app.log.warn('Google 로그인 설정(GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/ALLOWED_EMAILS) 없음: 보호 경로는 모두 차단됩니다');
if (liveProblem) app.log.warn({ code: liveProblem }, '실시간 음성 대화 키(DAILY_LOG_GEMINI_KEY_FILE) 문제: 대화 시작이 차단됩니다');
await app.listen({ port: config.port, host: config.host });
