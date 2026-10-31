// TASK-29 브라우저 E2E: 정적 서버 + 모의 API(메모리) + 모의 로그인. 실제 서버·DB·Google Drive 를 쓰지 않는다. 합성 데이터.
// PC(1280x800)와 Android 에뮬레이션(412x915 터치) 이며 실제 Android 기기 검증이 아니다.
// 환경: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, E2E_DIST(기본 apps/web/dist), E2E_MODE=after|before, E2E_SHOT_DIR(선택).
// pids 제한 때문에 Chromium 은 한 번에 하나만 띄운다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.resolve(process.env.E2E_DIST ?? path.join(root, 'apps/web/dist'));
const mode = process.env.E2E_MODE ?? 'after';
const shotDir = process.env.E2E_SHOT_DIR ?? '';
const { chromium } = await import('playwright-core');
const NOTICE = '서버에 있는 사본만 지워집니다. Google Drive 백업과 완성 영상은 지워지지 않습니다.';
const DAY = 86400000;
const T0 = Date.now();

// ---- 모의 API 상태 ----
const rec = (id, lifeDate) => ({ id, lifeDate, status: 'COMPLETED', pipeline: { production: 'DONE', review: 'PASSED', backup: 'VERIFIED' }, hasResult: true, attachmentCount: 1 });
const state = {
  records: [rec('00000000-0000-4000-8000-000000000001', '2026-10-30'), rec('00000000-0000-4000-8000-000000000002', '2026-10-29')],
  trash: [],
  calls: [],
};
const detail = (r) => ({
  id: r.id, lifeDate: r.lifeDate, status: r.status, pipeline: r.pipeline, nextActions: ['DOWNLOAD'],
  conversation: [
    { id: '00000000-0000-4000-8000-0000000000a1', seq: 1, kind: 'QUESTION', body: '(합성) 오늘 무엇을 했나요?', attachmentIds: [] },
    { id: '00000000-0000-4000-8000-0000000000a2', seq: 2, kind: 'ANSWER', body: '(합성) 테스트 답변입니다.', attachmentIds: ['00000000-0000-4000-8000-0000000000b1'] },
  ],
  summary: { version: 1, diary: '(합성) 요약된 일기', learning: ['(합성) 학습 1'] },
  attachments: [{ id: '00000000-0000-4000-8000-0000000000b1', itemId: '00000000-0000-4000-8000-0000000000a2', kind: 'PHOTO', name: 'photo.jpg', size: 2048, capturedAt: null }],
  result: { version: 1, fileAvailable: true },
  serverCopy: { cleanedAt: null, cleanupBlockedReason: r.lifeDate === '2026-10-29' ? 'BACKUP_NOT_CURRENT' : null },
});
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/auth/session') return json(res, 200, { email: 'demo@example.test', name: '데모', driveConnected: true });
  if (p === '/api/records' && req.method === 'GET') return json(res, 200, { records: state.records, nextCursor: null });
  let m = /^\/api\/records\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') { const r = state.records.find((x) => x.id === m[1]); return r ? json(res, 200, detail(r)) : json(res, 404, { error: 'NOT_FOUND' }); }
  if (p === '/api/trash') return json(res, 200, { entries: state.trash, notice: NOTICE });
  if (req.method === 'POST' && p.startsWith('/api/records/')) {
    state.calls.push(p);
    const [, , , id, seg, child, act] = p.split('/');
    if (seg === 'trash') {
      const i = state.records.findIndex((x) => x.id === id);
      const [r] = state.records.splice(i, 1);
      state.trash.push({ scope: 'RECORD', recordId: id, lifeDate: r.lifeDate, id, label: `${r.lifeDate} 하루 기록 (대화 2개 · 첨부 1개)`, deletedAt: new Date(T0).toISOString(), purgeAt: new Date(T0 + 30 * DAY).toISOString(), canRestore: true });
      return json(res, 200, { notice: NOTICE });
    }
    if (seg === 'restore' || seg === 'purge') {
      const i = state.trash.findIndex((x) => x.id === id);
      const [e] = state.trash.splice(i, 1);
      if (seg === 'restore') state.records.unshift(rec(id, e.lifeDate));
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: true, child, act });
  }
  if (p.startsWith('/api/') || p.startsWith('/auth/')) return json(res, 404, { error: 'NOT_FOUND' });
  const file = path.join(dist, p === '/' ? 'index.html' : p);
  if (!file.startsWith(dist)) return json(res, 403, {});
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
if (shotDir) await mkdir(shotDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1'],
});
let passed = 0;
const ok = (name) => { passed++; console.log(`PASS ${name}`); };
const shot = async (page, name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); };
const text = (page, sel) => page.locator(sel).first().innerText();
const open = async (page) => {
  await page.goto(base + '/');
  await page.locator('[data-testid=screen-home]').waitFor();
  await page.locator('[data-testid=records-list]').waitFor();
  await page.locator('[data-testid=records-list] li').first().locator('button').click();
  await page.locator('[data-testid=screen-record-detail] h3').waitFor();
};

