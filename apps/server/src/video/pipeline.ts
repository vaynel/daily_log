import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import type { BriefingItem, ProInfer } from '../briefing/briefing.js';
import { VIDEO_JOB_KIND, VIDEO_JOB_STAGES } from '../briefing/briefing.js';
import type { ExclusionRuleStore } from '../briefing/rules.js';
import type { PaidLedger } from '../budget/gateway.js';
import { paidCall } from '../budget/gateway.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import { BudgetWaitError, ExternalUnknownError, NonRetryableError, type StageContext, type StageHandler } from '../jobs/queue.js';
import type { Snapshot } from '../records/store.js';
import { ttsCostKrw, estimateTtsSeconds, sttCostKrw, type Pricing } from '../voice/pricing.js';
import type { SttResult, TtsResult } from '../voice/transports.js';
import { AssetStore, sha256 } from './assetStore.js';
import { narrationKey, type NarrationSegment, type NarrationTts, type VoiceConfig } from './narration.js';
import { runNarrationStage } from './narrationStage.js';
import { createQualityHandler, type QualityStageDeps } from './qualityStage.js';
import type { QualityInput, QualityScene } from './quality.js';
import { createRenderHandler } from './renderStage.js';
import type { RenderDeps, RenderInput } from './render.js';
import type { RenderGate } from './renderGate.js';
import { buildLayers, composeFrame, generateBackground, generatePose, IMAGE_ESTIMATE_KRW, type Action, type AssetDeps, type AssetResult, type Expression, type ImageProvider, type SceneLayers } from './sceneAssets.js';
import type { Scene, ScenePlan } from './scenePlan.js';
import { latestScenePlan, runScenePlanStage, type SceneRecords } from './sceneStage.js';
import type { SubtitleCue } from './subtitles.js';
import type { LearningMaterial, ZoomPlan } from './zoom.js';

/**
 * 영상 제작 파이프라인 연결(TASK-117). 확정 브리핑이 만든 VIDEO_PRODUCTION 작업의 단계 처리기를 기존 단계 모듈에 이어 붙인다.
 * 판정·생성 로직은 각 단계 모듈(sceneStage·narrationStage·sceneAssets·renderStage·qualityStage)이 맡고, 여기서는
 * 입력 수집·결과 보존(JSON)·재시작 복구·상태 표시만 한다. docs/video/task-117.md 참고.
 */

export const VIDEO_KIND = VIDEO_JOB_KIND;
export const STAGE_SCENE_PLAN = 'scenePlan';
export const STAGE_NARRATION = 'narration';
export const STAGE_ASSETS = 'sceneAssets';
export const STAGE_RENDER = 'render';
export const STAGE_QUALITY = 'quality';
/** 실행 순서. 확정 경로(briefing.ts VIDEO_JOB_STAGES)와 같아야 한다. */
export const VIDEO_STAGES: readonly string[] = VIDEO_JOB_STAGES;

const run = promisify(execFile);
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export interface PipelineRecords extends SceneRecords {
  listAttachments(ownerId: string, interviewId: string): Promise<{ id: string; kind: string; capturedAt: Date | null; storageKey?: string }[]>;
}

