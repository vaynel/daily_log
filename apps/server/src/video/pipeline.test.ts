import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { VIDEO_JOB_STAGES } from '../briefing/briefing.js';
import { createTempSchema } from '../records/db.testutil.js';
import { latestScenePlan } from './sceneStage.js';
import { enqueueRevision } from './pipeline.js';
import { createHarness, recordExclusion, seedConfirmedBriefing, type SeedItem } from './pipeline-harness.js';

const url = process.env.DATABASE_URL;
const TEXTS: SeedItem[] = [
  { text: '아침에 카페에서 에코 서버 버그를 고쳤다.', emphasis: true },
  { text: '값을 따로 넘기면 안전하다는 걸 배웠다.' },
  { text: '저녁에는 천천히 걸으며 하루를 정리했다.' },
];

/** ffmpeg -i 출력에서 해상도·길이를 읽는다(이 이미지에 ffprobe 가 없는 환경에서도 동작). */
const mediaInfo = (file: string) => {
  let err = '';
  try { execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? ''); }
  const size = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(err);
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(err);
  return { w: Number(size?.[1]), h: Number(size?.[2]), sec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : NaN, h264: /Video: h264/.test(err), aac: /Audio: aac/.test(err) };
};

describe.skipIf(!url)('확정 브리핑 → 제작 파이프라인 (실제 PostgreSQL·모의 제공자)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>, pool: pg.Pool, dir: string;
  const fetchGuard = vi.fn(() => { throw new Error('실제 네트워크 호출 금지(모의 제공자만)'); });
  beforeAll(async () => {
    t = await createTempSchema(url!); pool = t.pool();
    vi.stubGlobal('fetch', fetchGuard);
  });
  afterAll(async () => { vi.unstubAllGlobals(); await pool.end(); await t.drop(); });
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-')); });

  const ledgerRows = async () => (await pool.query("SELECT provider, operation, state, idempotency_key FROM budget_entries ORDER BY created_at, id")).rows;

  it('AC-1/AC-5: 확정 브리핑이 5단계를 거쳐 COMPLETED 와 9:16 MP4 까지 가고, 모든 유료 호출이 원장을 거친다', async () => {
    const h = createHarness({ pool, dir });
    const s = await seedConfirmedBriefing(h, pool, TEXTS, { withPhoto: true });
    const before = (await ledgerRows()).length;
    await h.drain();
    const job = (await h.queue.get(s.jobId))!;
    expect(job).toMatchObject({ state: 'SUCCEEDED', stages: VIDEO_JOB_STAGES, qualityRegenerationsUsed: 0, autoRetriesUsed: 0 });
    expect((await h.queue.stages(s.jobId)).map((x) => [x.stage, x.state]).sort()).toEqual(VIDEO_JOB_STAGES.map((x) => [x, 'DONE']).sort());
    const snap = (await h.records.loadById(s.owner, s.interviewId, new Date()))!;
    expect(snap.pipeline).toMatchObject({ production: 'DONE', review: 'PASSED' });
    const result = snap.versions.filter((v) => v.kind === 'RESULT');
    expect(result).toHaveLength(1);
    const file = path.join(dir, 'videos', (result[0]!.content as { file: string }).file);
    expect(statSync(file).size).toBeGreaterThan(1000);
    const info = mediaInfo(file);
    expect(info).toMatchObject({ w: 720, h: 1280, h264: true, aac: true });
    expect(info.sec).toBeGreaterThan(1);
    expect(info.sec).toBeLessThanOrEqual(180);
    // 다운로드 허용 판정(records/view.ts)과 같은 상태 규칙: COMPLETED.
    const { displayStatus } = await import('../records/view.js');
    expect(displayStatus(snap.interview.status, snap.pipeline, true)).toBe('COMPLETED');
    // AC-5: 모의 호출 수 = 원장 항목 수(Pro 구독 경로 제외), 실제 fetch 0.
    const rows = (await ledgerRows()).slice(before);
    expect(rows.filter((r) => r.operation === 'tts')).toHaveLength(h.calls.tts.length);
    expect(rows.filter((r) => r.operation.startsWith('image:'))).toHaveLength(h.calls.image);
    expect(rows.every((r) => r.state === 'CONFIRMED')).toBe(true);
    expect(h.calls.tts).toHaveLength(3);
    expect(h.calls.image).toBeGreaterThanOrEqual(2); // 배경(사진 장면) + 캐릭터 포즈
    expect(fetchGuard).not.toHaveBeenCalled();
  }, 120_000);
});
