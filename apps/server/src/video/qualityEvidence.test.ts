import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type pg from 'pg';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { pcmToWav } from '../voice/transports.js';
import { createQualityEvidence, DEFAULT_QUALITY_PRICING, assessReadability, type AssessmentInput } from './qualityEvidence.js';
import { inspectQuality } from './quality.js';
const it = test.skipIf(!process.env.DATABASE_URL);

let dir: string, db: Awaited<ReturnType<typeof createTempSchema>>, pool: pg.Pool, ledger: MonthlyLedger;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(),'quality-')); db = await createTempSchema(process.env.DATABASE_URL!); pool = db.pool(); ledger = new MonthlyLedger(pool); });
afterEach(async () => { await pool.end(); await db.drop(); await rm(dir, { recursive: true, force: true }); });
const yes = { passed: true, evidence: 'verified against supplied source' };
const input = (): AssessmentInput => ({
  scene: { key:'s1', order:1, type:'DAILY', narration:'오늘 걸었다.', visual:'고정 캐릭터 걷기', evidenceIds:['e1'], photoId:null, timeStatus:'NONE', estimated:false, emphasis:false, estimatedSec:3 },
  frame:Buffer.from('frame'), subtitles:['오늘 걸었다.'], zooms:[],
  briefing:[{id:'e1', text:'오늘 걸었다.', emphasis:false}], originals:['오늘 걸었다.'],
  cues:[{sceneKey:'s1', mode:'FULL', text:'오늘 걸었다.', fontPx:52, startSec:0, endSec:3}], zoomPlans:[], window:{startSec:0,endSec:3},
});
const audio = pcmToWav(Buffer.alloc(24000 * 2 * 3));
const response = (text: string) => new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}));
function setup(options: { pro?: boolean; key?: boolean; fail?: boolean; image?: boolean; facts?: boolean; transcript?: string } = {}) {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (options.fail) throw new Error('secret response must not escape');
    const body=JSON.parse(String(init?.body));
    return response(body.contents[0].parts.some((p: {inlineData?: {mimeType:string}})=>p.inlineData?.mimeType==='audio/wav') ? (options.transcript ?? '오늘 걸었다.') : JSON.stringify({...yes, passed:options.image ?? true}));
  });
  const infer = vi.fn(async () => ({state:'SUCCEEDED',text:JSON.stringify({facts:{...yes,passed:options.facts ?? true},learning:yes})}));
  const provider=createQualityEvidence({ledger, cacheDir:dir, key:options.key===false?null:'fake-key', infer:options.pro===false?null:infer,
    reference:Buffer.from('reference'), pricing:DEFAULT_QUALITY_PRICING, fetchImpl:fetcher});
  return {provider,fetcher,infer};
}

