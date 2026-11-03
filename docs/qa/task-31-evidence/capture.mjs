// Render actual saved command output; this is REPRODUCTION evidence, not product UI.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Usage: node capture.mjs before|after');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent('<html><body style="background:#101827;color:#dce7f5;padding:32px;font:18px monospace"><h1>TASK-31 / REPRODUCTION</h1><pre style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></body></html>');
  await page.locator('pre').evaluate((el, text) => { el.textContent = text; }, await readFile(new URL(`./${phase}.txt`, import.meta.url), 'utf8'));
  await page.screenshot({ path: new URL(`./${phase}.png`, import.meta.url).pathname, fullPage: true });
} finally { await browser.close(); }
