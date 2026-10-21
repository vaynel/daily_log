import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig } from '../auth/config.js';
import { sign } from '../auth/session.js';
import { createTempSchema } from '../records/db.testutil.js';
import { RecordStore } from '../records/store.js';
import { makeJpeg, makePng } from './fixtures.testutil.js';

const url = process.env.DATABASE_URL;
const SECRET = 'unit-test-session-secret-0123456789';
let now = new Date('2026-10-21T10:00:00+09:00');
const fresh = (() => { let n = 0; return () => cookie(`sub-${++n}`, n % 2 ? 'a@example.test' : 'b@example.test'); })();

const cookie = (sub: string, email: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return `dl_session=${sign({ sub, email, iat, exp: iat + 3600 }, SECRET, 'session')}`;
};

describe.skipIf(!url)('첨부 API (실제 PostgreSQL + 파일 저장소)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let dir: string;
  const files = async () => (await readdir(path.join(dir, 'attachments')).catch(() => [])).sort();

  beforeAll(async () => {
    t = await createTempSchema(url!);
    pool = t.pool();
    dir = await mkdtemp(path.join(os.tmpdir(), 'dl-att-'));
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', ALLOWED_EMAILS: 'a@example.test,b@example.test', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
    app = buildApp({ auth, sessionSecret: SECRET, fileStorageDir: dir, records: new RecordStore(pool), now: () => now });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  const start = async (c: string) => ((await app.inject({ method: 'POST', url: '/api/records', headers: { cookie: c } })).json() as { id: string }).id;
  const upload = (c: string, id: string, o: { key: string; kind: string; name: string; body: Buffer; type?: string }) =>
    app.inject({
      method: 'POST', url: `/api/records/${id}/attachments`, payload: o.body,
      headers: { cookie: c, 'content-type': o.type ?? 'application/octet-stream', 'x-idempotency-key': o.key, 'x-attachment-kind': o.kind, 'x-file-name': encodeURIComponent(o.name) },
    });

  let A = '';
  let B = '';
  beforeEach(() => { A = fresh(); B = fresh(); now = new Date('2026-10-21T10:00:00+09:00'); });

  it('인증 없이 기록·첨부 API 접근 불가', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/records' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/records/00000000-0000-4000-8000-000000000000/attachments', payload: makePng() })).statusCode).toBe(401);
  });

  it('AC-1 사진과 Markdown, 학습 메모를 같은 기록에 첨부하고 목록으로 확인', async () => {
    const id = await start(A);
    const p = await upload(A, id, { key: 'k-photo', kind: 'PHOTO', name: '점심.jpg', body: makeJpeg({ exif: '2026:10:21 12:00:00', offset: '+09:00' }), type: 'image/jpeg' });
    expect(p.statusCode).toBe(201);
    now = new Date(now.getTime() + 1000);
    const m = await upload(A, id, { key: 'k-md', kind: 'MARKDOWN', name: '노트.md', body: Buffer.from('# 배운 것\n- 캐시 무효화'), type: 'text/markdown' });
    expect(m.statusCode).toBe(201);
    now = new Date(now.getTime() + 1000);
    const n = await upload(A, id, { key: 'k-note', kind: 'NOTE', name: 'note.md', body: Buffer.from('오늘 메모'), type: 'text/markdown' });
    expect(n.statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: `/api/records/${id}/attachments`, headers: { cookie: A } })).json() as { attachments: { kind: string; name: string; capturedAt: string | null; capturedSource: string | null }[] };
    expect(list.attachments.map((x) => x.kind)).toEqual(['PHOTO', 'MARKDOWN', 'NOTE']);
    expect(list.attachments[0]).toMatchObject({ name: '점심.jpg', capturedAt: '2026-10-21T03:00:00.000Z', capturedSource: 'EXIF' });
    // 저장된 원본을 로그인 상태에서 직접 주소로 열 수 있다.
    const key = (p.json() as { storageKey: string }).storageKey;
    const got = await app.inject({ method: 'GET', url: `/api/attachments/${key}`, headers: { cookie: A } });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
  });

  it('AC-2 손상·미지원·초과 파일은 거부되고 참조도 파일도 남지 않는다', async () => {
    const id = await start(A);
    const before = await files();
    const j = makeJpeg({ salt: 90 });
    const cases: [string, Buffer, number, string][] = [
      ['잘린 JPEG', j.subarray(0, j.length - 4), 422, 'UNREADABLE_FILE'],
      ['텍스트를 .jpg 로', Buffer.from('hello world, not an image'), 415, 'UNSUPPORTED_TYPE'],
    ];
    for (const [i, [label, body, status, code]] of cases.entries()) {
      const r = await upload(A, id, { key: `bad-${i}`, kind: 'PHOTO', name: 'x.jpg', body });
      expect([r.statusCode, (r.json() as { error: string }).error], label).toEqual([status, code]);
    }
    const md = await upload(A, id, { key: 'bad-md', kind: 'MARKDOWN', name: 'x.md', body: Buffer.from([0xff, 0xfe, 0x00, 0x80]) });
    expect([md.statusCode, (md.json() as { error: string }).error]).toEqual([422, 'UNREADABLE_FILE']);
    const big = await upload(A, id, { key: 'big', kind: 'MARKDOWN', name: 'x.md', body: Buffer.alloc(1024 * 1024 + 1, 97) });
    expect(big.statusCode).toBe(413);
    expect(await files()).toEqual(before);
    expect(Number((await pool.query('SELECT count(*) FROM attachment_refs WHERE interview_id = $1', [id])).rows[0].count)).toBe(0);
  });

  it('AC-3 같은 파일 재첨부(같은 키·다른 키·다른 기록)에서 원본 파일을 새로 쓰지 않는다', async () => {
    const id = await start(B);
    const body = makeJpeg({ salt: 7 });
    const before = (await files()).length;
    const first = await upload(B, id, { key: 'd1', kind: 'PHOTO', name: 'a.jpg', body });
    expect(first.statusCode).toBe(201);
    expect((await files()).length).toBe(before + 1);
    const sameKey = await upload(B, id, { key: 'd1', kind: 'PHOTO', name: 'a.jpg', body });
    const otherKey = await upload(B, id, { key: 'd2', kind: 'PHOTO', name: 'copy-of-a.jpg', body });
    for (const r of [sameKey, otherKey]) expect([r.statusCode, (r.json() as { duplicate: boolean }).duplicate]).toEqual([200, true]);
    expect((otherKey.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    expect((await files()).length).toBe(before + 1);
    expect(Number((await pool.query('SELECT count(*) FROM attachment_refs WHERE interview_id = $1', [id])).rows[0].count)).toBe(1);
    // 다른 날 기록에서 같은 파일을 첨부하면 참조만 늘고 원본은 하나다.
    now = new Date('2026-10-21T03:00:00+09:00'); // 05:00 전에는 전날 기록도 만들 수 있다
    const other = ((await app.inject({ method: 'POST', url: '/api/records', headers: { cookie: B }, payload: { lifeDate: '2026-10-20' } })).json() as { id: string }).id;
    expect(other).not.toBe(id);
    expect(other).toBeTruthy();
    const cross = await upload(B, other, { key: 'x1', kind: 'PHOTO', name: 'a.jpg', body });
    expect(cross.statusCode).toBe(201);
    expect((await files()).length).toBe(before + 1);
    expect(Number((await pool.query('SELECT count(DISTINCT storage_key) FROM attachment_refs WHERE checksum = $1', [(first.json() as { storageKey: string }).storageKey.split('.')[0]])).rows[0].count)).toBe(1);
    // 같은 키에 다른 내용은 충돌
    const conflict = await upload(B, id, { key: 'd1', kind: 'PHOTO', name: 'a.jpg', body: makeJpeg({ salt: 8 }) });
    expect(conflict.statusCode).toBe(409);
  });

  it('AC-4 촬영 시각이 없으면 capturedAt 은 null 이고 업로드 시각과 구분된다', async () => {
    const id = await start(A);
    const r = await upload(A, id, { key: 'nocap', kind: 'PHOTO', name: 'screenshot.png', body: makePng(33) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ capturedAt: null, capturedSource: null });
    const row = (await pool.query('SELECT captured_at, captured_source, saved_at FROM attachment_refs WHERE id = $1', [(r.json() as { id: string }).id])).rows[0];
    expect(row.captured_at).toBeNull();
    expect(row.captured_source).toBeNull();
    expect(row.saved_at.toISOString()).toBe(now.toISOString());
    const noExifTime = await upload(A, id, { key: 'exif-none', kind: 'PHOTO', name: 'a.jpg', body: makeJpeg({ exif: null, salt: 34 }) });
    expect(noExifTime.json()).toMatchObject({ capturedAt: null });
    const assumed = await upload(A, id, { key: 'exif-kst', kind: 'PHOTO', name: 'b.jpg', body: makeJpeg({ exif: '2026:10:21 09:00:00', salt: 35 }) });
    expect(assumed.json()).toMatchObject({ capturedAt: '2026-10-21T00:00:00.000Z', capturedSource: 'EXIF_ASSUMED_KST' });
  });

  it('다른 소유자의 기록에는 첨부·조회할 수 없다', async () => {
    const id = await start(A);
    const r = await upload(B, id, { key: 'steal', kind: 'NOTE', name: 'n.md', body: Buffer.from('x') });
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/records/${id}/attachments`, headers: { cookie: B } })).statusCode).toBe(404);
  });

  it('확정된 기록과 개수 제한', async () => {
    const id = await start(A);
    for (let i = 0; i < 30; i++) expect((await upload(A, id, { key: `n${i}`, kind: 'NOTE', name: 'n.md', body: Buffer.from(`메모 ${i}`) })).statusCode).toBe(201);
    const over = await upload(A, id, { key: 'n30', kind: 'NOTE', name: 'n.md', body: Buffer.from('메모 초과') });
    expect([over.statusCode, (over.json() as { error: string }).error]).toEqual([409, 'TOO_MANY_ATTACHMENTS']);
    expect(await files()).not.toContain(expect.stringContaining('tmp'));
    // 거부된 새 파일은 남지 않는다
    const overFiles = (await files()).length;
    await upload(A, id, { key: 'n31', kind: 'NOTE', name: 'n.md', body: Buffer.from('메모 초과2') });
    expect((await files()).length).toBe(overFiles);
  });
});
