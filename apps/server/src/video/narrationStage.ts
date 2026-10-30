import type { MonthlyLedger, Purpose } from '../budget/ledger.js';
import type { Pricing } from '../voice/pricing.js';
import { synthesizeNarration, type NarrationCache, type NarrationFailure, type NarrationSegment, type NarrationTts, type VoiceConfig } from './narration.js';
import type { ScenePlan } from './scenePlan.js';
import { buildSubtitles, checkSubtitles, type SubtitleCue, type SubtitleIssue } from './subtitles.js';
import { planZoom, type LearningMaterial, type ZoomPlan } from './zoom.js';

export interface NarratedScenes {
  voiceName: string;
  segments: NarrationSegment[];
  subtitles: SubtitleCue[];
  zooms: ZoomPlan[];
  totalSec: number;
  costKrw: number;
}

export type NarrationStageResult =
  | { ok: true; value: NarratedScenes }
  | NarrationFailure
  | { ok: false; code: 'ZOOM_FAILED'; sceneKey: string; detail: string }
  | { ok: false; code: 'SUBTITLE_INVALID'; issues: SubtitleIssue[] };

/**
 * 장면 계획 → 내레이션 음성·구간 시간 → 자막 → 학습 확대 화면.
 * 음성이 하나라도 만들어지지 않으면 ok:false 로 끝나며, 자막·확대만 있는 무음 결과는 만들지 않는다(AC-5).
 * 학습 자료(materials)는 장면 근거가 된 확정 기록의 코드·수식·노트 원문이다.
 */
export async function runNarrationStage(i: {
  plan: ScenePlan; voice: VoiceConfig; tts: NarrationTts; ledger: MonthlyLedger; pricing: Pricing; materials?: LearningMaterial[]; cache?: NarrationCache; purpose?: Purpose; variant?: string;
}): Promise<NarrationStageResult> {
  const syn = await synthesizeNarration(i);
  if (!syn.ok) return syn;
  const materialOf = new Map((i.materials ?? []).map((m) => [m.sceneKey, m]));
  const subtitles: SubtitleCue[] = [];
  const zooms: ZoomPlan[] = [];
  for (const scene of i.plan.scenes) {
    const seg = syn.segments.find((s) => s.sceneKey === scene.key)!;
    const mat = scene.type === 'LEARNING' ? materialOf.get(scene.key) : undefined;
    subtitles.push(...buildSubtitles(scene, seg, mat?.original ?? null));
    if (mat) {
      const z = planZoom(mat, seg);
      if (!z.ok) return { ok: false, code: 'ZOOM_FAILED', sceneKey: scene.key, detail: z.code };
      zooms.push(z.plan);
    }
  }
  const issues = checkSubtitles(subtitles, i.plan.scenes, syn.segments);
  if (issues.length) return { ok: false, code: 'SUBTITLE_INVALID', issues };
  return { ok: true, value: { voiceName: i.voice.voiceName, segments: syn.segments, subtitles, zooms, totalSec: syn.totalSec, costKrw: syn.costKrw } };
}
