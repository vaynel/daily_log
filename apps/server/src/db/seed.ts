import { loadConfigOrExit } from '../config.js';
import { createPool } from './pool.js';

// 합성 샘플만 사용한다. 실제 사용자 기록·개인 원문을 만들지 않는다.
const config = loadConfigOrExit();
if (/prod/i.test(config.databaseUrl)) {
  console.error('운영으로 보이는 DB에는 샘플 데이터를 넣지 않습니다.');
  process.exit(1);
}
const pool = createPool(config.databaseUrl);
await pool.query(
  `INSERT INTO sample_entries (id, entry_date, body) VALUES ('00000000-0000-0000-0000-000000000001', '2000-01-01', '[합성 샘플] 개발 환경 확인용')
   ON CONFLICT (id) DO NOTHING`,
);
await pool.end();
console.log('seeded');