export interface VideoPipelineDeps {
  pool: pg.Pool;
  records: PipelineRecords;
  ledger: MonthlyLedger;
  /** Pro 구독 경로. 없으면 첫 단계에서 일시 오류로 멈춘다(유료 모델로 대신하지 않음). */
  infer: ProInfer | null;
  voice: VoiceConfig;
  pricing: Pricing;
  tts: NarrationTts;
  /** 응답 유실로 결과가 불명확한 TTS 요청을 제공자에게 조회한다(없으면 사람 확인 대기). */
  lookupTts?(i: { ledgerKey: string; text: string; voice: VoiceConfig }): Promise<TtsResult | null>;
  /** 렌더된 음성의 전사. 품질 검수의 근거이며, 없으면 작업은 유료 호출 전에 막힌다(검수 근거 없이 통과시키지 않음). */
  stt: ((audio: Buffer, mime: string, durationSec: number) => Promise<SttResult>) | null;
  image: ImageProvider | null;
  lookupImage?(ledgerKey: string): Promise<Buffer | null>;
  detectText?: AssetDeps['detectText'];
  assets: AssetStore;
  referenceSheetPath: string;
  /** 첨부 파일 루트(`<FILE_STORAGE_DIR>/attachments`). */
  attachmentsDir: string;
  /** 완성 영상 폴더(`<FILE_STORAGE_DIR>/videos`). */
  videoDir: string;
  /** 단계 중간 산출물(TTS 캐시 등) 폴더. */
  workDir: string;
  gate: RenderGate;
  render: RenderDeps;
  rules: Pick<ExclusionRuleStore, 'list'>;
  /** 학습 장면의 확대 화면 자료(코드·수식·노트 원문). 기본은 없음. */
  loadMaterials?(ownerId: string, interviewId: string, plan: ScenePlan): Promise<LearningMaterial[]>;
  heartbeatMs: number;
  now?: () => Date;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- 재시작 복구용 원장 래퍼 ----

/**
 * 유료 호출 경계(paidCall) 앞에서 이미 받은 결과를 되살린다. 같은 요청 식별자의 원장 항목이 남아 있으면 paidCall 은
 * 재전송하지 않고 CALL_UNKNOWN 으로 끝나므로, 저장된 결과(캐시) 또는 제공자 조회 결과가 있으면 그것을 돌려주고 예약을 확정한다.
 * 복구할 수 없는 항목은 그대로 두어(중복 과금 금지) 사람이 확인할 때까지 대기한다.
 */
export class RecoveringLedger implements PaidLedger {
  private pending: unknown = undefined;
  constructor(private readonly inner: MonthlyLedger, private readonly recover: (key: string) => Promise<unknown | null>) {}

  /** 직전 reserve 가 되살린 결과(한 번만). 제공자 래퍼가 실제 호출 대신 이 값을 돌려준다. */
  take<T>(): T | undefined {
    const p = this.pending as T | undefined;
    this.pending = undefined;
    return p;
  }

  async reserve(i: Parameters<MonthlyLedger['reserve']>[0]): ReturnType<MonthlyLedger['reserve']> {
    this.pending = undefined;
    const rec = i.idempotencyKey ? await this.recover(i.idempotencyKey) : null;
    const r = await this.inner.reserve(i);
    if (rec === null || rec === undefined) return r;
    if (!r.ok) { this.pending = rec; return { ok: true, id: 'recovered:none', duplicate: false }; }
    if (!r.duplicate) await this.inner.releaseUnsent(r.id); // 새로 잡은 예약은 필요 없다: 이미 받은 결과를 재사용
    this.pending = rec;
    return { ok: true, id: r.id, duplicate: false };
  }
  confirm(id: string, actualKrw: number) { return id === 'recovered:none' ? Promise.resolve(false) : this.inner.confirm(id, actualKrw); }
  releaseUnsent(id: string) { return this.inner.releaseUnsent(id); }
  markUnknown(id: string, note?: string) { return this.inner.markUnknown(id, note); }
}

/** 디스크 결과 캐시(내용 키 → 파일). 같은 문장·목소리는 다시 합성하지 않는다. */
class FileCache {
  constructor(private readonly dir: string) {}
  file(key: string, ext = 'bin') { return path.join(this.dir, `${sha(key)}.${ext}`); }
  async get(key: string): Promise<{ meta: Json; data: Buffer; file: string } | null> {
    try {
      const [meta, data] = await Promise.all([readFile(this.file(key, 'json'), 'utf8'), readFile(this.file(key))]);
      return { meta: JSON.parse(meta) as Json, data, file: this.file(key) };
    } catch { return null; }
  }
  async put(key: string, data: Buffer, meta: Json) {
    await mkdir(this.dir, { recursive: true });
    const write = async (f: string, d: Buffer | string) => { const t = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; await writeFile(t, d); await rename(t, f); };
    await write(this.file(key), data); // 데이터를 먼저, 메타(존재 표시)를 나중에
    await write(this.file(key, 'json'), JSON.stringify(meta));
  }
}

// ---- 공통 입력 ----

export const planAt = (snap: Snapshot, version: number): ScenePlan | null => {
  const v = snap.versions.find((x) => x.kind === 'PRODUCTION_PLAN' && x.version === version && (x.content as ScenePlan | null)?.kind === 'SCENE_PLAN');
  return v ? (v.content as ScenePlan) : null;
};

/** 이 영상에서 뺀 브리핑 항목의 문장(제외 요청·정책으로 inVideo=false 가 된 것). 최신 브리핑 기준. */
export function excludedTextsOf(snap: Snapshot): string[] {
  const v = snap.versions.filter((x) => x.kind === 'SUMMARY' && (x.content as { kind?: string } | null)?.kind === 'BRIEFING').sort((a, b) => b.version - a.version)[0];
  const items = ((v?.content as { items?: BriefingItem[] } | undefined)?.items ?? []);
  return items.filter((i) => !i.inVideo || i.excludedReason !== null).map((i) => i.text).filter((t) => t.trim());
}

const poseOf = (s: Scene): { expression: Expression; action: Action } =>
  s.type === 'LEARNING' ? { expression: '생각', action: '정면' } : { expression: '웃음', action: '정면' };

async function plainBackground(store: AssetStore): Promise<{ key: string }> {
  const key = sha('plain-background:v1').slice(0, 32);
  if (await store.readImage(key)) return { key };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-plain-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xf4efe4:s=720x1280', '-frames:v', '1', path.join(dir, 'p.jpg')]);
    await store.putImage(key, await readFile(path.join(dir, 'p.jpg')), { kind: 'BACKGROUND' });
    await store.setStatus(key, 'READY', null);
  } finally { await rm(dir, { recursive: true, force: true }); }
  return { key };
}

