import { tmpdir } from 'node:os';
import { expect, it as test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createTempSchema } from '../records/db.testutil.js';
import { createHarness, seedConfirmedBriefing } from './pipeline-harness.js';
import { createQualityEvidence, DEFAULT_QUALITY_PRICING } from './qualityEvidence.js';
import { createVideoHandlers } from './pipeline.js';
import * as pro from '../briefing/pro.js';
import { buildVideoRuntime } from './pipelineRuntime.js';
import type { Config } from '../config.js';
import { QualityRejectedError } from '../jobs/queue.js';
const it = test.skipIf(!process.env.DATABASE_URL);

it('production evidence through actual render/quality: PASS, then each defect identifies repair stages', async () => {
  const db=await createTempSchema(process.env.DATABASE_URL!); const pool=db.pool(); const dir=await mkdtemp(path.join(tmpdir(),'quality-pipeline-'));
  const guard=vi.fn(()=>{throw new Error('Live network forbidden');}); vi.stubGlobal('fetch',guard);
  try {
    const h=createHarness({pool,dir});
    const s=await seedConfirmedBriefing(h,pool,[{text:'오늘 산책을 했다.'},{text:'값을 따로 넘기면 안전하다는 걸 배웠다.'}]);
    // Synthetic source records match the synthetic confirmed briefing.
    await pool.query("INSERT INTO conversation_items (id,interview_id,seq,idempotency_key,kind,body,saved_at) VALUES (gen_random_uuid(),$1,1,'source','ANSWER',$2,now())",[s.interviewId,s.texts.map(t=>t.text).join('\n')]);
    let defect='';
    const yes={passed:true,evidence:'fake transport: source compared'};
    const fetcher:typeof fetch=async (_url,init)=>{
      const body=JSON.parse(String(init?.body));
      const audio=body.contents[0].parts.find((p:{inlineData?:{mimeType:string}})=>p.inlineData?.mimeType==='audio/wav');
      const text=audio ? (defect==='transcript'?'다른 음성':await readFile(path.join(dir,'mock-stt',createHash('sha256').update(Buffer.from(audio.inlineData.data,'base64')).digest('hex')),'utf8')) : JSON.stringify({...yes,passed:defect!=='image'});
      return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}));
    };
    const make=()=>createQualityEvidence({key:'fake',infer:async ({text})=>{
      expect(text).toContain('originals'); expect(text).toContain('briefing');
      return {state:'SUCCEEDED',text:JSON.stringify({facts:{...yes,passed:defect!=='facts'},learning:yes})};
    },ledger:h.ledger,cacheDir:path.join(dir,'evidence',defect||'pass'),reference:Buffer.from('fixed reference'),pricing:DEFAULT_QUALITY_PRICING,fetchImpl:fetcher,model:`fake-${defect||'pass'}`});
    await h.drain();
    expect(await h.queue.get(s.jobId), JSON.stringify(await h.queue.stages(s.jobId))).toMatchObject({state:'SUCCEEDED',qualityRegenerationsUsed:0});
    const snap=await h.records.loadById(s.owner,s.interviewId,new Date()); expect(snap?.pipeline.review).toBe('PASSED');
    const stages=await h.queue.stages(s.jobId);
    const results=Object.fromEntries(stages.map(x=>[x.stage,x.result]));
    // Exercise buildVideoRuntime's actual quality wiring on the rendered artifact.
    await symlink(path.join(dir,'work'),path.join(dir,'pipeline'));
    const keyFile=path.join(dir,'fake-key'); await writeFile(keyFile,'fake-test-key',{mode:0o600});
    const proSpy=vi.spyOn(pro,'createProInfer').mockResolvedValue(async()=>({state:'SUCCEEDED',text:JSON.stringify({facts:yes,learning:yes})}));
    vi.stubGlobal('fetch',fetcher);
    const runtime=await buildVideoRuntime({pool,ledger:h.ledger,config:{fileStorageDir:dir} as Config,env:{DAILY_LOG_GEMINI_KEY_FILE:keyFile}});
    await pool.query("DELETE FROM job_quality_reviews WHERE job_id=$1",[s.jobId]);
    await pool.query("UPDATE jobs SET state='RUNNING' WHERE id=$1",[s.jobId]);
    const result=await runtime.handlers.quality!.execute({jobId:s.jobId,subjectId:s.interviewId,stage:'quality',attempt:1,externalRequestId:'test',results,heartbeat:async()=>true,qualityGeneration:0});
    expect(result.result).toMatchObject({passed:true,publishable:true});
    await runtime.close(); proSpy.mockRestore(); vi.stubGlobal('fetch',guard);
    for(const [kind,repair] of [['transcript','narration'],['facts','scene_plan'],['image','assets'],['readability','narration']]) {
      defect=kind!;
      // Distinct input creates distinct provider evidence without bypassing durable replay protection.
      const provider=make();
      h.deps.quality={...provider,assess:async i=>provider.assess({...i,originals:[...i.originals,`case:${defect}`],cues:defect==='readability'?i.cues.map(c=>({...c,fontPx:1})):i.cues})};
      const handler=createVideoHandlers(h.deps).quality!;
      let error:unknown;
      try { await handler.execute({jobId:s.jobId,subjectId:s.interviewId,stage:'quality',attempt:1,externalRequestId:'test',results,heartbeat:async()=>true,qualityGeneration:0}); } catch(e){error=e;}
      expect(error).toBeInstanceOf(QualityRejectedError);
      expect((error as QualityRejectedError).repairStages).toContain(repair);
    }
    expect(guard).not.toHaveBeenCalled();
  } finally {vi.restoreAllMocks();vi.unstubAllGlobals();await pool.end();await db.drop();await rm(dir,{recursive:true,force:true});}
},120000);
