import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const phase = process.argv[2];
if (!['before','after'].includes(phase)) throw new Error('phase required');
const dir = new URL('./', import.meta.url);
const log = await readFile(new URL(`${phase}.txt`,dir),'utf8');
const escaped = log.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});
try {
 const page = await browser.newPage({viewport:{width:1440,height:1100}});
 await page.setContent(`<html><meta charset="utf-8"><style>body{background:#111827;color:#eee;font:16px monospace;margin:32px}pre{white-space:pre-wrap}</style><h1>TASK-135 REWORK / ${phase.toUpperCase()}</h1><p>REPRODUCTION of actual CLI output, not product UI. Paid calls: 0; no deployment.</p><pre>${escaped}</pre></html>`);
 await page.screenshot({path:new URL(`${phase}.png`,dir).pathname,fullPage:true});
} finally { await browser.close(); }
