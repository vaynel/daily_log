import { loadConfigOrExit } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
let stopping = false;

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

console.log('worker started (기반 골격: 작업 처리 로직은 후속 Task)');
while (!stopping) {
  await pool.query('SELECT 1'); // DB 연결 확인용 heartbeat
  await new Promise((r) => setTimeout(r, config.workerPollIntervalMs));
}
await pool.end();
console.log('worker stopped');
