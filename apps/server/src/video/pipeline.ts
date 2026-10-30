import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import { VIDEO_JOB_KIND, VIDEO_JOB_STAGES, VIDEO_STAGES, type ProductionPlan, type ProInfer } from '../briefing/briefing.js';
import type { ExclusionRule } from '../briefing/rules.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import { BudgetWaitError, ExternalUnknownError, NonRetryableError, PermissionDeniedError, type JobQueue, type StageContext, type StageHandler } from '../jobs/queue.js';
import type { Snapshot } from '../records/store.js';
import type { Pricing } from '../voice/pricing.js';
import type { TtsResult } from '../voice/transports.js';
import { AssetStore } from './assetStore.js';
import { narrationKey, type NarrationCache, type NarrationSegment, type NarrationTts, type VoiceConfig } from './narration.js';
import { runNarrationStage } from './narrationStage.js';
import type { QualityComponent, QualityInput, QualityScene } from './quality.js';
import { createQualityHandler } from './qualityStage.js';
import type { RenderDeps, RenderInput } from './render.js';
import type { RenderGate } from './renderGate.js';
import { createRenderHandler } from './renderStage.js';
import { composeFrame, generateBackground, generatePose, type Action, type AssetDeps, type AssetResult, type Expression, type ImageProvider } from './sceneAssets.js';
import { latestScenePlan, runScenePlanStage, type SceneRecords } from './sceneStage.js';
import type { Scene, ScenePlan } from './scenePlan.js';
import type { SubtitleCue } from './subtitles.js';
import type { LearningMaterial, ZoomPlan } from './zoom.js';

const run = promisify(execFile);

/**
 * 확정 브리핑 → 제작 작업 체인(TASK-117). 단계 이름과 순서는 briefing.ts 의 VIDEO_STAGES 이며, 확정(confirm) 시 등록되는 작업이
 * 이 처리기들로 실행된다. 판정·생성 로직은 기존 모듈(sceneStage/narrationStage/sceneAssets/renderStage/qualityStage)을 그대로 쓰고
 * 여기서는 단계 사이의 입력·산출물 전달, 오류 분류, 제작 상태 표시만 맡는다.
 *
 * 재시작·재제작 원칙
 * - 단계 산출물은 기록 버전(장면 계획)과 작업 폴더(음성·프레임 매니페스트)에 남고, 처리기는 ctx.results 가 아니라 이것을 읽는다.
 *   그래서 수정 요청으로 새로 만든 작업도 앞 단계 결과를 재사용한다(입력이 같으면 유료 호출 0).
 * - 음성은 요청 식별자별로 디스크에 보관하므로 SIGKILL 뒤에도 이미 결제한 장면은 다시 합성·과금하지 않는다.
 *   제공자 응답을 받기 전에 끊긴 요청은 원장에 불명으로 남아 재전송하지 않고 결과 확인 대기(EXTERNAL_RESULT_UNKNOWN)가 된다.
 */

export interface PipelineRecords extends SceneRecords {
  listAttachments(ownerId: string, interviewId: string): Promise<{ id: string; kind: string; capturedAt: Date | null; storageKey: string }[]>;
}

export interface QualityEvidence {
  /** 합성 음성을 전사한다(검수용). 유료라면 호출자가 예산 원장을 거쳐야 한다. */
  transcribe(audio: Buffer, mime: string, sceneKey: string): Promise<string>;
  /** 장면별 사실·그림·학습·가독성 검수 근거. 근거 없는 통과는 만들지 않는다. */
  assess(i: { scene: Scene; frame: Buffer; subtitles: string[]; zooms: string[] }): Promise<Pick<QualityScene, 'facts' | 'image' | 'learning' | 'readability'>>;
}

export interface PipelineDeps {
  pool: pg.Pool;
  records: PipelineRecords;
  ledger: MonthlyLedger;
  pricing: Pricing;
  /** 단계 산출물(음성·프레임·매니페스트·자산 저장소) 루트. */
  workDir: string;
  /** 완성 영상 폴더(`<fileStorageDir>/videos`). */
  videoDir: string;
  /** 매 단계 실행 시점에 평가한다(설정이 나중에 바뀐 음성 수정 요청 반영). */
  infer: () => ProInfer | null;
  voice: () => VoiceConfig;
  tts: NarrationTts;
  image: ImageProvider;
  referenceSheetPath: string;
  loadPhoto(storageKey: string): Promise<Buffer | null>;
  detectText?: AssetDeps['detectText'];
  render: RenderDeps;
  gate: RenderGate;
  rules: { list(ownerId: string): Promise<ExclusionRule[]> };
  /** 없으면 품질 검수는 근거 부족으로 실패한다(통과로 추정하지 않음). */
  quality: QualityEvidence | null;
  /** 음성 보관소 교체 지점(시험이 장면 사이에서 프로세스를 멈출 때 사용). 기본은 디스크 보관소. */
  narrationCache?: (dir: string) => NarrationCache;
  heartbeatMs: number;
  ffmpeg?: string;
  now?: () => Date;
}

