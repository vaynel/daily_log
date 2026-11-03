import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const dir = '/workspace/docs/video/task-136-evidence';
const log = await readFile(`${dir}/review.txt`, 'utf8');
const excerpt = log.slice(log.indexOf(' ✓'), log.indexOf('   Start at'));
const escaped = excerpt.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
await writeFile(`${dir}/review.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>TASK-136 independent review</title><style>body{margin:36px;background:#111827;color:#e5edf7;font:18px monospace}h1{font-size:30px;color:#fca5a5}pre{white-space:pre-wrap;font-size:16px;line-height:1.5;padding:20px;background:#1f2937}p{line-height:1.5}</style><h1>TASK-136 — CHANGES_REQUESTED</h1><p>REVIEW: reproduction of actual QA execution output, not product UI.<br>Submitted commit: 2b009ff7aba97c86f087cdcb7e1a8abd5cebe9ea</p><p>Original server suite: 498 PASS. Web: 39 PASS.<br>SIWC: 37 PASS / 4 Windows-only SKIP.<br>lint / typecheck / build / secrets: exit 0.</p><pre>${escaped}</pre><p>F1: stranded reservation after interrupted worker.<br>F2: retry remains blocked after verified NOT_CHARGED reconciliation.<br>Paid provider calls: 0. Deployment: NOT RUN.</p></html>`);
const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 await page.goto('http://127.0.0.1:8136/review.html');
 await page.screenshot({path:`${dir}/review.png`,fullPage:true});
} finally { await browser.close(); }
