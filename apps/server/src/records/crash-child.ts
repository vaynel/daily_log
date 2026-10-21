/**
 * 서버 측 중단 E2E 전용 자식 프로세스(빌드 산출물로 실행). PGOPTIONS로 시험 스키마를 지정한다.
 * 모드: stream(저장 응답마다 SAVED 출력, 무한 반복) | mid(트랜잭션 중간에서 MID 출력 후 대기) | dump(스냅샷 JSON 출력)
 */
import { createPool } from '../db/pool.js';
import { RecordStore } from './store.js';

const [mode, owner, lifeDate] = process.argv.slice(2) as [string, string, string];
const pool = createPool(process.env.DATABASE_URL!);
const now = () => new Date();

if (mode === 'stream') {
  const store = new RecordStore(pool);
  const { interview } = await store.startInterview(owner, now(), lifeDate);
  console.log(`STARTED ${interview.id}`);
  for (let i = 1; ; i++) {
    const r = await store.saveItemWithAttachment(owner, interview.id, `s${i}`, 'ANSWER', `답변 ${i}`, { storageKey: `files/${i}.png`, checksum: `sum${i}` }, now());
    console.log(`SAVED ${i} ${r.item.seq}`);
  }
} else if (mode === 'mid') {
  const id = process.argv[5]!;
  const store = new RecordStore(pool, {
    afterItemInsert: async () => {
      console.log('MID');
      await new Promise(() => {}); // SIGKILL을 기다린다
    },
  });
  await store.saveItemWithAttachment(owner, id, 'mid-key', 'ANSWER', '저장 도중 종료될 답변', { storageKey: 'files/mid.png', checksum: 'mid' }, now());
  console.log('UNEXPECTED_COMPLETE');
} else if (mode === 'dump') {
  const snap = await new RecordStore(pool).resumeInterview(owner, lifeDate, now());
  console.log(`SNAPSHOT ${JSON.stringify(snap)}`);
  await pool.end();
}