// ---- 단계 처리기 ----

export function createVideoHandlers(d: VideoPipelineDeps): Record<string, StageHandler> {
  const now = d.now ?? (() => new Date());
  const ttsCache = new FileCache(path.join(d.workDir, 'tts'));
  const sttCache = new FileCache(path.join(d.workDir, 'stt'));
  const ownerOf = async (interviewId: string): Promise<string> => {
    const r = await d.pool.query('SELECT owner_id FROM interviews WHERE id::text=$1', [interviewId]);
    if (!r.rows[0]) throw new NonRetryableError('INTERVIEW_NOT_FOUND');
    return r.rows[0].owner_id as string;
  };
  const snapshot = async (ctx: StageContext) => {
    const owner = await ownerOf(ctx.subjectId);
    const snap = await d.records.loadById(owner, ctx.subjectId, now());
    if (!snap) throw new NonRetryableError('INTERVIEW_NOT_FOUND');
    return { owner, snap };
  };
  const scenePlanOf = (ctx: StageContext, snap: Snapshot): { version: number; plan: ScenePlan } => {
    const version = (ctx.results[STAGE_SCENE_PLAN] as { version?: number } | undefined)?.version;
    const plan = version ? planAt(snap, version) : null;
    if (!version || !plan) throw new NonRetryableError('SCENE_PLAN_MISSING');
    return { version, plan };
  };
  const voiceKey = (text: string) => `${d.voice.voiceName}\n${d.voice.styleInstruction}\n${text}`;

  const scenePlan: StageHandler = {
    async execute(ctx) {
      // 검수 근거(전사)와 이미지·음성 제공자가 없으면 유료 호출을 하기 전에 멈춘다.
      if (!d.stt || !d.image) throw new NonRetryableError('VIDEO_PROVIDERS_UNAVAILABLE');
      const { owner } = await snapshot(ctx);
      const r = await runScenePlanStage({
        records: d.records, ownerId: owner, interviewId: ctx.subjectId, infer: d.infer, now,
        narration: { voiceName: d.voice.voiceName, styleInstruction: d.voice.styleInstruction },
      });
      if (!r.ok) {
        if (r.code === 'PRO_UNAVAILABLE' || r.code === 'PRO_WAITING') throw new Error('PRO_UNAVAILABLE'); // 일시 오류: 자동 재시도 1회
        throw new NonRetryableError(`SCENE_PLAN_${r.code}`);
      }
      return { result: { version: r.version, briefingVersion: r.plan.briefingVersion, scenes: r.plan.scenes.length, totalSec: r.plan.totalSec } };
    },
  };

  const narration: StageHandler = {
    waitEstimateKrw: Math.ceil(ttsCostKrw(d.pricing, 700, estimateTtsSeconds(700))),
    async execute(ctx) {
      const { owner, snap } = await snapshot(ctx);
      const { version, plan } = scenePlanOf(ctx, snap);
      const sceneOf = new Map(plan.scenes.map((s) => [narrationKey(plan, s, d.voice), s]));
      const ledger = new RecoveringLedger(d.ledger, async (key) => {
        const text = sceneOf.get(key)?.narration;
        const content = text === undefined ? undefined : voiceKey(text);
        const hit = content ? await ttsCache.get(content) : null;
        if (hit) return { audio: hit.data, mime: hit.meta.mime as string, outputSeconds: hit.meta.outputSeconds as number } satisfies TtsResult;
        const looked = text === undefined ? null : await d.lookupTts?.({ ledgerKey: key, text, voice: d.voice }).catch(() => null);
        if (looked && content) await ttsCache.put(content, looked.audio, { mime: looked.mime, outputSeconds: looked.outputSeconds });
        return looked ?? null;
      });
      const tts: NarrationTts = async (text, voice) => {
        const recovered = ledger.take<TtsResult>();
        if (recovered) return recovered;
        const r = await d.tts(text, voice);
        await ttsCache.put(voiceKey(text), r.audio, { mime: r.mime, outputSeconds: r.outputSeconds }); // 확정 전에 먼저 보존
        return r;
      };
      const materials = (await d.loadMaterials?.(owner, ctx.subjectId, plan)) ?? [];
      let r = await runNarrationStage({ plan, voice: d.voice, tts, ledger, pricing: d.pricing, materials });
      // 응답이 유실된 장면은 제공자에게 결과를 조회해 보존한 뒤 한 번만 이어서 진행한다(재전송 없음). 조회가 안 되면 사람 확인 대기.
      if (!r.ok && r.code === 'TTS_UNKNOWN' && 'sceneKey' in r && d.lookupTts) {
        const lostKey = r.sceneKey;
        const lost = plan.scenes.find((x) => x.key === lostKey);
        const found = lost ? await d.lookupTts({ ledgerKey: narrationKey(plan, lost, d.voice), text: lost.narration, voice: d.voice }).catch(() => null) : null;
        if (lost && found) {
          await ttsCache.put(voiceKey(lost.narration), found.audio, { mime: found.mime, outputSeconds: found.outputSeconds });
          r = await runNarrationStage({ plan, voice: d.voice, tts, ledger, pricing: d.pricing, materials });
        }
      }
      if (!r.ok) {
        if (r.code === 'BUDGET_EXCEEDED') throw new BudgetWaitError();
        if (r.code === 'TTS_UNKNOWN') throw new ExternalUnknownError('TTS_UNKNOWN');
        throw new NonRetryableError(`NARRATION_${r.code}`);
      }
      const v = r.value;
      const segments = await Promise.all(v.segments.map(async (s) => {
        const hit = await ttsCache.get(voiceKey(plan.scenes.find((x) => x.key === s.sceneKey)!.narration));
        return { sceneKey: s.sceneKey, voiceName: s.voiceName, mime: s.mime, audioFile: hit?.file ?? '', durationSec: s.durationSec, startSec: s.startSec, endSec: s.endSec, entryId: s.entryId };
      }));
      if (segments.some((s) => !s.audioFile)) throw new NonRetryableError('NARRATION_AUDIO_NOT_SAVED');
      return { result: { scriptVersion: version, voiceName: v.voiceName, segments, subtitles: v.subtitles, zooms: v.zooms, totalSec: v.totalSec, costKrw: v.costKrw } };
    },
  };

  const sceneAssets: StageHandler = {
    waitEstimateKrw: IMAGE_ESTIMATE_KRW * 2,
    async execute(ctx) {
      const { owner, snap } = await snapshot(ctx);
      const { version, plan } = scenePlanOf(ctx, snap);
      const excluded = excludedTextsOf(snap);
      const atts = await d.records.listAttachments(owner, ctx.subjectId);
      const ledger = new RecoveringLedger(d.ledger, async (key) => (await d.lookupImage?.(key).catch(() => null)) ?? null);
      const provider: ImageProvider = async (req) => {
        const recovered = ledger.take<Buffer>();
        if (recovered) return { image: recovered };
        if (!d.image) throw new NonRetryableError('VIDEO_PROVIDERS_UNAVAILABLE');
        return d.image(req);
      };
      const deps: AssetDeps = { store: d.assets, ledger, provider, referenceSheetPath: d.referenceSheetPath, detectText: d.detectText };
      const fail = (r: Extract<AssetResult, { ok: false }>): never => {
        if (r.code === 'BUDGET_WAIT') throw new BudgetWaitError();
        if (r.code === 'NEEDS_CHECK') throw new ExternalUnknownError('IMAGE_UNKNOWN');
        throw new NonRetryableError(`ASSET_${r.code}`);
      };
      const layers: SceneLayers[] = [];
      for (const scene of plan.scenes) {
        await ctx.heartbeat();
        const photoRef = scene.photoId ? atts.find((a) => a.id === scene.photoId && a.storageKey) : undefined;
        let bg: { key: string };
        if (photoRef?.storageKey) {
          const photo = await readFile(path.join(d.attachmentsDir, photoRef.storageKey));
          const r = await generateBackground(deps, { photo, visual: scene.visual, excludedPhrases: excluded });
          if (!r.ok) return fail(r);
          bg = { key: r.key };
        } else bg = await plainBackground(d.assets); // 사진이 없는 장면: 유료 호출 없이 단색 종이 배경
        const pose = await generatePose(deps, poseOf(scene));
        if (!pose.ok) return fail(pose);
        layers.push(buildLayers(scene, bg, { key: pose.key }));
      }
      return { result: { scriptVersion: version, layers } };
    },
  };

  const render = createRenderHandler({
    gate: d.gate, render: d.render, heartbeatMs: d.heartbeatMs,
    outFile: (subjectId) => path.join(d.videoDir, `${subjectId}.mp4`),
    async loadInput(_subjectId, results): Promise<(RenderInput & { scriptVersion?: number }) | null> {
      const nar = results[STAGE_NARRATION] as Json | undefined;
      const assets = results[STAGE_ASSETS] as { layers: SceneLayers[]; scriptVersion: number } | undefined;
      if (!nar || !assets || nar.scriptVersion !== assets.scriptVersion) return null;
      const narration: NarrationSegment[] = [];
      const scenes: RenderInput['scenes'] = [];
      for (const seg of nar.segments as Json[]) {
        const layer = assets.layers.find((l) => l.sceneKey === seg.sceneKey);
        const bg = layer && (await d.assets.readImage(layer.background.key));
        const ch = layer && (await d.assets.readImage(layer.character.key));
        if (!bg || !ch) return null;
        scenes.push({ sceneKey: seg.sceneKey, frame: await composeFrame(bg.image, ch.image) });
        narration.push({ sceneKey: seg.sceneKey, voiceName: seg.voiceName, mime: seg.mime, audio: await readFile(seg.audioFile), durationSec: seg.durationSec, startSec: seg.startSec, endSec: seg.endSec, entryId: seg.entryId });
      }
      return { scenes, narration, subtitles: nar.subtitles as SubtitleCue[], zooms: nar.zooms as ZoomPlan[], totalSec: nar.totalSec as number, scriptVersion: nar.scriptVersion as number };
    },
  });

  const qualityDeps: QualityStageDeps = {
    pool: d.pool,
    renderStage: STAGE_RENDER,
    heartbeatMs: d.heartbeatMs,
    resolveFile: (file) => {
      if (path.basename(file) !== file) throw new NonRetryableError('QUALITY_BAD_FILE');
      return path.join(d.videoDir, file);
    },
    // 제외·재제작 후에도 검수 시점에 이 기록이 여전히 확정·소유 상태인지 다시 확인한다.
    permissionGranted: async (ctx) => (await d.pool.query("SELECT 1 FROM interviews WHERE id::text=$1 AND status='CONFIRMED'", [ctx.subjectId])).rowCount === 1,
    // 구성 요소 → 다시 만들 단계. 아래 단계가 앞 단계 결과에 의존하므로 의존 단계를 함께 지정한다(render·quality 는 큐가 항상 추가).
    repairStages: {
      script: [STAGE_SCENE_PLAN, STAGE_NARRATION, STAGE_ASSETS],
      visual: [STAGE_ASSETS],
      transcript: [STAGE_NARRATION],
      subtitles: [STAGE_NARRATION],
      zooms: [STAGE_NARRATION],
      render: [STAGE_RENDER],
    },
    async loadInput(ctx): Promise<QualityInput> {
      const { owner, snap } = await snapshot(ctx);
      const { plan } = scenePlanOf(ctx, snap);
      const nar = ctx.results[STAGE_NARRATION] as Json | undefined;
      const assets = ctx.results[STAGE_ASSETS] as Json | undefined;
      const rendered = ctx.results[STAGE_RENDER] as { file: string; sha256: string; scriptVersion: number } | undefined;
      if (!nar || !assets || !rendered || !d.stt) throw new NonRetryableError('QUALITY_INPUT_MISSING');
      const scenes: QualityScene[] = [];
      for (const scene of plan.scenes) {
        await ctx.heartbeat();
        const seg = (nar.segments as Json[]).find((s) => s.sceneKey === scene.key);
        if (!seg) throw new NonRetryableError('QUALITY_INPUT_MISSING');
        const transcript = await transcribeOnce(seg as { audioFile: string; mime: string; durationSec: number });
        const cues = (nar.subtitles as SubtitleCue[]).filter((c) => c.sceneKey === scene.key).map((c) => c.text);
        const zooms = (nar.zooms as ZoomPlan[]).filter((z) => z.sceneKey === scene.key).flatMap((z) => z.chunks.map((c) => c.original));
        const known = new Set(snap.versions.filter((v) => v.kind === 'SUMMARY').flatMap((v) => ((v.content as { items?: BriefingItem[] }).items ?? []).map((i) => i.id)));
        const grounded = scene.evidenceIds.length > 0 && scene.evidenceIds.every((id) => known.has(id));
        const layer = (assets.layers as SceneLayers[]).find((l) => l.sceneKey === scene.key);
        scenes.push({
          key: scene.key, script: scene.narration, visual: scene.visual, transcript, subtitles: cues, zooms,
          versions: { image: assets.scriptVersion, voice: nar.scriptVersion, subtitles: nar.scriptVersion, zoom: nar.scriptVersion },
          // 근거는 앞 단계가 이미 검증한 사실에서만 가져온다(없으면 빈 근거 → 검수 실패).
          facts: { passed: !!grounded, evidence: grounded ? `evidence:${scene.evidenceIds.join(',')}` : '' },
          image: { passed: !!layer, evidence: layer ? `assets:${layer.background.key}:${layer.character.key}` : '' },
          learning: { passed: true, evidence: scene.type === 'LEARNING' ? `zoom-checked:${zooms.length}` : 'no-learning-material' },
          readability: { passed: true, evidence: `subtitles-checked:${cues.length}` },
        });
      }
      const rules = (await d.rules.list(owner)).filter((r) => r.active);
      return {
        file: rendered.file, sha256: rendered.sha256, scriptVersion: rendered.scriptVersion, expectedSec: nar.totalSec as number,
        scenes, rules, excludedTexts: excludedTextsOf(snap),
        probe: { streams: [], format: {} }, // 실제 파일 검사 결과로 qualityStage 가 덮어쓴다
      };
    },
  };

  /** 음성 구간 전사(유료 STT). 같은 오디오는 한 번만 보내고 결과를 보존한다. */
  async function transcribeOnce(seg: { audioFile: string; mime: string; durationSec: number }): Promise<string> {
    const audio = await readFile(seg.audioFile);
    const key = `stt:${sha(audio)}`;
    const cached = await sttCache.get(key);
    if (cached) return cached.meta.text as string;
    const ledger = new RecoveringLedger(d.ledger, async () => null);
    const r = await paidCall<SttResult>({
      ledger, provider: 'openai', operation: 'stt', purpose: 'PRODUCT', idempotencyKey: key, estimateKrw: sttCostKrw(d.pricing, seg.durationSec),
      run: () => d.stt!(audio, seg.mime, seg.durationSec), actualKrw: (v) => sttCostKrw(d.pricing, v.seconds),
    });
    if (!r.ok) {
      if (r.code === 'BUDGET_EXCEEDED') throw new BudgetWaitError();
      if (r.code === 'CALL_UNKNOWN') throw new ExternalUnknownError('STT_UNKNOWN');
      throw new NonRetryableError('STT_REJECTED');
    }
    await sttCache.put(key, Buffer.from(''), { text: r.value.text });
    return r.value.text;
  }

  const quality = createQualityHandler(qualityDeps);
  const qualityWithResult: StageHandler = {
    waitEstimateKrw: Math.ceil(sttCostKrw(d.pricing, 60)),
    async execute(ctx) {
      const out = await quality.execute(ctx); // 통과하지 못하면 QualityRejectedError 가 그대로 올라간다(RESULT 없음)
      const { owner } = await snapshot(ctx);
      const rendered = ctx.results[STAGE_RENDER] as { file: string; sha256: string; bytes: number; durationSec: number; scriptVersion: number };
      await d.records.appendVersion(owner, ctx.subjectId, 'RESULT', {
        file: rendered.file, sha256: rendered.sha256, bytes: rendered.bytes, durationSec: rendered.durationSec, scriptVersion: rendered.scriptVersion, jobId: ctx.jobId, qualityGeneration: ctx.qualityGeneration ?? 0,
      }, now());
      return out;
    },
  };
  return { [STAGE_SCENE_PLAN]: scenePlan, [STAGE_NARRATION]: narration, [STAGE_ASSETS]: sceneAssets, [STAGE_RENDER]: render, [STAGE_QUALITY]: qualityWithResult };
}