const STAGE_RESULT_VERSION = 1;
const PAPER = '0xF1E9D8';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function atomicWrite(file: string, data: Buffer | string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
const readJson = async <T>(file: string): Promise<T | null> => {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
};

interface NarrationManifest {
  v: number;
  scriptVersion: number;
  briefingVersion: number;
  voiceName: string;
  voiceVersion: string;
  segments: (Omit<NarrationSegment, 'audio'> & { key: string })[];
  subtitles: SubtitleCue[];
  zooms: ZoomPlan[];
  totalSec: number;
  costKrw: number;
}
interface AssetsManifest { v: number; scriptVersion: number; frames: { sceneKey: string; file: string; sha256: string; backgroundKey: string | null; poseKey: string }[] }

/** 요청 식별자 키(해시)별 음성 보관소. 파일은 rename 으로 원자적으로 나타난다. */
export function diskNarrationCache(dir: string): NarrationCache {
  const base = (key: string) => path.join(dir, sha(key).slice(0, 40));
  return {
    async get(key) {
      try {
        const meta = JSON.parse(await readFile(`${base(key)}.json`, 'utf8')) as { mime: string; outputSeconds: number; sha256: string };
        const audio = await readFile(`${base(key)}.bin`);
        return sha(audio) === meta.sha256 ? { audio, mime: meta.mime, outputSeconds: meta.outputSeconds } : null;
      } catch { return null; }
    },
    async put(key, r: TtsResult) {
      await atomicWrite(`${base(key)}.bin`, r.audio);
      await atomicWrite(`${base(key)}.json`, JSON.stringify({ mime: r.mime, outputSeconds: r.outputSeconds, sha256: sha(r.audio) }));
    },
  };
}

const withHeartbeat = async <T>(ctx: StageContext, ms: number, fn: () => Promise<T>): Promise<T> => {
  const timer = setInterval(() => { void ctx.heartbeat().catch(() => {}); }, ms);
  try { return await fn(); } finally { clearInterval(timer); }
};

export function createVideoHandlers(d: PipelineDeps): Record<string, StageHandler> {
  const now = d.now ?? (() => new Date());
  const root = (id: string) => path.join(d.workDir, 'interviews', id);
  const cache = (id: string) => (d.narrationCache ?? diskNarrationCache)(path.join(root(id), 'tts'));
  const assetStore = new AssetStore(path.join(d.workDir, 'assets'));
  const generation = (ctx: StageContext) => ctx.qualityGeneration ?? 0;
  const variant = (ctx: StageContext) => (generation(ctx) > 0 ? `q${generation(ctx)}` : '');

  const ownerOf = async (id: string): Promise<string> => {
    const r = await d.pool.query('SELECT owner_id FROM interviews WHERE id::text=$1', [id]);
    if (!r.rows[0]) throw new NonRetryableError('INTERVIEW_NOT_FOUND');
    return r.rows[0].owner_id as string;
  };
  const snapshot = async (id: string): Promise<{ ownerId: string; snap: Snapshot }> => {
    const ownerId = await ownerOf(id);
    const snap = await d.records.loadById(ownerId, id, now());
    if (!snap) throw new NonRetryableError('INTERVIEW_NOT_FOUND');
    return { ownerId, snap };
  };
  const running = (id: string) => d.pool.query("UPDATE pipeline_states SET production='RUNNING', review='PENDING', updated_at=now() WHERE interview_id::text=$1", [id]);
  const currentPlan = (snap: Snapshot) => {
    const sp = latestScenePlan(snap);
    if (!sp) throw new NonRetryableError('SCENE_PLAN_MISSING');
    return sp;
  };
  const briefingOf = (snap: Snapshot, version: number): ProductionPlan | null =>
    (snap.versions.filter((v) => v.kind === 'PRODUCTION_PLAN' && (v.content as ProductionPlan | null)?.source === 'BRIEFING' && (v.content as ProductionPlan).briefingVersion === version)[0]?.content as ProductionPlan | undefined) ?? null;
  /** 영상에서 뺀 항목 원문(검수·이미지 요청 정화용). 가장 최근 확인된 브리핑 기준. */
  const excludedTexts = (snap: Snapshot): string[] => {
    const b = snap.versions.filter((x) => x.kind === 'SUMMARY' && (x.content as { kind?: string } | null)?.kind === 'BRIEFING').sort((a, c) => c.version - a.version)[0];
    const items = ((b?.content as { items?: { text: string; excludedReason: string | null }[] } | undefined)?.items ?? []);
    return items.filter((i) => i.excludedReason).map((i) => i.text);
  };

  // ---- 장면 계획 ----
  const scenePlan: StageHandler = {
    async execute(ctx) {
      const { ownerId } = await snapshot(ctx.subjectId);
      await running(ctx.subjectId);
      const voice = d.voice();
      const r = await runScenePlanStage({
        records: d.records, ownerId, interviewId: ctx.subjectId, infer: d.infer(), now,
        narration: { voiceName: voice.voiceName, styleInstruction: voice.styleInstruction }, regenerate: generation(ctx) > 0,
      });
      if (!r.ok) {
        if (r.code === 'PRO_UNAVAILABLE' || r.code === 'PRO_WAITING') throw new PermissionDeniedError(r.code); // 유료 모델로 전환하지 않고 사람이 풀 때까지 대기
        if (r.code === 'BAD_OUTPUT') throw new Error('SCENE_BAD_OUTPUT'); // 형식 오류: 처리 오류 재시도 1회 한도 안에서만 다시
        throw new NonRetryableError(`SCENE_${r.code}`);
      }
      return { result: { v: STAGE_RESULT_VERSION, scriptVersion: r.version, briefingVersion: r.plan.briefingVersion, reused: r.duplicate } };
    },
  };

  // ---- TTS·자막·확대 ----
  const narration: StageHandler = {
    waitEstimateKrw: 1,
    async execute(ctx) {
      const { snap } = await snapshot(ctx.subjectId);
      await running(ctx.subjectId);
      const sp = currentPlan(snap);
      const voice = d.voice();
      // 음성 수정 요청은 계획의 목소리 설정이 아니라 지금의 voice 설정을 따른다(모든 장면 동일 목소리).
      const plan: ScenePlan = { ...sp.plan, narration: { ...sp.plan.narration, voiceName: voice.voiceName, styleInstruction: voice.styleInstruction } };
      const briefing = briefingOf(snap, sp.plan.briefingVersion);
      const materials: LearningMaterial[] = plan.scenes.filter((s) => s.type === 'LEARNING').map((s) => ({
        sceneKey: s.key, kind: 'NOTE' as const,
        original: s.evidenceIds.map((id) => briefing?.items.find((i) => i.id === id)?.text ?? '').filter(Boolean).join('\n'),
      }));
      const c = cache(ctx.subjectId);
      const v = variant(ctx);
      const before = await Promise.all(plan.scenes.map((s) => c.get(narrationKey(plan, s, voice, v))));
      const r = await withHeartbeat(ctx, d.heartbeatMs, () => runNarrationStage({
        plan, voice, tts: d.tts, ledger: d.ledger, pricing: d.pricing, materials, cache: c, variant: v,
        purpose: ctx.attempt > 1 || generation(ctx) > 0 ? 'RETRY' : 'PRODUCT',
      }));
      if (!r.ok) {
        if (r.code === 'BUDGET_EXCEEDED') throw new BudgetWaitError('BUDGET_EXCEEDED');
        if (r.code === 'TTS_UNKNOWN') throw new ExternalUnknownError('TTS_UNKNOWN');
        if (r.code === 'TTS_EMPTY') throw new Error('TTS_EMPTY'); // 빈 음성은 일시 오류로 보고 1회만 다시
        throw new NonRetryableError(r.code);
      }
      const val = r.value;
      const manifest: NarrationManifest = {
        v: STAGE_RESULT_VERSION, scriptVersion: sp.version, briefingVersion: sp.plan.briefingVersion, voiceName: voice.voiceName, voiceVersion: voice.version,
        segments: val.segments.map((seg) => {
          const { audio, ...meta } = seg; // 음성 바이트는 매니페스트에 넣지 않는다(키로 보관소에서 읽음)
          void audio;
          return { ...meta, key: narrationKey(plan, plan.scenes.find((s) => s.key === seg.sceneKey)!, voice, v) };
        }),
        subtitles: val.subtitles, zooms: val.zooms, totalSec: val.totalSec, costKrw: val.costKrw,
      };
      await atomicWrite(path.join(root(ctx.subjectId), 'narration.json'), JSON.stringify(manifest));
      return { result: { v: STAGE_RESULT_VERSION, scriptVersion: sp.version, voiceName: voice.voiceName, totalSec: val.totalSec, segments: val.segments.length, reused: before.every(Boolean) } };
    },
  };

  // ---- 장면 자산(배경·캐릭터)·프레임 합성 ----
  const plainBackground = async (): Promise<Buffer> => {
    const file = path.join(d.workDir, 'plain-background.jpg');
    try { return await readFile(file); } catch { /* 새로 만든다 */ }
    const tmp = `${file}.${process.pid}.jpg`;
    await mkdir(d.workDir, { recursive: true });
    await run(d.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${PAPER}:s=720x1280`, '-frames:v', '1', '-q:v', '3', tmp]);
    await rename(tmp, file);
    return readFile(file);
  };
  const assets: StageHandler = {
    waitEstimateKrw: 100,
    async execute(ctx) {
      const { ownerId, snap } = await snapshot(ctx.subjectId);
      await running(ctx.subjectId);
      const sp = currentPlan(snap);
      const atts = await d.records.listAttachments(ownerId, ctx.subjectId);
      const excluded = excludedTexts(snap);
      const ad: AssetDeps = { store: assetStore, ledger: d.ledger, provider: d.image, referenceSheetPath: d.referenceSheetPath, ffmpeg: d.ffmpeg, detectText: d.detectText };
      const v = variant(ctx);
      const fail = (r: Extract<AssetResult, { ok: false }>): never => {
        if (r.code === 'BUDGET_WAIT') throw new BudgetWaitError('BUDGET_EXCEEDED');
        if (r.code === 'NEEDS_CHECK') throw new ExternalUnknownError('IMAGE_UNKNOWN');
        if (r.code === 'BAD_IMAGE') throw new Error('IMAGE_BAD'); // 디코드 실패: 일시 오류로 1회만 다시
        throw new NonRetryableError(`ASSET_${r.code}`);
      };
      const frames: AssetsManifest['frames'] = [];
      const poseCache = new Map<string, Extract<AssetResult, { ok: true }>>();
      let paidOrNew = 0;
      await withHeartbeat(ctx, d.heartbeatMs, async () => {
        for (const scene of sp.plan.scenes) {
          let bg: Buffer;
          let backgroundKey: string | null = null;
          const photo = scene.photoId ? atts.find((a) => a.id === scene.photoId) : undefined;
          const bytes = photo ? await d.loadPhoto(photo.storageKey) : null;
          if (bytes) {
            const r = await generateBackground(ad, { photo: bytes, visual: scene.visual, excludedPhrases: excluded, variant: v });
            if (!r.ok) return fail(r);
            if (!r.reused) paidOrNew++;
            bg = r.image; backgroundKey = r.key;
          } else bg = await plainBackground();
          const expression: Expression = scene.type === 'LEARNING' ? '생각' : '웃음';
          const action: Action = scene.type === 'LEARNING' ? '3/4' : '정면';
          const pk = `${expression}/${action}`;
          let pose = poseCache.get(pk);
          if (!pose) {
            const r = await generatePose(ad, { expression, action, variant: v });
            if (!r.ok) return fail(r);
            if (!r.reused) paidOrNew++;
            poseCache.set(pk, pose = r);
          }
          const frame = await composeFrame(bg, pose.image, d.ffmpeg ?? 'ffmpeg');
          const hash = sha(frame);
          await atomicWrite(path.join(root(ctx.subjectId), 'frames', `${hash}.jpg`), frame);
          frames.push({ sceneKey: scene.key, file: `${hash}.jpg`, sha256: hash, backgroundKey, poseKey: pose.key });
          await ctx.heartbeat();
        }
      });
      const manifest: AssetsManifest = { v: STAGE_RESULT_VERSION, scriptVersion: sp.version, frames };
      await atomicWrite(path.join(root(ctx.subjectId), 'assets.json'), JSON.stringify(manifest));
      return { result: { v: STAGE_RESULT_VERSION, scriptVersion: sp.version, frames: frames.length, reused: paidOrNew === 0 } };
    },
  };

  // ---- 렌더 ----
  const render = createRenderHandler({
    gate: d.gate, render: d.render, heartbeatMs: d.heartbeatMs, outFile: (id) => path.join(d.videoDir, `${id}.mp4`),
    async loadInput(subjectId) {
      const n = await readJson<NarrationManifest>(path.join(root(subjectId), 'narration.json'));
      const a = await readJson<AssetsManifest>(path.join(root(subjectId), 'assets.json'));
      if (!n || !a || n.scriptVersion !== a.scriptVersion) return null; // 서로 다른 대본 버전의 산출물은 섞지 않는다
      const c = cache(subjectId);
      const narrationSegs: NarrationSegment[] = [];
      for (const s of n.segments) {
        const audio = await c.get(s.key);
        if (!audio) return null;
        narrationSegs.push({ sceneKey: s.sceneKey, voiceName: s.voiceName, mime: s.mime, durationSec: s.durationSec, startSec: s.startSec, endSec: s.endSec, entryId: s.entryId, audio: audio.audio });
      }
      const scenes = [];
      for (const f of a.frames) scenes.push({ sceneKey: f.sceneKey, frame: await readFile(path.join(root(subjectId), 'frames', f.file)) });
      await mkdir(d.videoDir, { recursive: true });
      const input: RenderInput & { scriptVersion: number } = { scenes, narration: narrationSegs, subtitles: n.subtitles, zooms: n.zooms, totalSec: n.totalSec, scriptVersion: n.scriptVersion };
      return input;
    },
  });

  // ---- 품질 검수 ----
  const REPAIR: Record<QualityComponent, string[]> = {
    script: [VIDEO_STAGES.scenePlan, VIDEO_STAGES.narration, VIDEO_STAGES.assets],
    visual: [VIDEO_STAGES.assets],
    transcript: [VIDEO_STAGES.narration],
    subtitles: [VIDEO_STAGES.narration],
    zooms: [VIDEO_STAGES.narration],
    render: [],
  };
  const emptyProbe = { streams: [], format: {} };
  const qualityBase = createQualityHandler({
    pool: d.pool, heartbeatMs: d.heartbeatMs, repairStages: REPAIR,
    resolveFile: (file) => path.join(d.videoDir, path.basename(file)),
    async permissionGranted(ctx) {
      const r = await d.pool.query("SELECT 1 FROM interviews WHERE id::text=$1 AND status='CONFIRMED'", [ctx.subjectId]);
      return r.rowCount === 1;
    },
    async loadInput(ctx): Promise<QualityInput> {
      if (!d.quality) throw new NonRetryableError('QUALITY_EVIDENCE_UNAVAILABLE');
      const { ownerId, snap } = await snapshot(ctx.subjectId);
      const sp = currentPlan(snap);
      const rendered = ctx.results[VIDEO_STAGES.render] as { file: string; sha256: string; scriptVersion: number } | undefined;
      const n = await readJson<NarrationManifest>(path.join(root(ctx.subjectId), 'narration.json'));
      const a = await readJson<AssetsManifest>(path.join(root(ctx.subjectId), 'assets.json'));
      if (!rendered || !n || !a) throw new NonRetryableError('QUALITY_INPUT_MISSING');
      const c = cache(ctx.subjectId);
      const scenes: QualityScene[] = [];
      for (const scene of sp.plan.scenes) {
        const seg = n.segments.find((s) => s.sceneKey === scene.key);
        const fr = a.frames.find((f) => f.sceneKey === scene.key);
        const audio = seg ? await c.get(seg.key) : null;
        if (!seg || !fr || !audio) throw new NonRetryableError('QUALITY_INPUT_MISSING');
        const subtitles = n.subtitles.filter((s) => s.sceneKey === scene.key).map((s) => s.text);
        const zooms = n.zooms.filter((z) => z.sceneKey === scene.key).flatMap((z) => z.chunks.map((k) => k.original));
        const frame = await readFile(path.join(root(ctx.subjectId), 'frames', fr.file));
        const transcript = await d.quality.transcribe(audio.audio, audio.mime, scene.key);
        const assessed = await d.quality.assess({ scene, frame, subtitles, zooms });
        // 버전은 각 산출물이 실제로 만들어진 대본 버전이다: 낡은 산출물이 섞이면 VERSION_MISMATCH 로 걸린다.
        scenes.push({
          key: scene.key, script: scene.narration, visual: scene.visual, transcript, subtitles, zooms,
          versions: { image: a.scriptVersion, voice: n.scriptVersion, subtitles: n.scriptVersion, zoom: n.scriptVersion }, ...assessed,
        });
      }
      return {
        file: rendered.file, sha256: rendered.sha256, scriptVersion: sp.version, probe: emptyProbe, expectedSec: n.totalSec, scenes,
        rules: await d.rules.list(ownerId), excludedTexts: excludedTexts(snap),
      };
    },
  });
  const quality: StageHandler = {
    async execute(ctx) {
      const out = await qualityBase.execute(ctx);
      // 검수를 통과한 결과만 RESULT 버전이 된다(수정 요청마다 새 버전·새 파일).
      const { ownerId } = await snapshot(ctx.subjectId);
      const rendered = ctx.results[VIDEO_STAGES.render] as { file: string; sha256: string; bytes: number; durationSec: number; scriptVersion: number };
      await d.records.appendVersion(ownerId, ctx.subjectId, 'RESULT', {
        kind: 'VIDEO', file: rendered.file, sha256: rendered.sha256, bytes: rendered.bytes, durationSec: rendered.durationSec,
        scriptVersion: rendered.scriptVersion, jobId: ctx.jobId, qualityGeneration: generation(ctx),
      }, now());
      return out;
    },
  };

  return {
    [VIDEO_STAGES.scenePlan]: scenePlan,
    [VIDEO_STAGES.narration]: narration,
    [VIDEO_STAGES.assets]: assets,
    [VIDEO_STAGES.render]: { ...render, execute: async (ctx) => { await running(ctx.subjectId); return render.execute(ctx); } },
    [VIDEO_STAGES.quality]: quality,
  };
}

/** 작업이 실패·대기로 멈출 때 제작 상태 표시를 맞춘다(JobQueue 의 onStopped). 품질 반려(REVIEW_REJECTED)는 큐가 직접 기록하므로 건드리지 않는다. */
export const pipelineOnStopped = (pool: pg.Pool) => async (job: { kind: string; subjectId: string }, state: 'FAILED' | 'WAITING', _code: string, waitReason: string | null) => {
  if (job.kind !== VIDEO_JOB_KIND) return;
  if (state === 'FAILED') await pool.query("UPDATE pipeline_states SET production='FAILED', updated_at=now() WHERE interview_id::text=$1", [job.subjectId]);
  else if (waitReason === 'BUDGET') await pool.query("UPDATE pipeline_states SET production='WAITING_BUDGET', updated_at=now() WHERE interview_id::text=$1", [job.subjectId]);
};


/**
 * 수정 요청 진입점(TASK-28 의 /revisions 가 호출한다).
 * - kind 'EXCLUDE': 내용 제외. 호출 전에 새 브리핑 계획(PRODUCTION_PLAN, source=BRIEFING)이 기록에 저장돼 있어야 한다.
 *   장면 계획부터 새로 만들고(브리핑 버전이 달라졌으므로) 이후 단계를 다시 실행한다.
 * - kind 'VOICE': 음성 수정. 장면 계획·자산은 입력이 같아 재사용되고 내레이션부터 새로 합성한다.
 * 두 경우 모두 같은 단계 목록(VIDEO_JOB_STAGES)의 새 작업을 만들며, 앞 단계는 산출물이 있으면 `reused:true` 로 끝난다.
 * revisionId 는 사용자 명령 식별자로, 같은 값은 같은 작업을 돌려준다(중복 실행 금지).
 */
export type RevisionKind = 'EXCLUDE' | 'VOICE';
export const revisionJobKey = (interviewId: string, kind: RevisionKind, revisionId: string) => `revise:${interviewId}:${kind}:${revisionId}`;
export async function enqueueRevision(queue: JobQueue, pool: pg.Pool, i: { interviewId: string; kind: RevisionKind; revisionId: string }) {
  if (!i.revisionId.trim()) throw new Error('revisionId 필요');
  const job = await queue.enqueue({ kind: VIDEO_JOB_KIND, subjectId: i.interviewId, stages: VIDEO_JOB_STAGES, idempotencyKey: revisionJobKey(i.interviewId, i.kind, i.revisionId) });
  if (job.state === 'QUEUED') await pool.query("UPDATE pipeline_states SET production='QUEUED', review='PENDING', updated_at=now() WHERE interview_id::text=$1", [i.interviewId]);
  return job;
}
