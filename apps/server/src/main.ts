import { buildApp } from './app.js';
import { loadAuthConfig } from './auth/config.js';
import { loadConfigOrExit } from './config.js';
import { createPool } from './db/pool.js';
import { RecordStore } from './records/store.js';

const config = loadConfigOrExit();
const auth = loadAuthConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp({
  auth,
  sessionSecret: config.sessionSecret,
  fileStorageDir: config.fileStorageDir,
  records: new RecordStore(pool),
  entries: { list: async () => (await pool.query('SELECT id, entry_date, body FROM sample_entries ORDER BY entry_date DESC')).rows },
});
if (!auth) app.log.warn('Google 로그인 설정(GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/ALLOWED_EMAILS) 없음: 보호 경로는 모두 차단됩니다');
await app.listen({ port: config.port, host: config.host });