it('real evidence provider uses audio/frame/reference/source, reserves and settles, reuses on restart', async () => {
  const {provider,fetcher,infer}=setup();
  expect(await provider.transcribe(audio,'audio/wav','s1')).toBe('오늘 걸었다.');
  expect(await provider.assess(input())).toEqual({facts:yes,image:yes,learning:yes,readability:expect.objectContaining({passed:true})});
  expect(infer.mock.calls.length).toBe(1);
  const body=JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
  expect(body.generationConfig).toEqual({maxOutputTokens:2048,thinkingConfig:{thinkingLevel:'LOW'}});
  expect(body.contents[0].parts.filter((p:{inlineData?:unknown})=>p.inlineData)).toHaveLength(2);
  const restarted=setup();
  await restarted.provider.transcribe(audio,'audio/wav','s1'); await restarted.provider.assess(input());
  expect(restarted.fetcher).not.toHaveBeenCalled(); expect(restarted.infer).not.toHaveBeenCalled();
  const rows=(await pool.query('SELECT state,operation FROM budget_entries')).rows;
  expect(rows).toHaveLength(3); expect(rows.every(r=>r.state==='CONFIRMED')).toBe(true);
});
it.each([{pro:false},{key:false}])('absent configuration stops before reservation: %j', async o => {
  const {provider,fetcher}=setup(o);
  await expect(provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow(o.pro===false?'PRO_UNAVAILABLE':'QUALITY_GEMINI_UNAVAILABLE');
  expect((await ledger.snapshot()).committedKrw).toBe(0); expect(fetcher).not.toHaveBeenCalled();
});
it('lost response is UNKNOWN, sanitized, and never called twice', async () => {
  const a=setup({fail:true});
  await expect(a.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  const b=setup(); await expect(b.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  expect(b.fetcher).not.toHaveBeenCalled(); expect((await ledger.snapshot()).reservedKrw).toBe(0);
  expect((await ledger.snapshot()).unknownKrw).toBeGreaterThan(0);
});
it('budget refuses before external call', async () => {
  await ledger.recordCarryover(ledger.currentMonth(),50000,'full','test');
  const {provider,fetcher}=setup(); await expect(provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('BUDGET_EXCEEDED');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['transcript','facts','image','readability'] as const)('quality rejects %s with component for repair', async kind => {
  const {provider}=setup({transcript:kind==='transcript'?'거짓 전사':undefined,facts:kind!=='facts',image:kind!=='image'});
  const i=input(); if(kind==='readability') i.cues[0]!.fontPx=1;
  const transcript=await provider.transcribe(audio,'audio/wav','s1');
  const assessed=await provider.assess(i);
  const report=inspectQuality({file:'x.mp4',sha256:'a'.repeat(64),scriptVersion:1,expectedSec:3,
    probe:{streams:[{codec_type:'video',codec_name:'h264',width:720,height:1280},{codec_type:'audio',codec_name:'aac'}],format:{duration:'3'}},
    scenes:[{key:'s1',script:i.scene.narration,visual:i.scene.visual,transcript,subtitles:i.subtitles,zooms:[],versions:{image:1,voice:1,subtitles:1,zoom:1},...assessed}],rules:[],excludedTexts:[]});
  expect(report.passed).toBe(false);
  const [code,component]=({transcript:['TRANSCRIPT_MISMATCH','transcript'],facts:['FACTS','script'],image:['IMAGE','visual'],readability:['READABILITY','subtitles']} as const)[kind];
  expect(report.checks).toContainEqual(expect.objectContaining({code,component,passed:false}));
});

it('Pro wait has zero charge and can resume; no paid vision fallback', async () => {
  let waiting=true;
  const fetcher=vi.fn(async()=>response(JSON.stringify(yes)));
  const provider=createQualityEvidence({ledger,cacheDir:dir,key:'fake',reference:Buffer.from('ref'),pricing:DEFAULT_QUALITY_PRICING,fetchImpl:fetcher,
    infer:async()=>waiting?{state:'WAIT_LIMIT'}:{state:'SUCCEEDED',text:JSON.stringify({facts:yes,learning:yes})}});
  await expect(provider.assess(input())).rejects.toThrow('PRO_WAITING');
  expect(fetcher).not.toHaveBeenCalled(); expect((await ledger.snapshot()).committedKrw).toBe(0);
  waiting=false; expect((await provider.assess(input())).facts.passed).toBe(true);
  expect((await ledger.snapshot()).reservedKrw).toBe(0);
});
it.each(['{}','{"facts":{"passed":"true","evidence":"x"},"learning":{}}','not json'])('malformed Pro evidence never passes: %s',async text=>{
  const fetcher=vi.fn();
  const provider=createQualityEvidence({ledger,cacheDir:dir,key:'fake',reference:Buffer.from('ref'),pricing:DEFAULT_QUALITY_PRICING,fetchImpl:fetcher,infer:async()=>({state:'SUCCEEDED',text})});
  await expect(provider.assess(input())).rejects.toThrow('QUALITY_BAD_OUTPUT'); expect(fetcher).not.toHaveBeenCalled();
});
it('missing source and invalid zoom layout cannot be inferred as PASS',async()=>{
  const {provider}=setup(); const i=input(); i.briefing=[];
  await expect(provider.assess(i)).rejects.toThrow('QUALITY_SOURCE_MISSING');
  expect((await ledger.snapshot()).committedKrw).toBe(0);
});
it('accepts a full 180-second narration and rejects over-duration audio before reservation',async()=>{
  const {provider}=setup();
  await expect(provider.transcribe(pcmToWav(Buffer.alloc(24000*2*180)),'audio/wav','long')).resolves.toBe('오늘 걸었다.');
  const count=(await pool.query('SELECT count(*) FROM budget_entries')).rows[0].count;
  await expect(provider.transcribe(pcmToWav(Buffer.alloc(24000*2*181)),'audio/wav','long')).rejects.toThrow('QUALITY_AUDIO_INVALID');
  expect((await pool.query('SELECT count(*) FROM budget_entries')).rows[0].count).toBe(count);
});

it('readability measures contrast and rejects altered or oversized learning display',()=>{
  const i=input(); const evidence=JSON.parse(assessReadability(i).evidence);
  expect(evidence.captionContrast).toBeGreaterThanOrEqual(4.5); expect(evidence.zoomContrast).toBeGreaterThanOrEqual(4.5);
  i.scene.type='LEARNING';
  i.zoomPlans=[{sceneKey:'s1',kind:'NOTE',chunks:[{original:'원문',displayLines:['변조'],fontPx:48,mono:false,continued:[false],wrapped:false,startSec:0,endSec:3}]}];
  expect(assessReadability(i).passed).toBe(false);
  i.zoomPlans[0]!.chunks[0]!.displayLines=['원문']; expect(assessReadability(i).passed).toBe(true);
  i.zoomPlans[0]!.chunks[0]!.fontPx=500; expect(assessReadability(i).passed).toBe(false);
});
it('daily captions must cover narration and provide reading time',()=>{
  const i=input(); i.cues[0]!.text='오늘'; expect(assessReadability(i).passed).toBe(false);
  i.cues[0]!.text=i.scene.narration; i.cues[0]!.endSec=0.01; expect(assessReadability(i).passed).toBe(false);
});
