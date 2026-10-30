import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { planOf, VIDEO_JOB_KIND, VIDEO_JOB_STAGES, videoJobKey, type BriefingItem, type ProInfer } from '../briefing/briefing.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { JobQueue, type JobRow } from '../jobs/queue.js';
import { RecordStore } from '../records/store.js';
import { DEFAULT_PRICING } from '../voice/pricing.js';
import type { VoiceConfig } from './narration.js';
import type { OverlayRenderer } from './overlay.js';
import { createVideoHandlers, pipelineOnStopped, type PipelineDeps, type QualityEvidence } from './pipeline.js';
import { RenderGate } from './renderGate.js';
import type { ImageProvider } from './sceneAssets.js';

/**
 * 제작 파이프라인 시험용 모의 제공자 묶음(실제 Gemini·Pro·STT 호출 없음, 키 없음).
 * 시험(pipeline.test.ts)과 SIGKILL 재시작 자식 프로세스(pipeline-restart-child.ts)가 함께 쓰므로 빌드 산출물에 포함한다.
 * 모든 모의 호출은 calls 에 기록돼 "유료 호출 수 = 원장 항목 수" 대조에 쓴다.
 */

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-threads', '2', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const HARNESS_CLOCK = () => new Date('2035-06-15T03:00:00Z');
export const OWNER = 'harness-owner';
export const LIFE_DATE = '2035-06-15';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'pipeline-harness-'));
let seq = 0;
function lavfi(filter: string, ext: string, extra: string[] = []): Buffer {
  const out = path.join(scratch, `m${++seq}.${ext}`);
  ff(['-f', 'lavfi', '-i', filter, ...extra, out]);
  return readFileSync(out);
}
const wavCache = new Map<string, Buffer>();
export const mockWav = (sec: number, hz = 330): Buffer => {
  const k = `${sec}:${hz}`;
  if (!wavCache.has(k)) wavCache.set(k, lavfi(`sine=frequency=${hz}:sample_rate=24000:duration=${sec}`, 'wav', ['-ac', '1']));
  return wavCache.get(k)!;
};
/** 회색 바탕(색은 시드로 달라짐) 위에 검은 윤곽·흰 몸의 캐릭터 대역. */
const characterJpeg = (seed: string): Buffer => {
  const h = sha(seed).slice(0, 6);
  return lavfi(`color=c=0x${h}:s=540x960,drawbox=x=170:y=300:w=200:h=500:color=black:t=fill,drawbox=x=180:y=310:w=180:h=480:color=white:t=fill`, 'jpg', ['-frames:v', '1', '-q:v', '2']);
};
export const photoJpeg = (): Buffer => lavfi('testsrc2=s=640x480:d=1', 'jpg', ['-frames:v', '1']);
let overlayPng: Buffer | null = null;
const mockOverlay = (calls: { n: number }, delayMs: () => number): OverlayRenderer => async () => {
  calls.n++;
  const d = delayMs();
  if (d) await new Promise((r) => setTimeout(r, d));
  overlayPng ??= lavfi('color=c=0xff000080:s=720x1280,format=rgba', 'png', ['-frames:v', '1']);
  return overlayPng;
};

export interface HarnessOptions {
  pool: pg.Pool;
  dir: string;
  /** 모의 Pro 응답을 실패시키는 훅(null 이면 정상). */
  voice?: VoiceConfig;
  /** 장면 검수 근거: false 를 돌려주면 사실 검수가 실패한다(품질 재제작 시험용). */
  factsPass?: () => boolean;
  /** 렌더 오버레이 지연(ms). SIGKILL 시험이 렌더 도중 프로세스를 끊기 위해 쓴다. */
  overlayDelayMs?: () => number;
  /** 단계 시작 알림(자식 프로세스 신호용). */
  onTts?: (text: string, n: number) => void | Promise<void>;
  /** 모의 TTS 오류 주입: 던지면 해당 호출이 실패한다. */
  ttsFault?: (n: number) => Error | null;
  leaseMs?: number;
  heartbeatMs?: number;
  ledgerLimitKrw?: number;
}