try {
  const profiles = [['pc', { viewport: { width: 1280, height: 800 } }], ['android', { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]];
  for (const [name, opts] of profiles) {
    state.calls.length = 0; state.trash.length = 0;
    state.records = [rec('00000000-0000-4000-8000-000000000001', '2026-10-30'), rec('00000000-0000-4000-8000-000000000002', '2026-10-29')];
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    if (mode === 'before') {
      await open(page);
      assert.equal(await page.locator('[data-testid=trash-record], [data-testid=open-trash]').count(), 0);
      await shot(page, `before-detail-${name}`);
      ok(`${name} 수정 전: 기록 상세에 삭제·휴지통 기능 없음`);
      await ctx.close();
      continue;
    }
    // 1) 상세: 삭제 버튼과 정리 대기 사유 표시
    await open(page);
    assert.ok(await page.locator('[data-testid=trash-record]').isVisible());
    assert.ok(await page.locator('[data-testid=trash-item]').first().isVisible());
    assert.ok(await page.locator('[data-testid=trash-attachment], [data-testid=trash-item]').count() >= 2);
    await shot(page, `after-detail-${name}`);
    ok(`${name} 기록 상세에 기록·항목 삭제 버튼`);
    // 2) 삭제 확인: 서버 사본/Drive 백업·완성 영상 구분 문구, 취소는 아무것도 보내지 않음
    await page.locator('[data-testid=trash-record]').click();
    const warn = await text(page, '[data-testid=trash-warning]');
    assert.ok(warn.includes('30일') && warn.includes('Google Drive 백업과 완성 영상은 지워지지 않습니다'), warn);
    await shot(page, `after-confirm-${name}`);
    await page.locator('[data-testid=confirm-no]').click();
    assert.equal(await page.locator('[data-testid=confirm-box]').count(), 0);
    assert.equal(state.calls.length, 0);
    ok(`${name} 삭제 확인 문구(30일 복구·서버 사본만)와 취소 시 요청 없음`);
    // 3) 삭제 → 목록에서 사라지고 휴지통에 남은 기간 표시
    await page.locator('[data-testid=trash-record]').click();
    await page.locator('[data-testid=confirm-yes]').click();
    await page.locator('[data-testid=records-list]').waitFor();
    assert.equal(await page.locator('[data-testid=records-list] li').count(), 1);
    await page.locator('[data-testid=open-trash]').click();
    await page.locator('[data-testid=trash-list]').waitFor();
    assert.ok((await text(page, '[data-testid=remaining]')).includes('30일 안에 복구할 수 있습니다'));
    assert.ok((await text(page, '[data-testid=scope-notice]')).includes('Google Drive 백업과 완성 영상은 지워지지 않습니다'));
    await shot(page, `after-trash-${name}`);
    ok(`${name} 휴지통: 남은 기간·복구·영구 삭제, 서버 삭제/백업 보존 구분 문구`);
    // 4) 영구 삭제 2단계 확인
    await page.locator('[data-testid=purge]').click();
    const pw = await text(page, '[data-testid=purge-warning]');
    assert.ok(pw.includes('복구할 수 없습니다') && pw.includes('Google Drive 백업과 완성 영상은 지워지지 않습니다'), pw);
    await shot(page, `after-purge-confirm-${name}`);
    await page.locator('[data-testid=confirm-no]').click();
    assert.equal(state.trash.length, 1);
    ok(`${name} 영구 삭제 확인 문구와 취소`);
    // 5) 복구
    await page.locator('[data-testid=restore]').click();
    await page.locator('[data-testid=trash-empty]').waitFor();
    assert.equal(state.records.length, 2);
    ok(`${name} 복구하면 목록으로 돌아옴`);
    // 6) 30일 지난 항목: 복구 버튼 없음
    state.trash.push({ scope: 'RECORD', recordId: 'x', lifeDate: '2026-09-01', id: '00000000-0000-4000-8000-0000000000ff', label: '2026-09-01 하루 기록 (대화 1개 · 첨부 0개)', deletedAt: new Date(T0 - 31 * DAY).toISOString(), purgeAt: new Date(T0 - DAY).toISOString(), canRestore: false });
    await page.reload();
    await page.locator('[data-testid=open-trash]').click();
    await page.locator('[data-testid=trash-list]').waitFor();
    assert.equal(await page.locator('[data-testid=restore]').count(), 0);
    assert.ok((await text(page, '[data-testid=remaining]')).includes('복구할 수 없습니다'));
    await shot(page, `after-expired-${name}`);
    ok(`${name} 보관 기간이 끝난 항목은 복구 버튼 없이 안내만`);
    state.trash.length = 0;
    // 7) 정리 대기 사유(두 번째 기록)
    await page.reload();
    await page.locator('[data-testid=records-list]').waitFor();
    await page.locator('[data-testid=records-list] li').nth(1).locator('button').click();
    await page.locator('[data-testid=cleanup-pending]').waitFor();
    assert.ok((await text(page, '[data-testid=cleanup-pending]')).includes('서버 원본은 유지됩니다'));
    ok(`${name} 서버 사본 정리 대기 사유 표시`);
    await ctx.close();
  }
  console.log(`E2E ${mode} OK (${passed} 점검)`);
} finally {
  await browser.close();
  server.close();
}
