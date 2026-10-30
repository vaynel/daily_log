// TASK-29 화면 E2E(모의 API·모의 로그인). 정적 빌드(apps/web/dist 또는 --dist)를 단일 Node 서버가 서빙하고 /auth·/api 는 메모리 모의 응답이다.
// 실제 서버·DB·Google Drive 를 쓰지 않으며 PC(1280x800)와 Android 에뮬레이션(412x915)이다. 실기기 Android 검증이 아니다.
// 사용: node scripts/trash-e2e.mjs --mode before|after [--dist DIR] [--shots DIR]   필요: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const mode = arg('mode', 'after');
const dist = path.resolve(arg('dist', path.join(import.meta.dirname, '../apps/web/dist')));
const shots = arg('shots', '');
if (shots) await mkdir(shots, { recursive: true });
const { chromium } = await import('playwright-core');

// ---- 모의 상태 (합성 데이터) ----
const DAY = 86_400_000;
let clock = new Date('2026-10-30T03:00:00Z');
const KEPT = 'Drive 백업과 완성 영상은 삭제되지 않고 그대로 유지됩니다.';
const mk = (id, lifeDate, extra = {}) => ({ id, lifeDate, status: 'COMPLETED', deleted: null, purged: false, ...extra });
const recs = [mk('11111111-1111-4111-8111-111111111111', '2026-10-29'), mk('22222222-2222-4222-8222-222222222222', '2026-10-28'), mk('33333333-3333-4333-8333-333333333333', '2026-10-27')];
const detailOf = (r) => ({
  id: r.id, lifeDate: r.lifeDate, status: 'COMPLETED', writingStatus: 'CONFIRMED', revision: 2,
  pipeline: { production: 'DONE', review: 'PASSED', backup: 'VERIFIED' }, nextActions: ['DOWNLOAD'],
  conversation: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', seq: 1, kind: 'QUESTION', body: '오늘 무엇을 배웠나요? (합성 질문)', attachmentIds: [] }, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', seq: 2, kind: 'ANSWER', body: '로그 분석을 연습했습니다. (합성 답변)', attachmentIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'] }],
  summary: { version: 1, diary: '로그 분석을 연습한 하루였다. (합성 일기)', learning: ['로그 필터링 기초'] },
  attachments: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', kind: 'MARKDOWN', name: 'memo.md', mime: 'text/markdown', size: 2048, uploadedAt: clock, capturedAt: null }],
  result: { version: 1, fileAvailable: true },
  retention: { serverCopy: 'PRESENT', message: null, cleanupPending: null, backupKept: true },
});
const trashList = () => ({
  records: recs.filter((r) => r.deleted && !r.purged).map((r) => { const purgeAt = new Date(r.deleted.getTime() + 30 * DAY); return { id: r.id, lifeDate: r.lifeDate, deletedAt: r.deleted, purgeAt, daysLeft: Math.ceil((purgeAt - clock) / DAY), restorable: clock < purgeAt }; }),
  parts: [], backupNote: KEPT,
});
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let m;
  if (u.pathname === '/auth/session') return json(res, 200, { email: 'mock-user@example.test', name: null, driveConnected: true });
  if (u.pathname === '/api/records' && req.method === 'GET') return json(res, 200, { nextCursor: null, records: recs.filter((r) => !r.deleted).map((r) => ({ id: r.id, lifeDate: r.lifeDate, status: r.status, pipeline: { production: 'DONE', review: 'PASSED', backup: 'VERIFIED' }, hasResult: true, attachmentCount: 1 })) });
  if ((m = /^\/api\/records\/([\w-]+)$/.exec(u.pathname)) && req.method === 'GET') { const r = recs.find((x) => x.id === m[1] && !x.deleted); return r ? json(res, 200, detailOf(r)) : json(res, 404, { error: 'NOT_FOUND' }); }
  if (u.pathname === '/api/trash') return json(res, 200, trashList());
  if ((m = /^\/api\/records\/([\w-]+)\/(trash|restore|purge)$/.exec(u.pathname)) && req.method === 'POST') {
    const r = recs.find((x) => x.id === m[1]);
    if (!r) return json(res, 404, { error: 'NOT_FOUND' });
    if (m[2] === 'trash') { r.deleted ??= new Date(clock); return json(res, 200, { id: r.id, message: `휴지통으로 옮겼습니다. 30일 안에 복구할 수 있습니다. ${KEPT}` }); }
    if (m[2] === 'restore') { if (r.purged) return json(res, 410, { error: 'RECORD_PURGED' }); if (clock >= new Date(r.deleted.getTime() + 30 * DAY)) return json(res, 410, { error: 'TRASH_EXPIRED' }); r.deleted = null; return json(res, 200, { restored: true }); }
    const body = JSON.parse((await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); })) || '{}');
    if (body.confirm !== true) return json(res, 422, { error: 'CONFIRM_REQUIRED' });
    r.deleted ??= new Date(clock); r.purged = true; return json(res, 200, { serverCopy: 'PURGED', message: `서버 사본을 영구 삭제했습니다. ${KEPT}` });
  }
  // 정적 파일
  let file = path.join(dist, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1', '--no-sandbox'] });
const results = [];
const check = (name, fn) => fn().then(() => results.push(`PASS ${name}`), (e) => { results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`); process.exitCode = 1; });

for (const [label, viewport, mobile] of [['pc', { width: 1280, height: 800 }, false], ['android-emu', { width: 412, height: 915 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const shot = async (n) => { if (shots) await page.screenshot({ path: path.join(shots, `${mode}-${label}-${n}.png`) }); };
  recs.forEach((r) => { r.deleted = null; r.purged = false; });
  await page.goto(base);
  await page.getByTestId('records-list').waitFor();
  await page.locator('[data-life-date="2026-10-29"] .row').click();
  await page.getByTestId('screen-record-detail').getByRole('heading', { name: /2026-10-29/ }).waitFor();
  await shot('detail');
  if (mode === 'before') {
    await check(`${label} 기준 커밋: 상세에 삭제 기능이 없다`, async () => {
      assert.equal(await page.getByRole('button', { name: /삭제|휴지통/ }).count(), 0);
    });
    await ctx.close();
    continue;
  }
  await check(`${label} 상세: 기록·항목·첨부 삭제 버튼이 있다`, async () => {
    assert.equal(await page.getByRole('button', { name: '이 날의 기록 삭제' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '이 항목 삭제' }).count(), 2);
    assert.equal(await page.getByRole('button', { name: '첨부 삭제' }).count(), 1);
  });
  await page.getByRole('button', { name: '이 날의 기록 삭제' }).click();
  const dlg = page.getByRole('alertdialog', { name: /2026-10-29 기록 삭제 확인/ });
  await dlg.waitFor();
  await shot('delete-confirm');
  await check(`${label} 삭제 확인 문구: 서버 사본만 대상, Drive 백업·완성 영상 유지, 30일 복구`, async () => {
    const t = await dlg.innerText();
    assert.match(t, /30일 안에는 복구/); assert.match(t, /Drive 백업과 완성 영상은 삭제되지 않고 그대로 유지/);
    assert.doesNotMatch(t, /전체 삭제|모두 삭제/);
  });
  await dlg.getByRole('button', { name: '취소' }).click();
  assert.equal(await dlg.count(), 0);
  await page.getByRole('button', { name: '이 날의 기록 삭제' }).click();
  await dlg.getByRole('button', { name: '휴지통으로 옮기기' }).click();
  await page.getByTestId('records-list').waitFor();
  await check(`${label} 삭제한 기록은 목록에서 사라진다`, async () => { assert.equal(await page.locator('[data-life-date="2026-10-29"]').count(), 0); });
  await page.getByTestId('open-trash').click();
  await page.getByTestId('trash-records').waitFor();
  await shot('trash');
  await check(`${label} 휴지통: 남은 기간·복구·영구 삭제 버튼과 서버/Drive 구분 안내`, async () => {
    assert.match(await page.getByTestId('trash-remaining').innerText(), /30일 안에 복구/);
    assert.match(await page.getByTestId('trash-note').innerText(), /서버의 사본만 지웁니다|서버 사본만|서버의 사본/);
    assert.match(await page.getByTestId('trash-note').innerText(), /Drive 백업과 완성 영상은 삭제되지 않고/);
  });
  // 영구 삭제는 2단계, 취소하면 아무것도 지우지 않는다
  await page.getByTestId('purge').click();
  await page.getByTestId('purge-confirm').waitFor();
  await shot('purge-confirm');
  await check(`${label} 영구 삭제 확인 문구: 복구 불가 + Drive 백업 유지`, async () => {
    const t = await page.getByTestId('purge-confirm').innerText();
    assert.match(t, /복구할 수 없습니다/); assert.match(t, /Drive 백업과 완성 영상은 삭제되지 않고/);
  });
  await page.getByTestId('purge-no').click();
  assert.equal(await page.getByTestId('purge-confirm').count(), 0);
  assert.equal(recs[0].purged, false);
  // 복구
  await page.getByTestId('restore').click();
  await page.getByTestId('trash-empty').waitFor();
  await check(`${label} 복구하면 휴지통이 비고 기록이 돌아온다`, async () => {
    assert.match(await page.getByTestId('trash-message').innerText(), /복구했습니다/);
    await page.getByRole('button', { name: '← 기록' }).click();
    await page.locator('[data-life-date="2026-10-29"]').waitFor();
  });
  // 만료(30일 경과) 시 복구 버튼이 사라진다
  await page.locator('[data-life-date="2026-10-28"] .row').click();
  await page.getByRole('button', { name: '이 날의 기록 삭제' }).click();
  await page.getByRole('button', { name: '휴지통으로 옮기기' }).click();
  await page.getByTestId('open-trash').click();
  await page.getByTestId('trash-records').waitFor();
  clock = new Date(clock.getTime() + 31 * DAY);
  await page.getByRole('button', { name: '← 기록' }).click();
  await page.getByTestId('open-trash').click();
  await page.getByTestId('trash-records').waitFor();
  await shot('trash-expired');
  await check(`${label} 30일이 지나면 복구 버튼 없이 만료 안내만 보인다`, async () => {
    assert.equal(await page.getByTestId('restore').count(), 0);
    assert.match(await page.getByTestId('trash-remaining').innerText(), /복구 기간이 지났/);
  });
  // 즉시 영구 삭제
  await page.getByTestId('purge').click();
  await page.getByTestId('purge-yes').click();
  await page.getByTestId('trash-empty').waitFor();
  await check(`${label} 영구 삭제 완료 안내는 서버 사본만 삭제됐고 Drive 백업은 유지됨을 알린다`, async () => {
    const t = await page.getByTestId('trash-message').innerText();
    assert.match(t, /서버 사본을 삭제했습니다/); assert.match(t, /Drive 백업과 완성 영상은 삭제되지 않고/);
    assert.equal(recs[1].purged, true);
  });
  clock = new Date('2026-10-30T03:00:00Z');
  await ctx.close();
}
await browser.close();
server.close();
console.log(results.join('\n'));
console.log(process.exitCode ? 'trash-e2e FAIL' : `trash-e2e PASS (${mode}, 모의 API·모의 로그인)`);