export const DEFAULT_VOICE: VoiceConfig = { version: 'mock-1', provider: 'mock', voiceName: 'Achird', styleInstruction: '담담한 1인칭 독백.' };

export function createHarness(o: HarnessOptions) {
  const calls = { infer: 0, tts: [] as { text: string; voice: string }[], image: 0, overlay: { n: 0 }, stt: 0, assess: 0 };
  const audioText = new Map<string, string>();
  let voice = o.voice ?? DEFAULT_VOICE;

  const infer: ProInfer = async ({ text }) => {
    calls.infer++;
    const items = [...text.matchAll(/^- (s\d+)( \[강조\])?: (.+)$/gm)];
    const photoSection = text.split('[사진]')[1] ?? '';
    const photo = /^- (\S+)$/m.exec(photoSection)?.[1];
    const drafts = items.map((m, n) => ({
      type: n === 1 ? 'LEARNING' : 'DAILY', narration: m[3]!, visual: `장면 ${n + 1}의 색연필 스케치`, evidenceIds: [m[1]!], photoId: n === 0 && photo && photo !== '없음' ? photo : null,
    }));
    return { state: 'SUCCEEDED', text: JSON.stringify(drafts) };
  };
  const tts: PipelineDeps['tts'] = async (text, v) => {
    const n = calls.tts.push({ text, voice: v.voiceName });
    await o.onTts?.(text, n);
    const err = o.ttsFault?.(n);
    if (err) throw err;
    const sec = Math.max(1, Math.round((text.replace(/\s+/g, '').length / 6) * 10) / 10);
    // 문장마다 다른 주파수라 음성 바이트가 문장을 식별한다(모의 전사용).
    const audio = mockWav(sec, 200 + (parseInt(sha(text).slice(0, 4), 16) % 600) + (v.voiceName === DEFAULT_VOICE.voiceName ? 0 : 1000));
    audioText.set(sha(audio), text);
    return { audio, mime: 'audio/wav', outputSeconds: sec };
  };
  const image: ImageProvider = async (req) => {
    calls.image++;
    return { image: characterJpeg(`${req.prompt}:${calls.image}`) };
  };
  const quality: QualityEvidence = {
    // 전사는 합성 요청에 쓰인 문장 그대로(모의). 실제 STT 가 아니다.
    async transcribe(audio) { calls.stt++; return audioText.get(sha(audio)) ?? ''; },
    async assess() {
      calls.assess++;
      const ok = o.factsPass?.() ?? true;
      return {
        facts: { passed: ok, evidence: ok ? '모의 사실 대조 통과' : '모의 사실 대조 실패' },
        image: { passed: true, evidence: '모의 그림 검수' }, learning: { passed: true, evidence: '모의 학습 원문 대조' }, readability: { passed: true, evidence: '모의 가독성' },
      };
    },
  };
  const ledger = new MonthlyLedger(o.pool, { clock: HARNESS_CLOCK, ...(o.ledgerLimitKrw ? { limitKrw: o.ledgerLimitKrw } : {}) });
  const records = new RecordStore(o.pool);
  const photo = photoJpeg();
  const repo = path.resolve(import.meta.dirname, '../../../../assets');
  const deps: PipelineDeps = {
    pool: o.pool, records, ledger, pricing: DEFAULT_PRICING,
    workDir: path.join(o.dir, 'work'), videoDir: path.join(o.dir, 'videos'),
    infer: () => infer, voice: () => voice, tts, image,
    referenceSheetPath: path.join(repo, 'character/A-ref-v1.jpg'),
    loadPhoto: async () => photo,
    render: { overlay: mockOverlay(calls.overlay, () => o.overlayDelayMs?.() ?? 0), workDir: path.join(o.dir, 'render-work') },
    gate: new RenderGate(o.pool),
    rules: { list: async () => [] },
    quality, heartbeatMs: Math.max(50, Math.floor((o.leaseMs ?? 60_000) / 3)), now: HARNESS_CLOCK,
  };
  const handlers = createVideoHandlers(deps);
  const queue = new JobQueue({ pool: o.pool, ledger, handlers: { [VIDEO_JOB_KIND]: handlers }, onStopped: pipelineOnStopped(o.pool), leaseMs: o.leaseMs });
  mkdirSync(deps.videoDir, { recursive: true });
  return {
    deps, queue, ledger, records, calls,
    setVoice(v: VoiceConfig) { voice = v; },
    /** 대기열이 빌 때까지 처리. */
    async drain(max = 40): Promise<JobRow[]> {
      const out: JobRow[] = [];
      for (let i = 0; i < max; i++) { const j = await queue.tick(); if (!j) break; out.push(j); }
      return out;
    },
  };
}

