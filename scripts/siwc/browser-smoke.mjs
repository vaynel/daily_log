// Optional browser check: pass a workspace-local Playwright index.mjs path.
// All non-loopback navigation is intercepted; no OpenAI requests are sent.
import assert from 'node:assert/strict';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from './auth.mjs';
import {startCompanion} from './companion.mjs';
const {chromium}=await import(pathToFileURL(resolve(process.argv[2])).href);
const root=fileURLToPath(new URL('../../data/task53/',import.meta.url));await mkdir(root,{recursive:true});
const dir=await mkdtemp(resolve(root,'browser-'));
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});
try {
 for(const allowLogin of [false,true]) {
  const app=await startCompanion(new Store(`${dir}/${allowLogin?'enabled':'demo'}`),{allowLogin,transport:async()=>{throw Error('Unexpected token request');}});
  try {
   const page=await browser.newPage({viewport:{width:1280,height:800}});let intercepted=0;
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='127.0.0.1')return route.abort();
    // Playwright routes only the first URL in a redirect chain. Intercept
    // the loopback response before the browser can follow its Location.
    if(allowLogin && url.pathname==='/start') {
     const response=await route.fetch({maxRedirects:0});
     assert.equal(response.status(),303);
     const target=new URL(response.headers().location);
     assert.equal(target.origin,'https://auth.openai.com');
     assert.equal(target.searchParams.has('id_token_hint'),false);
     intercepted++;return route.fulfill({status:200,contentType:'text/html',body:'<p>INTERCEPTED_AUTH_NO_NETWORK</p>'});
    }
    return route.continue();
   });
   await page.goto(app.url);await page.getByRole('button',{name:'Continue with ChatGPT'}).waitFor();
   if(!allowLogin)await page.screenshot({path:resolve(root,'demo.png'),fullPage:true});
   await page.getByRole('button',{name:'Continue with ChatGPT'}).click();
   await page.getByText(allowLogin?'INTERCEPTED_AUTH_NO_NETWORK':'데모 모드: 실제 로그인 비활성. 실행 안내를 확인하세요.').waitFor({timeout:5000});
   assert.equal(intercepted,allowLogin?1:0);
   if(!allowLogin)await page.screenshot({path:resolve(root,'demo-blocked.png'),fullPage:true});
   console.log(JSON.stringify({mode:allowLogin?'enabled-intercepted':'demo',result:'PASS',externalNetworkCalls:0}));
   await page.close();
  }finally{await app.close();}
 }
}finally{await browser.close();await rm(dir,{recursive:true,force:true});}
