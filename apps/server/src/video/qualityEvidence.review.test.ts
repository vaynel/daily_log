import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type pg from 'pg';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { pcmToWav } from '../voice/transports.js';
import { createQualityEvidence, DEFAULT_QUALITY_PRICING, type AssessmentInput } from './qualityEvidence.js';
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


it('QA: learning false propagates to LEARNING/zooms while other evidence is valid', async()=>{
  const {provider}=setup();
  const p=createQualityEvidence({ledger,cacheDir:dir,key:'fake',reference:Buffer.from('ref'),pricing:DEFAULT_QUALITY_PRICING,
    fetchImpl:async()=>response(JSON.stringify(yes)),infer:async()=>({state:'SUCCEEDED',text:JSON.stringify({facts:yes,learning:{passed:false,evidence:'learning contradicts source'}})})});
  const i=input(); const assessed=await p.assess(i);
  const report=inspectQuality({file:'x.mp4',sha256:'a'.repeat(64),scriptVersion:1,expectedSec:3,
    probe:{streams:[{codec_type:'video',codec_name:'h264',width:720,height:1280},{codec_type:'audio',codec_name:'aac'}],format:{duration:'3'}},
    scenes:[{key:'s1',script:i.scene.narration,visual:i.scene.visual,transcript:await provider.transcribe(audio,'audio/wav','s1'),subtitles:i.subtitles,zooms:[],versions:{image:1,voice:1,subtitles:1,zoom:1},...assessed}],rules:[],excludedTexts:[]});
  expect(report.passed).toBe(false);
  expect(report.checks).toContainEqual(expect.objectContaining({code:'LEARNING',component:'zooms',passed:false}));
});
it.each(['http','truncated','empty','malformed-image'])('QA: external boundary %s never passes and leaves no RESERVED entry',async kind=>{
  const p=createQualityEvidence({ledger,cacheDir:dir,key:'fake',reference:Buffer.from('ref'),pricing:DEFAULT_QUALITY_PRICING,
    infer:async()=>({state:'SUCCEEDED',text:JSON.stringify({facts:yes,learning:yes})}),
    fetchImpl:async()=>kind==='http'?new Response('',{status:503}):kind==='truncated'?new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'looks valid'}]}}]})):response(kind==='empty'?'':'not JSON')});
  await expect(kind==='malformed-image'?p.assess(input()):p.transcribe(audio,'audio/wav','s1')).rejects.toThrow(kind==='http'?'QUALITY_EXTERNAL_UNKNOWN':'QUALITY_BAD_OUTPUT');
  expect((await ledger.snapshot()).reservedKrw).toBe(0);
});
it('QA: restart after reservation and before cache must classify stranded reservation UNKNOWN',async()=>{
  const reserve=ledger.reserve.bind(ledger);
  // Emulate a killed worker at the durable boundary: reservation committed,
  // process disappears before the external call/catch/cache publication.
  const spy=vi.spyOn(ledger,'reserve').mockImplementationOnce(async i=>{await reserve(i);throw new Error('SIMULATED_PROCESS_DEATH');});
  const first=setup();
  await expect(first.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('SIMULATED_PROCESS_DEATH');
  spy.mockRestore();
  const restarted=setup();
  await expect(restarted.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  expect(first.fetcher).not.toHaveBeenCalled(); expect(restarted.fetcher).not.toHaveBeenCalled();
  const snapshot=await ledger.snapshot();
  console.log('QA_CRASH_SNAPSHOT',JSON.stringify({reserved:snapshot.reservedKrw,unknown:snapshot.unknownKrw}));
  expect(snapshot.reservedKrw).toBe(0);
  expect(snapshot.unknownKrw).toBeGreaterThan(0);
});
it('QA: verified NOT_CHARGED reconciliation permits a safe retry',async()=>{
  const failed=setup({fail:true});
  await expect(failed.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  const [entry]=await ledger.listUnknown();
  expect(await ledger.resolveUnknown(entry!.id,{charged:false,evidence:'QA fake provider confirms request was not processed'})).toBe(true);
  const restarted=setup();
  // Explicit verified reconciliation, never a time-based or blind retry.
  await expect(restarted.provider.transcribe(audio,'audio/wav','s1')).resolves.toBe('오늘 걸었다.');
  expect(restarted.fetcher).toHaveBeenCalledTimes(1);
  expect((await ledger.snapshot()).reservedKrw).toBe(0);
});

it('QA: verified CHARGED without cached evidence must not issue another call',async()=>{
  const failed=setup({fail:true});
  await expect(failed.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  const [entry]=await ledger.listUnknown();
  expect(await ledger.resolveUnknown(entry!.id,{charged:true,actualKrw:100,evidence:'fake provider confirms charged'})).toBe(true);
  const restarted=setup();
  await expect(restarted.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  expect(restarted.fetcher).not.toHaveBeenCalled();
  expect((await ledger.snapshot()).confirmedKrw).toBe(100);
});
it('QA: released attempt still requires available monthly budget',async()=>{
  const failed=setup({fail:true});
  await expect(failed.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
  const [entry]=await ledger.listUnknown();
  await ledger.resolveUnknown(entry!.id,{charged:false,evidence:'fake provider confirms unsent'});
  await ledger.recordCarryover(ledger.currentMonth(),50000,'full','test');
  const restarted=setup();
  await expect(restarted.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('BUDGET_EXCEEDED');
  expect(restarted.fetcher).not.toHaveBeenCalled();
  expect((await ledger.snapshot()).committedKrw).toBe(50000);
  expect((await ledger.snapshot()).reservedKrw).toBe(0);
});
it('QA: concurrent recovery after multiple releases issues only one new external call',async()=>{
  for(let n=0;n<2;n++) {
    const failed=setup({fail:true});
    await expect(failed.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
    const [entry]=await ledger.listUnknown();
    expect(entry).toBeDefined();
    await ledger.resolveUnknown(entry!.id,{charged:false,evidence:'fake provider confirms not processed'});
  }
  let finish!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve=>{finish=resolve;});
  const started = new Promise<void>(resolve=>{entered=resolve;});
  const first=createQualityEvidence({ledger,cacheDir:dir,key:'fake',reference:Buffer.from('ref'),pricing:DEFAULT_QUALITY_PRICING,
    infer:async()=>({state:'SUCCEEDED',text:''}),fetchImpl:async()=>{entered();await pending;return response('오늘 걸었다.');}});
  const result=first.transcribe(audio,'audio/wav','s1');
  try {
    await started;
    const second=setup();
    await expect(second.provider.transcribe(audio,'audio/wav','s1')).rejects.toThrow('QUALITY_EXTERNAL_UNKNOWN');
    expect(second.fetcher).not.toHaveBeenCalled();
  } finally { finish(); }
  await expect(result).resolves.toBe('오늘 걸었다.');
  const restarted=setup();
  await expect(restarted.provider.transcribe(audio,'audio/wav','s1')).resolves.toBe('오늘 걸었다.');
  expect(restarted.fetcher).not.toHaveBeenCalled();
  const rows=(await pool.query('SELECT state FROM budget_entries')).rows;
  expect(rows.filter(r=>r.state==='RELEASED')).toHaveLength(2);
  expect(rows.filter(r=>r.state==='CONFIRMED')).toHaveLength(1);
  expect((await ledger.snapshot()).reservedKrw).toBe(0);
});
