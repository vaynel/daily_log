import { loadConfigOrExit } from '../config.js';
import { createPool } from '../db/pool.js';
import { MonthlyLedger } from './ledger.js';

const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
try {
  const l = new MonthlyLedger(pool);
  console.log(JSON.stringify({ snapshot: await l.snapshot(process.argv[2]), unknown: await l.listUnknown() }, null, 2));
} finally {
  await pool.end();
}