export interface SeedItem { text: string; emphasis?: boolean }

/** 확정된 브리핑 1건을 만든다(실제 confirmBriefing 경로: 확정·계획·QUEUED·작업 등록이 한 트랜잭션). */
export async function seedConfirmedBriefing(
  h: { records: RecordStore }, pool: pg.Pool, texts: SeedItem[], o: { withPhoto?: boolean; owner?: string; lifeDate?: string } = {},
) {
  const owner = o.owner ?? OWNER;
  const now = HARNESS_CLOCK();
  const { interview } = await h.records.startInterview(owner, now, o.lifeDate ?? LIFE_DATE);
  if (o.withPhoto) {
    await h.records.saveFileAttachment(owner, interview.id, 'photo-1', {
      storageKey: 'harness-photo.jpg', checksum: sha('harness-photo'), kind: 'PHOTO', name: 'p.jpg', mime: 'image/jpeg', size: 10,
      capturedAt: new Date(`${o.lifeDate ?? LIFE_DATE}T01:00:00Z`), capturedSource: 'EXIF',
    }, now);
  }
  const items: BriefingItem[] = texts.map((t, i) => ({ id: `s${i + 1}`, kind: 'FACT', source: 'USER', text: t.text, emphasis: !!t.emphasis, inVideo: true, excludedReason: null }));
  await h.records.appendVersion(owner, interview.id, 'SUMMARY', { kind: 'BRIEFING', items, diary: texts.map((t) => t.text).join(' ') }, now);
  const plan = planOf(items, 1);
  const r = await h.records.confirmBriefing(owner, interview.id, { briefingVersion: 1, plan, job: { kind: VIDEO_JOB_KIND, stages: VIDEO_JOB_STAGES, idempotencyKey: videoJobKey(interview.id, 1) } }, now);
  return { interviewId: interview.id, jobId: r.jobId, owner };
}

/**
 * 사용자가 항목을 뺀 새 브리핑을 확인한 상황을 만든다(TASK-28 의 /revisions 가 하는 일의 기록 쪽 절반).
 * 새 SUMMARY(제외 표시)와 새 BRIEFING 제작 계획(briefingVersion+1)만 저장하고 작업은 만들지 않는다.
 */
export async function recordExclusion(h: { records: RecordStore }, interviewId: string, texts: SeedItem[], excludeIndex: number, o: { owner?: string } = {}) {
  const owner = o.owner ?? OWNER;
  const now = HARNESS_CLOCK();
  const items: BriefingItem[] = texts.map((t, i) => ({
    id: `s${i + 1}`, kind: 'FACT', source: 'USER', text: t.text, emphasis: !!t.emphasis, inVideo: i !== excludeIndex, excludedReason: i === excludeIndex ? 'USER' : null,
  }));
  const v = await h.records.appendVersion(owner, interviewId, 'SUMMARY', { kind: 'BRIEFING', items, diary: '' }, now);
  await h.records.appendVersion(owner, interviewId, 'PRODUCTION_PLAN', planOf(items, v.version), now);
  return v.version;
}

export function writeHarnessPhoto(fileStorageDir: string) {
  mkdirSync(path.join(fileStorageDir, 'attachments'), { recursive: true });
  writeFileSync(path.join(fileStorageDir, 'attachments', 'harness-photo.jpg'), photoJpeg());
}
