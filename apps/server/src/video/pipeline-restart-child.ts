/**
 * 제작 파이프라인 SIGKILL 재시작 E2E 전용 자식 프로세스(빌드 산출물로 실행, 모의 제공자만). PGOPTIONS 로 시험 스키마를 지정한다.
 * 모드: seed <dir> | work <dir> <releaseFile> <hangAt: render|tts2|none>
 * work 는 hangAt 지점에서 releaseFile 이 생길 때까지 멈추고(`HANG <지점>` 출력) 그 상태에서 시험이 SIGKILL 한다.
 */
import { existsSync } from 'node:fs';
import { createPool } from '../db/pool.js';
import { createHarness, seedConfirmedBriefing } from './pipeline-harness.js';

const [mode, dir, releaseFile, hangAt] = process.argv.slice(2) as [string, string, string, string];
const pool = createPool(process.env.DATABASE_URL!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hang = async (label: string) => { console.log(`HANG ${label}`); while (!existsSync(releaseFile)) await wait(50); };
const LEASE_MS = 1500;

const h = createHarness({
  pool, dir, leaseMs: LEASE_MS,
  onTts: async (text, n) => { console.log(`TTS ${n}`); if (hangAt === 'tts2' && n === 2) await hang('tts2'); },
  overlayHook: async (n) => { if (hangAt === 'render' && n === 1) await hang('render'); },
});

if (mode === 'seed') {
  const s = await seedConfirmedBriefing(h, pool, [{ text: '아침에 카페에서 에코 서버 버그를 고쳤다.', emphasis: true }, { text: '값을 따로 넘기면 안전하다는 걸 배웠다.' }, { text: '저녁에는 천천히 걸으며 하루를 정리했다.' }]);
  console.log(`JOB ${s.jobId} IV ${s.interviewId}`);
} else {
  const id = (await pool.query('SELECT id FROM jobs LIMIT 1')).rows[0].id as string;
  for (;;) {
    const n = await h.queue.recover(); // 임대 만료된 RUNNING 작업을 이어받는다
    if (n) console.log(`RECOVERED ${n}`);
    while (await h.queue.tick()) { /* 처리 */ }
    const j = (await h.queue.get(id))!;
    if (j.state === 'SUCCEEDED' || j.state === 'FAILED' || j.state === 'WAITING') {
      console.log(`FINAL ${j.state} wait=${j.waitReason ?? '-'} retries=${j.autoRetriesUsed} quality=${j.qualityRegenerationsUsed}`);
      console.log(`CALLS tts=${h.calls.tts.length} image=${h.calls.image} infer=${h.calls.infer}`);
      break;
    }
    await wait(200);
  }
}
await pool.end();
