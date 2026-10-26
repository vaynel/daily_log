import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { estimateTtsSeconds, ttsCostKrw, type Pricing } from '../voice/pricing.js';
import { paidCall } from '../budget/gateway.js';
import type { MonthlyLedger, Purpose } from '../budget/ledger.js';
import { geminiTts, type TtsResult } from '../voice/transports.js';
import { MAX_TOTAL_SEC, type Scene, type ScenePlan } from './scenePlan.js';

/**
 * 내레이션 합성(TASK-24). 목소리·읽기 지시는 저장소 자산 assets/voice/voice.json(TASK-14 선정)만 따른다.
 * 모든 장면이 같은 목소리로 합성되고, 한 장면이라도 실패하면 무음 영상으로 넘어가지 않고 전체를 실패로 돌려준다.
 */

export interface VoiceConfig {
  version: string;
  provider: string;
  voiceName: string;
  styleInstruction: string;
}

export function parseVoiceConfig(raw: string): VoiceConfig {
  const j = JSON.parse(raw) as { version?: unknown; provider?: unknown; primary?: { voiceName?: unknown }; styleInstruction?: unknown };
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const version = s(j.version), provider = s(j.provider), voiceName = s(j.primary?.voiceName), styleInstruction = s(j.styleInstruction);
  if (!version || !provider || !voiceName || !styleInstruction) throw new Error('voice.json 형식이 올바르지 않음');
  return { version, provider, voiceName, styleInstruction };
}

export const loadVoiceConfig = (file: string): VoiceConfig => parseVoiceConfig(readFileSync(file, 'utf8'));

/** 장면 하나를 읽는 합성 함수. 목소리·읽기 지시는 호출자가 고르지 못하고 VoiceConfig 로만 전달된다. */
export type NarrationTts = (text: string, voice: Pick<VoiceConfig, 'voiceName' | 'styleInstruction'>) => Promise<TtsResult>;

/** 지시문과 본문을 구분해 보낸다. "지시문:\n본문" 형식이면 모델이 지시문까지 읽는다. */
export const ttsPrompt = (style: string, text: string): string => `### DIRECTOR'S NOTES\n${style}\n\n### TRANSCRIPT\n${text}`;

/** Gemini TTS 연결. 읽기 지시는 같은 요청의 앞 문장으로 붙인다(실제 호출은 PM 실측 때만, 러너 시험은 모의). */
export function geminiNarrationTts(key: string, fetchImpl: typeof fetch = fetch, model = 'gemini-3.8-flash-tts'): NarrationTts {
  return (text, voice) => geminiTts(key, fetchImpl, model, voice.voiceName)(ttsPrompt(voice.styleInstruction, text));
}

export interface NarrationSegment {
  sceneKey: string;
  voiceName: string;
  mime: string;
  audio: Buffer;
  /** 실제 합성 음성 길이(초). 계획 추정치가 아니다. */
  durationSec: number;
  /** 영상 전체 기준 시작·끝(초). 장면 사이에 PAUSE_SEC 간격을 둔다. */
  startSec: number;
  endSec: number;
  entryId: string;
}

export type NarrationFailure =
  | { ok: false; code: 'VOICE_MISMATCH' | 'NO_SCENES' | 'OVER_MAX_SEC' }
  | { ok: false; code: 'BUDGET_EXCEEDED' | 'TTS_FAILED' | 'TTS_UNKNOWN' | 'TTS_EMPTY'; sceneKey: string };
export type NarrationResult = { ok: true; segments: NarrationSegment[]; totalSec: number; costKrw: number } | NarrationFailure;

export const PAUSE_SEC = 0.5;

/** 길이 0·빈 오디오·완전 무음 PCM(WAV)은 실패로 본다. 무음 정상 영상 방지(AC-5). */
export function isSilent(r: TtsResult): boolean {
  if (!r.audio || r.audio.length <= 44 || !(r.outputSeconds > 0)) return true;
  if (r.mime === 'audio/wav') {
    for (let i = 44; i + 1 < r.audio.length; i += 2) if (r.audio.readInt16LE(i) !== 0) return false;
    return true;
  }
  return false;
}

const keyOf = (plan: ScenePlan, s: Scene, voice: VoiceConfig) =>
  `narr:${plan.lifeDate}:${plan.briefingVersion}:${s.key}:${createHash('sha256').update(`${voice.voiceName}\n${voice.styleInstruction}\n${s.narration}`).digest('hex').slice(0, 16)}`;

export async function synthesizeNarration(i: {
  plan: ScenePlan; voice: VoiceConfig; tts: NarrationTts; ledger: MonthlyLedger; pricing: Pricing; purpose?: Purpose; maxTotalSec?: number;
}): Promise<NarrationResult> {
  const { plan, voice } = i;
  if (!plan.scenes.length) return { ok: false, code: 'NO_SCENES' };
  // 계획이 다른 목소리로 만들어졌으면 섞이지 않게 합성 전에 멈춘다. 예비 목소리로 자동 대체하지 않는다.
  if (plan.narration.voiceName !== voice.voiceName) return { ok: false, code: 'VOICE_MISMATCH' };
  const segments: NarrationSegment[] = [];
  let cursor = 0, cost = 0;
  for (const s of plan.scenes) {
    const chars = s.narration.replace(/\s+/g, '').length;
    const r = await paidCall<TtsResult>({
      ledger: i.ledger, provider: 'gemini', operation: 'tts', purpose: i.purpose ?? 'PRODUCT', idempotencyKey: keyOf(plan, s, voice),
      estimateKrw: ttsCostKrw(i.pricing, chars, estimateTtsSeconds(chars)),
      run: () => i.tts(s.narration, voice),
      actualKrw: (v) => ttsCostKrw(i.pricing, chars, v.outputSeconds),
    });
    if (!r.ok) {
      if (r.code === 'BUDGET_EXCEEDED') return { ok: false, code: 'BUDGET_EXCEEDED', sceneKey: s.key };
      return { ok: false, code: r.code === 'CALL_UNKNOWN' ? 'TTS_UNKNOWN' : 'TTS_FAILED', sceneKey: s.key };
    }
    if (isSilent(r.value)) return { ok: false, code: 'TTS_EMPTY', sceneKey: s.key };
    cost += r.actualKrw;
    const durationSec = Math.round(r.value.outputSeconds * 100) / 100;
    segments.push({ sceneKey: s.key, voiceName: voice.voiceName, mime: r.value.mime, audio: r.value.audio, durationSec, startSec: round2(cursor), endSec: round2(cursor + durationSec), entryId: r.entryId });
    cursor += durationSec + PAUSE_SEC;
  }
  const totalSec = round2(cursor - PAUSE_SEC);
  // TASK-21 의 길이는 추정이었다. 실제 합성 길이가 180초를 넘으면 완료로 두지 않는다.
  if (totalSec > (i.maxTotalSec ?? MAX_TOTAL_SEC)) return { ok: false, code: 'OVER_MAX_SEC' };
  return { ok: true, segments, totalSec, costKrw: Math.round(cost * 100) / 100 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
