// Synthetic API fixture; real React detail view and supplied Chromium. No account/API calls.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const phase = process.argv[2] ?? 'AFTER';
const id = 'c5983f26-0874-4b51-8bba-348db85de191';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const detail = { id, lifeDate: '2026-10-26', status: 'REVIEW_REJECTED', pipeline: { production: 'DONE', review: 'REJECTED', backup: 'NONE', qualityReasons: ['QUALITY_EXHAUSTED', 'BUDGET'] }, nextActions: ['EDIT_AND_REMAKE'], conversation: [], summary: null, attachments: [], result: null };
  await page.route('**/auth/session', r => r.fulfill({ json: { email: 'fixture@example.test', name: '시험', driveConnected: true } }));
  await page.route('**/api/**', r => r.fulfill({ status: r.request().url().endsWith(`/api/records/${id}`) ? 200 : 404, json: r.request().url().endsWith(`/api/records/${id}`) ? detail : {} }));
  await page.goto(`http://127.0.0.1:5173/?record=${id}`);
  await page.getByTestId('status-badge').waitFor();
  assert.equal(await page.getByTestId('status-badge').textContent(), '검수 미통과');
  if (phase === 'AFTER') {
    await page.getByTestId('quality-reasons').waitFor();
    assert.equal(await page.getByTestId('quality-reasons').locator('li').count(), 2);
    assert.match(await page.getByTestId('quality-reasons').textContent(), /예산 확보/);
    assert.match(await page.getByTestId('quality-reasons').textContent(), /1회를 모두 사용/);
  } else assert.equal(await page.getByTestId('quality-reasons').count(), 0);
  assert.equal(await page.getByTestId('download-result').count(), 0);
  await mkdir('docs/video/task-26-rework-evidence', { recursive: true });
  await page.screenshot({ path: `docs/video/task-26-rework-evidence/${phase.toLowerCase()}.png`, fullPage: true });
  console.log(`PASS ${phase}: actual React detail, synthetic rejected + exhausted + budget fixture, 900x1100`);
} finally { await browser.close(); }