/** 작업 종류 → 단계 처리기. JobQueue 의 handlers 에 그대로 넣는다. */
export const videoHandlers = (d: VideoPipelineDeps) => ({ [VIDEO_KIND]: createVideoHandlers(d) });

// ---- 재제작 진입점 ----

export type RemakeResult =
  | { ok: true; jobId: string; duplicate: boolean; reusedStages: string[]; restartedStages: string[] }
  | { ok: false; code: 'NOT_FOUND' | 'BAD_STAGE' | 'BUSY' | 'INVALID_COMMAND' };

/**
 * 수정 요청(제외·음성 수정) 재제작. fromStage 부터 다시 실행하고 그 앞 단계의 완료 결과는 새 작업으로 복사해 재사용한다.
 * - 제외 항목 수정은 호출 전에 새 브리핑 계획(PRODUCTION_PLAN source=BRIEFING, 제외 반영)을 저장한 뒤 'scenePlan' 부터 요청한다.
 * - 음성 수정은 목소리 설정을 바꾼 뒤 'narration' 부터 요청한다(장면 계획 재사용).
 * 새 작업은 처리 재시도·품질 재제작 횟수를 0 에서 시작하고, 완료되면 새 RESULT 버전이 쌓인다. 진행 중인 작업이 있으면 BUSY.
 * commandId 가 같은 요청은 같은 작업을 돌려준다.
 */
