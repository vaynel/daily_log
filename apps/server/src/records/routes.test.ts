import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { createTempSchema } from './db.testutil.js';
import { RecordStore, type PipelineState } from './store.js';
import { displayStatus, nextActions } from './view.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
const cookie = (sub: string, email: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 }, SECRET, 'session')}`;
};
const CHECKSUM = 'a'.repeat(64);

const p = (production: PipelineState['production'], review: PipelineState['review'] = 'NONE', backup: PipelineState['backup'] = 'NONE'): PipelineState => ({ production, review, backup });

describe('displayStatus / nextActions', () => {
  it('비정상·대기 상태는 정상 완료와 서로 다른 값', () => {
    const all = [
      displayStatus('IN_PROGRESS', p('NONE')), displayStatus('CONFIRMED', p('NONE')), displayStatus('CONFIRMED', p('RUNNING')),
      displayStatus('CONFIRMED', p('WAITING_BUDGET')), displayStatus('CONFIRMED', p('FAILED')),
      displayStatus('CONFIRMED', p('DONE', 'REJECTED')), displayStatus('CONFIRMED', p('DONE', 'PENDING')), displayStatus('CONFIRMED', p('DONE', 'PASSED')),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all[7]).toBe('COMPLETED');
  });
  it('다운로드는 검수 통과 + 파일 있음일 때만, 백업 실패는 별도 행동', () => {
    expect(nextActions('CONFIRMED', p('DONE', 'PASSED'), true)).toEqual(['DOWNLOAD']);
    expect(nextActions('CONFIRMED', p('DONE', 'PASSED'), false)).toEqual([]);
    expect(nextActions('CONFIRMED', p('DONE', 'REJECTED'), true)).toEqual(['EDIT_AND_REMAKE']);
    expect(nextActions('CONFIRMED', p('DONE', 'PASSED', 'FAILED'), true)).toEqual(['DOWNLOAD', 'RETRY_BACKUP']);
  });
});

describe.skipIf(!url)('기록 목록·상세 API (실제 PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let store: RecordStore;
  let app: FastifyInstance;
  let dir: string;
  const A = cookie('owner-a', 'a@example.test');
  const B = cookie('owner-b', 'b@example.test');
  const get = (u: string, c = A) => app.inject({ method: 'GET', url: u, headers: { cookie: c } });

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    store = new RecordStore(pool);
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-view-'));
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test,b@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    app = buildApp({ auth, sessionSecret: SECRET, fileStorageDir: dir, records: store, now: () => new Date('2026-10-25T10:00:00+09:00') });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  const mk = async (owner: string, date: string) => (await store.startInterview(owner, new Date(`${date}T10:00:00+09:00`), date)).interview.id;

  it('AC-1 늦게 완성된 영상도 제작일이 아니라 생활일 순서로 정렬', async () => {
    const d19 = await mk('owner-a', '2026-10-19');
    const d20 = await mk('owner-a', '2026-10-20');
    const d21 = await mk('owner-a', '2026-10-21');
    // 10/19 기록의 영상이 가장 나중(10/24)에 완성된다.
    await store.confirm('owner-a', d19, new Date('2026-10-19T22:00:00+09:00'));
    await store.setPipeline('owner-a', d19, { production: 'DONE', review: 'PASSED' }, new Date('2026-10-24T09:00:00+09:00'));
    await store.appendVersion('owner-a', d19, 'RESULT', { file: 'late.mp4' }, new Date('2026-10-24T09:00:00+09:00'));
    const list = ((await get('/api/records')).json() as { records: { id: string; lifeDate: string; status: string }[] }).records;
    expect(list.map((x) => x.lifeDate)).toEqual(['2026-10-21', '2026-10-20', '2026-10-19']);
    expect(list.map((x) => x.id)).toEqual([d21, d20, d19]);
    expect(list[0]!.status).toBe('WRITING');
    expect(list[2]!.status).toBe('COMPLETED');
  });

  it('다른 소유자의 기록은 목록·상세에 나오지 않고 비로그인은 401', async () => {
    const id = await mk('owner-a', '2026-10-22');
    expect((await get('/api/records', B)).json()).toEqual({ records: [] });
    expect((await get(`/api/records/${id}`, B)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/records' })).statusCode).toBe(401);
  });

  it('AC-2 상세: 대화 원본·정리된 일기·학습·첨부가 서로 연결됨', async () => {
    const id = await mk('owner-a', '2026-10-23');
    const q = await store.saveItem('owner-a', id, 'k1', 'QUESTION', '오늘 무엇을 했나요?', new Date());
    const ans = await store.saveItem('owner-a', id, 'k2', 'ANSWER', '합성 답변', new Date());
    await store.saveFileAttachment('owner-a', id, 'a1', { itemId: ans.id, storageKey: `${CHECKSUM}.png`, checksum: CHECKSUM, kind: 'PHOTO', name: 'p.png', mime: 'image/png', size: 5, capturedAt: null, capturedSource: null }, new Date());
    await store.appendVersion('owner-a', id, 'SUMMARY', { diary: '정리된 일기', learning: ['학습 A'] }, new Date());
    await mkdir(path.join(dir, 'attachments'), { recursive: true });
    await writeFile(path.join(dir, 'attachments', `${CHECKSUM}.png`), Buffer.from('12345'));
    const d = (await get(`/api/records/${id}`)).json() as { conversation: { id: string; body: string; attachmentIds: string[] }[]; summary: unknown; attachments: { id: string }[] };
    expect(d.conversation.map((c) => c.body)).toEqual(['오늘 무엇을 했나요?', '합성 답변']);
    expect(d.conversation[0]!.id).toBe(q.id);
    expect(d.summary).toMatchObject({ diary: '정리된 일기', learning: ['학습 A'] });
    expect(d.attachments).toHaveLength(1);
    expect(d.conversation[1]!.attachmentIds).toEqual([d.attachments[0]!.id]);
    expect(d.attachments[0]).not.toHaveProperty('storageKey');
    const f = await get(`/api/records/${id}/attachments/${d.attachments[0]!.id}/file`);
    expect(f.statusCode).toBe(200);
    expect(f.rawPayload.toString()).toBe('12345');
    expect((await get(`/api/records/${id}/attachments/${d.attachments[0]!.id}/file`, B)).statusCode).toBe(404);
  });

  it('AC-3 검수 미통과·처리 실패·예산 대기는 정상 완료와 구분되고 백업은 별도', async () => {
    const out: Record<string, string> = {};
    const cases: [string, Partial<PipelineState>][] = [
      ['2026-10-10', { production: 'FAILED' }], ['2026-10-11', { production: 'WAITING_BUDGET' }],
      ['2026-10-12', { production: 'DONE', review: 'REJECTED' }], ['2026-10-13', { production: 'DONE', review: 'PASSED', backup: 'FAILED' }],
    ];
    for (const [date, patch] of cases) {
      const id = await mk('owner-a', date);
      await store.confirm('owner-a', id, new Date());
      await store.setPipeline('owner-a', id, patch, new Date());
      const d = (await get(`/api/records/${id}`)).json() as { status: string; nextActions: string[]; pipeline: { backup: string } };
      out[date] = `${d.status}|${d.nextActions.join(',')}|${d.pipeline.backup}`;
    }
    expect(out).toEqual({
      '2026-10-10': 'FAILED|RETRY|NONE',
      '2026-10-11': 'BUDGET_WAIT|WAIT|NONE',
      '2026-10-12': 'REVIEW_REJECTED|EDIT_AND_REMAKE|NONE',
      '2026-10-13': 'COMPLETED|RETRY_BACKUP|FAILED',
    });
  });

  it('AC-4 결과 파일이 없으면 available=false, 다운로드 404, 있으면 200', async () => {
    const id = await mk('owner-a', '2026-10-14');
    await store.confirm('owner-a', id, new Date());
    await store.setPipeline('owner-a', id, { production: 'DONE', review: 'PASSED' }, new Date());
    await store.appendVersion('owner-a', id, 'RESULT', { file: 'missing.mp4' }, new Date());
    type D = { result: { fileAvailable: boolean }; nextActions: string[] };
    let d = (await get(`/api/records/${id}`)).json() as D;
    expect(d.result.fileAvailable).toBe(false);
    expect(d.nextActions).not.toContain('DOWNLOAD');
    const miss = await get(`/api/records/${id}/result/file`);
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toMatchObject({ error: 'FILE_MISSING' });
    // 0바이트 파일도 성공으로 보지 않는다.
    await mkdir(path.join(dir, 'videos'), { recursive: true });
    await writeFile(path.join(dir, 'videos', 'missing.mp4'), '');
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(404);
    await writeFile(path.join(dir, 'videos', 'missing.mp4'), 'video-bytes');
    d = (await get(`/api/records/${id}`)).json() as D;
    expect(d.result.fileAvailable).toBe(true);
    expect(d.nextActions).toContain('DOWNLOAD');
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(200);
  });

  it('결과 파일 이름에 경로 문자가 있으면 파일 없음으로 처리', async () => {
    const id = await mk('owner-a', '2026-10-15');
    await store.appendVersion('owner-a', id, 'RESULT', { file: '../attachments/x' }, new Date());
    expect((await get(`/api/records/${id}/result/file`)).statusCode).toBe(404);
  });
});
