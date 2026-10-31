// Browser emulation + loopback HTTP + mock OIDC, not real Android/Google/external-network validation.
import { chromium, devices } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../apps/server/dist/app.js';
import { startMockIssuer } from '../../apps/server/dist/auth/mock-issuer.js';
import { loadAuthConfig } from '../../apps/server/dist/auth/config.js';
const dir=mkdtempSync('/workspace/data/task30/access-');
for(const d of ['attachments','videos'])mkdirSync(join(dir,d));
writeFileSync(join(dir,'attachments','photo.png'),'SYNTHETIC_ATTACHMENT');writeFileSync(join(dir,'videos','day.mp4'),'SYNTHETIC_VIDEO');
const issuer=await startMockIssuer({clientId:'test-client',clientSecret:'test-secret'});
const auth=loadAuthConfig({GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',GOOGLE_ISSUER:issuer.issuer,ALLOWED_EMAILS:'owner@example.test',PUBLIC_BASE_URL:'http://127.0.0.1:1'});
const app=buildApp({auth,sessionSecret:'synthetic-session-secret-0000',fileStorageDir:dir,entries:{list:async()=>[{body:'SYNTHETIC_PRIVATE_RECORD'}]}});
app.get('/',async()=>({probe:'PRIVATE_APP_ROUTE'}));
let browser;
try {
 const base=await app.listen({port:0,host:'127.0.0.1'});auth.publicBaseUrl=base;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});
 const paths=['/','/api/entries','/api/attachments/photo.png','/api/videos/day.mp4'];
 for(const device of ['Desktop Chrome','Pixel 7']) {
  const ctx=await browser.newContext({...devices[device]});const page=await ctx.newPage();
  for(const path of paths)assert.equal((await ctx.request.get(base+path)).status(),401);
  issuer.state.account={sub:'owner',email:'owner@example.test',email_verified:true,name:'Synthetic Owner'};
  await page.goto(base+'/auth/login');await page.waitForURL(base+'/');
  for(const path of paths)assert.equal((await ctx.request.get(base+path)).status(),200);
  assert.equal(await (await ctx.request.get(base+'/api/attachments/photo.png')).text(),'SYNTHETIC_ATTACHMENT');
  assert.equal(await (await ctx.request.get(base+'/api/videos/day.mp4')).text(),'SYNTHETIC_VIDEO');
  await ctx.request.post(base+'/auth/logout');for(const path of paths)assert.equal((await ctx.request.get(base+path)).status(),401);
  issuer.state.account={sub:'stranger',email:'stranger@example.test',email_verified:true,name:'Synthetic Stranger'};
  await page.goto(base+'/auth/login');assert.match(page.url(),/error=not_allowed/);
  assert.ok(!(await ctx.cookies()).some(c=>c.name==='dl_session'));
  for(const path of paths){const r=await ctx.request.get(base+path);assert.equal(r.status(),401);assert.doesNotMatch(await r.text(),/SYNTHETIC_/);}
  await ctx.close();console.log(`PASS ${device}: anonymous 4x401, owner 4x200 + attachment/video bytes, logout 4x401, stranger denied + 4x401`);
 }
 console.log('ACCESS PASS — mock OIDC; PC/Android emulation; real external network/Google/device: 관리자 수행 대기');
}finally{await browser?.close();await app.close();await issuer.close();rmSync(dir,{recursive:true,force:true});}
