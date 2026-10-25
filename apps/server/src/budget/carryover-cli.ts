import { loadConfigOrExit } from '../config.js';
import { createPool } from '../db/pool.js';
import { MonthlyLedger } from './ledger.js';

/**
 * 시스템 밖 기존 지출 이월 입력(관리자). 같은 키는 한 번만 반영된다.
 * 사용: npm run budget:carryover -w apps/server -- 2026-10 1520 voice-sessions-2026-10 "서버 세션 추정 합계"
 */
const [month, amount, key, ...note] = process.argv.slice(2);
if (!month || !amount || !key) {
  console.error('사용법: budget:carryover <YYYY-MM> <금액KRW> <멱등키> [메모]');
  process.exit(64);
}
const config = loadConfigOrExit();
const pool = createPool(config.databaseUrl);
try {
  const added = await new MonthlyLedger(pool).recordCarryover(month, Number(amount), key, note.join(' '));
  console.log(added ? `이월 ${amount}원 기록(${month})` : '이미 같은 키로 기록됨(변경 없음)');
} finally {
  await pool.end();
}
