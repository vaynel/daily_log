import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
const phase = process.argv[2];
if (!['before','after'].includes(phase)) throw Error('before|after');
const browser = await chromium.launch({ executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--renderer-process-limit=1','--no-zygote','--num-raster-threads=1'] });
try {
 const page = await browser.newPage({viewport:{width:1280,height:900}});
 await page.setContent('<body style="background:#142030;color:#eef;padding:30px;font:17px monospace"><h1>TASK-138 / REPRODUCTION</h1><pre style="white-space:pre-wrap"></pre></body>');
 await page.locator('pre').evaluate((el,t)=>el.textContent=t,await readFile(new URL(`./${phase}.txt`,import.meta.url),'utf8'));
 await page.screenshot({path:new URL(`./${phase}.png`,import.meta.url).pathname,fullPage:true});
} finally { await browser.close(); }