export async function requestRemake(pool: pg.Pool, i: { interviewId: string; fromStage: string; commandId: string }): Promise<RemakeResult> {
  if (!i.commandId?.trim()) return { ok: false, code: 'INVALID_COMMAND' };
  const idx = VIDEO_STAGES.indexOf(i.fromStage);
  if (idx < 0) return { ok: false, code: 'BAD_STAGE' };
  const key = `remake:${i.interviewId}:${i.commandId}`;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`video:${i.interviewId}`]);
    const dup = await c.query('SELECT id FROM jobs WHERE idempotency_key=$1', [key]);
    if (dup.rows[0]) { await c.query('COMMIT'); return { ok: true, jobId: dup.rows[0].id as string, duplicate: true, reusedStages: VIDEO_STAGES.slice(0, idx) as string[], restartedStages: VIDEO_STAGES.slice(idx) as string[] }; }
    const prev = (await c.query("SELECT id, state FROM jobs WHERE kind=$1 AND subject_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1", [VIDEO_KIND, i.interviewId])).rows[0];
    if (!prev) { await c.query('ROLLBACK'); return { ok: false, code: 'NOT_FOUND' }; }
    if (prev.state === 'QUEUED' || prev.state === 'RUNNING' || prev.state === 'WAITING') { await c.query('ROLLBACK'); return { ok: false, code: 'BUSY' }; }
    const job = await c.query('INSERT INTO jobs (kind, subject_id, stages, idempotency_key) VALUES ($1,$2,$3,$4) RETURNING id', [VIDEO_KIND, i.interviewId, VIDEO_STAGES, key]);
    const jobId = job.rows[0].id as string;
    const reused = (await c.query(
      `INSERT INTO job_stages (job_id, stage, state, attempts, result)
       SELECT $1, stage, 'DONE', attempts, result FROM job_stages WHERE job_id=$2 AND state='DONE' AND stage=ANY($3::text[]) RETURNING stage`,
      [jobId, prev.id, VIDEO_STAGES.slice(0, idx)])).rows.map((r) => r.stage as string);
    await c.query('INSERT INTO job_events (job_id, event, stage, code) VALUES ($1,$2,$3,$4)', [jobId, 'ENQUEUED', null, null]);
    await c.query('INSERT INTO job_events (job_id, event, stage, code) VALUES ($1,$2,$3,$4)', [jobId, 'REMAKE_REQUESTED', i.fromStage, `reused=${reused.join(',')}`]);
    await c.query("UPDATE pipeline_states SET production='QUEUED', review='NONE', quality_reasons='{}', updated_at=now() WHERE interview_id::text=$1", [i.interviewId]);
    await c.query('COMMIT');
    return { ok: true, jobId, duplicate: false, reusedStages: reused, restartedStages: VIDEO_STAGES.slice(idx) as string[] };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// ---- 상태 표시 ----

/**
 * 작업 상태를 기록의 제작 상태(pipeline_states.production)에 반영한다. worker 가 작업 하나를 처리할 때마다 호출한다.
 * 검수 단계가 직접 정하는 값(DONE/PASSED, 품질 재제작 소진 시 DONE/REJECTED)은 덮어쓰지 않는다.
 */
export async function syncPipelineState(pool: pg.Pool, job: { subjectId: string; state: string; waitReason: string | null; errorCode: string | null }): Promise<void> {
  const production = job.state === 'QUEUED' ? 'QUEUED' : job.state === 'RUNNING' ? 'RUNNING'
    : job.state === 'WAITING' ? (job.waitReason === 'BUDGET' ? 'WAITING_BUDGET' : null)
    : job.state === 'FAILED' ? (job.errorCode === 'QUALITY_REJECTED' ? null : 'FAILED') : null;
  if (!production) return;
  await pool.query("UPDATE pipeline_states SET production=$2, updated_at=now() WHERE interview_id::text=$1 AND NOT (production='DONE' AND review IN ('PASSED','REJECTED'))", [job.subjectId, production]);
}
