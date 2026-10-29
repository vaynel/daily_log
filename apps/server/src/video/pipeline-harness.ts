import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { planOf, videoJobKey, VIDEO_JOB_KIND, VIDEO_JOB_STAGES, type BriefingItem, type ProInfer } from '../briefing/briefing.js';
import { PgRuleStore } from '../briefing/rules.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { RecordStore } from '../records/store.js';
import { DEFAULT_PRICING } from '../voice/pricing.js';
import { AssetStore, sha256 } from './assetStore.js';
import type { VoiceConfig } from './narration.js';
import { RenderGate } from './renderGate.js';
import type { ImageProvider } from './sceneAssets.js';
import type { VideoPipelineDeps } from './pipeline.js';

/**
 * TASK-117 시험·재시작 E2E 전용 모의 제공자 묶음. 실제 유료 API·네트워크를 쓰지 않는다(Pro·TTS·이미지·STT 모두 모의).
 * 제공자 쪽 "청구 기록"은 파일(provider-calls.log)에 남겨 프로세스가 죽어도 남게 하고, 원장 대조에 쓴다.
 * 빌드에 포함되는 이유: scripts/video-pipeline-restart-e2e.mjs 가 빌드 산출물로 자식 프로세스를 띄우기 때문이다(jobs/restart-child.ts 와 같은 방식).
 */

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const REPO_ASSETS = path.resolve(import.meta.dirname, '../../../../assets');

export interface HarnessOptions {
  pool: pg.Pool;
  /** 모의 제공자 기록·산출물 루트. */
  dir: string;
  voice?: Partial<VoiceConfig>;
  /** 첫 Pro 호출을 일시 대기 상태로 응답해 처리 오류 자동 재시도를 일으킨다. */
  proWaitFirst?: boolean;
  /** 음성 인식 결과를 바꿔 검수 실패를 일으킨다(실제 말한 내용 → 인식 결과). */
  sttText?: (spoken: string) => string;
  /** 모의 TTS 가 "제공자 쪽 처리 완료" 를 기록한 뒤, 응답을 돌려주기 전에 호출된다(여기서 멈춘 채 SIGKILL 하면 응답 유실이 된다). */
  afterProviderAccepted?: (text: string) => Promise<void>;
  /** 응답 유실 시 제공자 조회를 허용할지(기본 true). false 면 사람 확인 대기가 되어야 한다. */
  allowLookup?: boolean;
  /** 이미지 제공자(포즈) 응답 직전 훅. */
  beforeImage?: () => Promise<void>;
  /** 원장 기준 시각(월 예산 구분). 기본 2035-06-01. */
  clock?: Date;
  /** 이미지 자산 저장소 위치(운영처럼 여러 작업이 공유). 기본은 dir/assets. */
  assetsDir?: string;
}

export interface Harness {
  deps: VideoPipelineDeps;
  calls: { tts: string[]; image: number; stt: number; pro: number };
  providerCallsLog: string;
  store: RecordStore;
  ledger: MonthlyLedger;
  videoDir: string;
}

