// TASK-138 integration verification only. Run with node --import tsx.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';
import { buildApp } from '../apps/server/src/app.ts';
import { createTempSchema } from '../apps/server/src/records/db.testutil.ts';
import { createHarness, HARNESS_CLOCK } from '../apps/server/src/video/pipeline-harness.ts';
import { PgLiveUsageStore } from '../apps/server/src/interview/usage.ts';
import { loadLiveConfig } from '../apps/server/src/voice/live.ts';
import { startMockLive } from '../apps/server/src/voice/live-mock.testutil.ts';
import { loadAuthConfig } from '../apps/server/src/auth/config.ts';
import { sign } from '../apps/server/src/auth/session.ts';
import { startFakeDrive } from '../apps/server/src/backup/fakeDrive.testutil.ts';
import { GoogleDriveClient } from '../apps/server/src/backup/drive.ts';
import { BackupService, BACKUP_KIND } from '../apps/server/src/backup/service.ts';
import { RetentionService } from '../apps/server/src/retention/service.ts';
import { JobQueue } from '../apps/server/src/jobs/queue.ts';

const out = path.resolve('docs/qa/task-32-evidence');
const work = path.resolve('.tmp/task138');
await mkdir(work, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
const secret = 'synthetic-task138-session-not-real';
const key = 'synthetic-task138-live-not-real';
const nativeFetch = globalThis.fetch;
let external = 0;
globalThis.fetch = (url, init) => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(String(url)).hostname)) { external++; throw Error('External request forbidden'); }
  return nativeFetch(url, init);
};
const rate = 16000, pcm = Buffer.alloc(rate * 4.2 * 2);
for (let i = 0; i < rate * 1.2; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i * .11)), i * 2);
const head = Buffer.alloc(44); head.write('RIFF'); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
const wav = path.join(work, 'speech.wav'); await writeFile(wav, Buffer.concat([head, pcm]));
const mock = await startMockLive({ expectedKey: key, vadSilenceMs: 250, firstAudioDelayMs: 60, audioChunks: 4 });
const drive = await startFakeDrive();
let browser;
const results = [];
const privacy = [];
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--renderer-process-limit=1','--no-zygote','--num-raster-threads=1','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  for (const [profile, options] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['pixel7', devices['Pixel 7']]]) {
    const schema = await createTempSchema(process.env.DATABASE_URL);
    const pool = schema.pool();
    const owner = `task138-${profile}`;
    const dir = path.join(work, profile); await mkdir(dir, { recursive: true });
    const h = createHarness({ pool, dir });
    // Generic fake utterances are DAILY, not learning material. The shared unit
    // harness forces scene 2 to LEARNING, whose minimum 2.5s exceeds these short tones.
    const inferScene = h.deps.infer();
    h.deps.infer = () => async input => {
      const response = await inferScene(input);
      return {...response,text:JSON.stringify(JSON.parse(response.text).map(s=>({...s,type:'DAILY'})))};
    };
    const usage = new PgLiveUsageStore(pool);
    const roots = new Map();
    const handlers = {};
    const queue = new JobQueue({ pool, ledger: h.ledger, handlers });
    const backup = new BackupService({ pool, queue, fileStorageDir: dir, connections: { state: async () => 'CONNECTED', rootFolder: async o => roots.get(o) ?? null, setRootFolder: async (o, id) => { roots.set(o,id); } }, drive: async () => new GoogleDriveClient({ accessToken: async () => 'mock-access', apiBase: drive.apiBase, uploadBase: drive.uploadBase }) });
    handlers[BACKUP_KIND] = backup.handlers();
    const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'mock', GOOGLE_CLIENT_SECRET: 'mock-not-real', GOOGLE_ISSUER: 'http://127.0.0.1:1', ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://127.0.0.1:1' });
    const app = buildApp({ auth, sessionSecret: secret, records: h.records, fileStorageDir: dir, now: HARNESS_CLOCK, backup,
      interview: { usage, live: loadLiveConfig(key, { DAILY_LOG_VOICE_LIVE_URL: mock.url }), sessionDir: path.join(dir,'sessions') },
      briefing: { infer: async () => ({ state: 'SUCCEEDED', text: JSON.stringify([{ kind:'FACT', source:'USER', text:'사용자 발화 1' }, {kind:'FACT',source:'USER',text:'사용자 발화 2'}]) }) } });
    app.log.level = 'silent';
    app.get('/*', async (req, reply) => {
      const rel = req.url.split('?')[0];
      const file = rel.startsWith('/assets/') ? path.resolve('apps/web/dist' + rel) : path.resolve('apps/web/dist/index.html');
      return reply.type(file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html').send(await readFile(file));
    });
    const url = await app.listen({ host:'127.0.0.1',port:0 });
    const ctx = await browser.newContext({ ...options, acceptDownloads:true });
    const claims = {sub:owner,email:'owner@example.test',iat:0,exp:4102444800};
    await ctx.addCookies([{name:'dl_session',value:sign(claims,secret,'session'),url}]);
    const page = await ctx.newPage();
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    try {
      await page.goto(url);
      await page.getByTestId('btn-start').waitFor();
      await page.getByTestId('btn-attach').click();
      await page.getByTestId('in-file').setInputFiles({ name:'synthetic.md',mimeType:'text/markdown',buffer:Buffer.from('# synthetic learning\nNo personal data.') });
      await page.locator('[data-testid=attach-item][data-status=done]').waitFor({timeout:10000});
      console.log(profile + ': attachment stored; starting voice');
      await page.getByTestId('btn-start').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=iv-conversation] li').length >= 4, null, {timeout:60000});
      await page.getByTestId('btn-pause').click();
      const id = (await pool.query('SELECT id FROM interviews WHERE owner_id=$1',[owner])).rows[0].id;
      const original = (await h.records.loadById(owner,id,HARNESS_CLOCK())).items;
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=iv-conversation] li').length >= 4);
      assert.deepEqual((await h.records.loadById(owner,id,HARNESS_CLOCK())).items, original);
      await page.getByTestId('btn-start').click();
      await page.getByTestId('btn-end').click();
      await page.getByTestId('btn-end-confirm').click();
      await page.waitForFunction(() => /대화 끝/.test(document.querySelector('[data-testid=iv-status]')?.textContent ?? ''));
      await page.getByTestId('btn-briefing-start').click();
      await page.getByTestId('br-summary').waitFor();
      assert.equal((await pool.query('SELECT count(*) FROM jobs WHERE subject_id=$1',[id])).rows[0].count,'0');
      console.log(profile + ': voice/reload/briefing reached; confirm then render');
      await page.getByTestId('br-confirm').click();
      await page.getByTestId('br-confirmed').waitFor();
      console.log(profile + ': draining production queue');
      const drained = await h.drain();
      console.log(profile + ': queue ' + JSON.stringify(drained.map(j=>({state:j.state,error:j.errorCode,wait:j.waitReason}))));
      const snap = await h.records.loadById(owner,id,HARNESS_CLOCK());
      assert.equal(snap.pipeline.review,'PASSED');
      await page.goto(url);
      await page.locator('[data-testid=records-list] li button').first().click();
      await page.getByTestId('download-result').waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'),page.getByTestId('download-result').click()]);
      const bytes = await readFile(await download.path());
      const result = snap.versions.filter(v=>v.kind==='RESULT').at(-1);
      assert.equal(sha(bytes), sha(await readFile(path.join(dir,'videos',result.content.file))));
      await page.screenshot({path:path.join(out,`${profile}-complete.png`),fullPage:true});
      await page.getByRole('button',{name:'영상에서 빼기: 사용자 발화 2',exact:true}).click();
      await page.getByTestId('revise-notice').waitFor();
      await page.getByTestId('download-result').waitFor({state:'detached'});
      assert.equal(await page.getByTestId('download-result').count(),0);
      console.log(profile + ': draining production queue');
      await h.drain();
      const revised = await h.records.loadById(owner,id,HARNESS_CLOCK());
      assert.equal(revised.pipeline.review,'PASSED');
      assert.equal(revised.versions.filter(v=>v.kind==='RESULT').length,2);
      const narration = JSON.parse(await readFile(path.join(dir,'work/interviews',id,'narration.json'),'utf8'));
      assert.ok(!JSON.stringify(narration).includes('사용자 발화 2'),'excluded text absent from narration/subtitles');
      assert.deepEqual(revised.items, snap.items, 'video exclusion preserves original conversation');
      await page.reload();
      await page.locator('[data-testid=records-list] li button').first().click();
      await page.getByTestId('download-result').waitFor();
      const [second] = await Promise.all([page.waitForEvent('download'),page.getByTestId('download-result').click()]);
      const last = revised.versions.filter(v=>v.kind==='RESULT').at(-1);
      assert.equal(sha(await readFile(await second.path())),sha(await readFile(path.join(dir,'videos',last.content.file))));
      console.log(profile + ': revised download verified; backing up');
      await backup.enqueueInterview(id);
      for(let n=0;n<10 && await queue.tick();n++);
      assert.equal((await pool.query('SELECT state FROM backup_states WHERE interview_id=$1',[id])).rows[0].state,'VERIFIED');
      assert.deepEqual([...new Set(drive.uploaded().filter(f=>f.appProperties.dlInterview===id).map(f=>f.appProperties.dlKind))].sort(),['ATTACHMENT','RECORD','VIDEO']);
      // Real authentication middleware, direct file access for anonymous/disallowed/other owners.
      const paths = [`/api/records/${id}/results/2/file`,`/api/videos/${last.content.file}`,`/api/attachments/${revised.attachments[0].storageKey}`];
      for(const file of paths) {
        assert.equal((await app.inject({url:file})).statusCode,401);
        const denied = sign({...claims,email:'denied@example.test'},secret,'session');
        assert.equal((await app.inject({url:file,headers:{cookie:`dl_session=${denied}`}})).statusCode,403);
      }
      assert.ok(!(await page.content()).includes(key));
      assert.equal(external,0);
      await page.screenshot({path:path.join(out,`${profile}-revised.png`),fullPage:true});
      const r = {profile,result:'PASS',originalItems:original.length,resultVersions:2,downloadSha256:sha(await readFile(await second.path())),backup:'VERIFIED',directAccess:'401/403',externalRequests:external};
      results.push(r); console.log(JSON.stringify(r));
    } catch(e) {
      await page.screenshot({path:path.join(out,`${profile}-failure.png`),fullPage:true}).catch(()=>{});
      results.push({profile,result:'FAIL',error:String(e)}); console.error(`${profile}: ${e.stack}`);
    } finally {
      await ctx.close(); await app.close();
      const ids = (await pool.query('SELECT id FROM interviews WHERE owner_id=$1',[owner])).rows;
      for (const {id} of ids) {
        const retention = new RetentionService({pool,fileStorageDir:dir,backup});
        await h.records.trashRecord(owner,id,HARNESS_CLOCK());
        await retention.purgeNow(owner,{scope:'RECORD',interviewId:id},HARNESS_CLOCK());
        const dbItems = Number((await pool.query('SELECT count(*) FROM conversation_items WHERE interview_id=$1',[id])).rows[0].count);
        const files = await readdir(path.join(dir,'sessions')).catch(()=>[]);
        let residualFiles = 0;
        for (const file of files.filter(f=>f.endsWith('.json'))) {
          const session = JSON.parse(await readFile(path.join(dir,'sessions',file),'utf8'));
          if(session.turns?.some(t=>t.userText || t.replyText)) residualFiles++;
        }
        privacy.push({profile,dbItemsAfterPurge:dbItems,sessionFilesWithTranscriptAfterPurge:residualFiles,result:files.length===0?'NOT_RUN':dbItems===0 && residualFiles===0?'PASS':'FAIL'});
      }
      await pool.end(); await schema.drop();
    }
  }
} finally {
  await browser?.close(); await mock.close(); await drive.close();
  await writeFile(path.join(out,'integration.json'),JSON.stringify(results,null,2));
  await writeFile(path.join(out,'privacy.json'),JSON.stringify(privacy,null,2));
  console.log('PRIVACY ' + JSON.stringify(privacy));
  await rm(work,{recursive:true,force:true});
}
assert.equal(results.filter(r=>r.result!=='PASS').length,0,'integration failures');

assert.equal(privacy.filter(r=>r.result!=='PASS').length,0,'transcript remains after permanent purge');
