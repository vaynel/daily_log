/**
 * 작업 큐 재시작 E2E 전용 자식 프로세스(빌드 산출물로 실행). PGOPTIONS로 시험 스키마를 지정한다.
 * 모드: enqueue <kind> | work <kind> <releaseFile>
 * 처리기는 실행될 때마다 `EXEC <단계> <시도>` 를 출력하고, 지정 단계는 releaseFile 이 생길 때까지 멈춘다(SIGKILL 대기).
 */
import { existsSync } from 'node:fs';
import { MonthlyLedger } from '../budget/ledger.js';
import { createPool } from '../db/pool.js';
import { JobQueue, type StageHandler } from './queue.js';

const [mode, kind, releaseFile] = process.argv.slice(2) as [string, string, string];
const pool = createPool(process.env.DATABASE_URL!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hang = async (label: string) => {
  console.log(`HANG ${label}`);
  while (!existsSync(releaseFile)) await wait(50);
};

const plain = (stage: string, hangHere = false, failFirst = false): StageHandler => ({
  async execute(ctx) {
    console.log(`EXEC ${stage} ${ctx.attempt}`);
    if (failFirst && ctx.attempt === 1) throw new Error('ECONNRESET'); // 일시 오류: 자동 재시도 1회 소모
    if (hangHere) await hang(stage);
    return { result: `${stage}-done` };
  },
});
const handlers: Record<string, Record<string, StageHandler>> = {
  // a 완료 → b 처리 중 강제 종료 → 재시작 후 b, c 만 실행
  plain: { a: plain('a'), b: plain('b', true), c: plain('c') },
  // a 일시 오류 1회(재시도 소모) → b 유료 요청 전송 후 강제 종료 → 재시작 후 재전송 없이 조회로 확정
  paid: {
    a: plain('a', false, true),
    b: {
      paid: { provider: 'mock', operation: 'b', estimateKrw: 100 },
      async execute(ctx) {
        console.log(`EXEC b ${ctx.attempt}`);
        await hang('b');
        return { result: 'b-done', actualKrw: 80 };
      },
      async lookup(id) {
        console.log(`LOOKUP ${id.split(':')[1]}`);
        return { status: 'COMPLETED', result: 'b-looked-up', actualKrw: 80, evidence: 'mock provider lookup' };
      },
    },
    c: plain('c'),
  },
};

const queue = new JobQueue({ pool, ledger: new MonthlyLedger(pool), handlers, leaseMs: 1500 });

if (mode === 'enqueue') {
  const j = await queue.enqueue({ kind, subjectId: 'iv-e2e', stages: ['a', 'b', 'c'], idempotencyKey: `e2e-${kind}` });
  console.log(`JOB ${j.id}`);
} else {
  const id = (await pool.query(`SELECT id FROM jobs WHERE kind=$1`, [kind])).rows[0].id as string;
  for (;;) {
    const n = await queue.recover(); // 임대 만료된 RUNNING 작업을 이어받는다
    if (n) console.log(`RECOVERED ${n}`);
    while (await queue.tick()) { /* 처리 */ }
    const j = (await queue.get(id))!;
    if (j.state === 'SUCCEEDED' || j.state === 'FAILED' || j.state === 'WAITING') {
      console.log(`FINAL ${j.state} retries=${j.autoRetriesUsed}`);
      break;
    }
    await wait(200);
  }
}
await pool.end();