export function createHarness(o: HarnessOptions): Harness {
  mkdirSync(o.dir, { recursive: true });
  const providerDir = path.join(o.dir, 'provider');
  mkdirSync(providerDir, { recursive: true });
  const providerCallsLog = path.join(o.dir, 'provider-calls.log');
  const videoDir = path.join(o.dir, 'videos');
  const voice: VoiceConfig = { version: 'test', provider: 'mock', voiceName: 'Achird', styleInstruction: '담담하게 읽는다', ...o.voice };
  const calls = { tts: [] as string[], image: 0, stt: 0, pro: 0 };
  const ledger = new MonthlyLedger(o.pool, { clock: () => o.clock ?? new Date('2035-06-01T00:00:00Z') });
  const store = new RecordStore(o.pool);

  const record = (kind: string, id: string) => appendFileSync(providerCallsLog, `${kind} ${id}\n`);
  const wavFor = (text: string): Buffer => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'dl-h-')), 'a.wav');
    try {
      const sec = Math.max(2, Math.min(20, Math.ceil(text.replace(/\s+/g, '').length / 8)));
      ff(['-f', 'lavfi', '-i', `sine=frequency=${300 + (text.length % 7) * 40}:sample_rate=24000:duration=${sec}`, '-ac', '1', f]);
      return readFileSync(f);
    } finally { rmSync(path.dirname(f), { recursive: true, force: true }); }
  };
  const contentId = (text: string, v: Pick<VoiceConfig, 'voiceName' | 'styleInstruction'>) => sha(`${v.voiceName}\n${v.styleInstruction}\n${text}`);

  const infer: ProInfer = async () => {
    calls.pro++;
    if (o.proWaitFirst && calls.pro === 1) return { state: 'WAIT_LIMIT' };
    // 가장 최근 브리핑 제작 계획(확정/수정 반영)을 그대로 장면으로 만든다(1항목 = 1장면).
    const r = await o.pool.query("SELECT content FROM record_versions WHERE kind='PRODUCTION_PLAN' AND content->>'source'='BRIEFING' ORDER BY created_at DESC, version DESC LIMIT 1");
    const plan = r.rows[0].content as { items: { id: string; text: string }[] };
    return { state: 'SUCCEEDED', text: JSON.stringify(plan.items.map((i) => ({ type: 'DAILY', narration: `${i.text}.`, visual: '책상 앞에 앉은 캐릭터', evidenceIds: [i.id], photoId: null }))) };
  };

  const image: ImageProvider = async (req) => {
    calls.image++;
    await o.beforeImage?.();
    record('IMAGE', sha(req.prompt));
    // 포즈 요청: 기준 시트가 입력으로 오므로 실제 캐릭터 컷 파일을 돌려준다(시트와 다른 파일).
    return { image: readFileSync(path.join(REPO_ASSETS, 'character/poses', req.prompt.includes('생각') ? 'sleepy-front.jpg' : 'smile-front.jpg')) };
  };

  const deps: VideoPipelineDeps = {
    pool: o.pool, records: store, ledger, rules: new PgRuleStore(o.pool), infer, voice, pricing: DEFAULT_PRICING,
    tts: async (text, v) => {
      calls.tts.push(text);
      const id = contentId(text, v);
      const audio = wavFor(text);
      const result = { audio, mime: 'audio/wav', outputSeconds: Math.round((audio.length - 44) / 48000 * 100) / 100 };
      record('TTS', id);
      // 제공자 쪽에서는 처리가 끝났다(과금 발생). 응답이 돌아오기 전에 프로세스가 죽을 수 있다.
      writeFileSync(path.join(providerDir, `${id}.wav`), audio);
      writeFileSync(path.join(providerDir, `${id}.json`), JSON.stringify({ outputSeconds: result.outputSeconds, text }));
      writeFileSync(path.join(providerDir, `spoken-${sha(audio)}.txt`), text);
      await o.afterProviderAccepted?.(text);
      return result;
    },
    lookupTts: o.allowLookup === false ? undefined : async ({ text, voice: v }) => {
      const id = contentId(text, v);
      const meta = path.join(providerDir, `${id}.json`);
      if (!existsSync(meta)) return null;
      return { audio: readFileSync(path.join(providerDir, `${id}.wav`)), mime: 'audio/wav', outputSeconds: (JSON.parse(readFileSync(meta, 'utf8')) as { outputSeconds: number }).outputSeconds };
    },
    stt: async (audio, _mime, sec) => {
      calls.stt++;
      record('STT', sha(audio));
      const spoken = readFileSync(path.join(providerDir, `spoken-${sha(audio)}.txt`), 'utf8');
      return { text: o.sttText ? o.sttText(spoken) : spoken, seconds: sec };
    },
    image,
    assets: new AssetStore(o.assetsDir ?? path.join(o.dir, 'assets')),
    referenceSheetPath: path.join(REPO_ASSETS, 'character/A-ref-v1.jpg'),
    attachmentsDir: path.join(o.dir, 'attachments'),
    videoDir,
    workDir: path.join(o.dir, 'work'),
    gate: new RenderGate(o.pool),
    render: {
      workDir: path.join(o.dir, 'work/render'),
      overlay: async () => {
        const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'dl-ov-')), 'o.png');
        try { ff(['-f', 'lavfi', '-i', 'color=c=0x00000000:s=720x1280,format=rgba', '-frames:v', '1', f]); return readFileSync(f); } finally { rmSync(path.dirname(f), { recursive: true, force: true }); }
      },
    },
    heartbeatMs: 500,
  };
  return { deps, calls, providerCallsLog, store, ledger, videoDir };
}

export const sampleItems = (texts: string[]): BriefingItem[] =>
  texts.map((text, i) => ({ id: `s${i + 1}`, kind: 'FACT', source: 'USER', text, emphasis: false, inVideo: true, excludedReason: null }) as BriefingItem);

/** 인터뷰를 만들고 브리핑을 확정해 제작 작업을 등록한다(실제 RecordStore.confirmBriefing 경로). */
export async function seedConfirmed(store: RecordStore, owner: string, items: BriefingItem[]): Promise<{ interviewId: string; jobId: string }> {
  const now = new Date();
  const { interview } = await store.startInterview(owner, now);
  await store.appendVersion(owner, interview.id, 'SUMMARY', { kind: 'BRIEFING', items, diary: items.map((i) => i.text).join(' ') }, now);
  const r = await store.confirmBriefing(owner, interview.id, { briefingVersion: 1, plan: planOf(items, 1), job: { kind: VIDEO_JOB_KIND, stages: VIDEO_JOB_STAGES, idempotencyKey: videoJobKey(interview.id, 1) } }, now);
  return { interviewId: interview.id, jobId: r.jobId };
}

/**
 * 제외 요청이 반영된 새 브리핑(SUMMARY)과 제작 계획(PRODUCTION_PLAN, source=BRIEFING)을 저장한다.
 * 실제 수정 요청 API(TASK-28 /revisions)가 하는 일의 시험용 대역이다. 이후 requestRemake 로 'scenePlan' 부터 다시 만든다.
 */
export async function reviseBriefing(store: RecordStore, owner: string, interviewId: string, items: BriefingItem[], briefingVersion: number): Promise<void> {
  const now = new Date();
  await store.appendVersion(owner, interviewId, 'SUMMARY', { kind: 'BRIEFING', items, diary: items.filter((i) => i.inVideo).map((i) => i.text).join(' ') }, now);
  await store.appendVersion(owner, interviewId, 'PRODUCTION_PLAN', planOf(items, briefingVersion), now);
}

export { sha256 };
