import type { ProductionPlan, ProInfer } from '../briefing/briefing.js';

/**
 * 영상 대본·장면 계획(TASK-21). 입력은 사용자가 확인한 브리핑의 제작 계획(ProductionPlan)뿐이다.
 * 장면마다 근거 항목 id·시각 상태·예상 길이를 남기고, 근거 없는 문장·확인할 수 없는 시각·분량 채우기를 거절한다.
 * 이미지 생성·합성은 이 단계의 범위가 아니다(TASK-23~25).
 */

export const MAX_TOTAL_SEC = 180;
export const MIN_SCENE_SEC = 3;
const SCENE_PAUSE_SEC = 0.5;

/** 목소리·말투는 설정값이다(TASK-14 선정: 캐릭터 A, Achird, 담담한 1인칭 독백). */
export interface NarrationConfig {
  character: string;
  voiceName: string;
  styleInstruction: string;
  /** 초당 한국어 글자 수(공백 제외) 추정치. 실제 합성 길이는 TASK-24 에서 다시 잰다. */
  charsPerSecond: number;
}
export const DEFAULT_NARRATION: NarrationConfig = {
  character: 'A',
  voiceName: 'Achird',
  styleInstruction: '담담한 1인칭 독백. 과장하거나 감탄하지 않고 하루를 일기처럼 조용히 말한다.',
  charsPerSecond: 5,
};

export interface PhotoRef {
  id: string;
  /** 촬영 시각(EXIF). 없으면 null — 업로드 시각으로 대신하지 않는다. */
  capturedAt: Date | null;
}

export type TimeStatus = 'CONFIRMED' | 'UNKNOWN' | 'CONFLICT' | 'NONE';

export interface Scene {
  key: string;
  order: number;
  type: 'DAILY' | 'LEARNING';
  narration: string;
  visual: string;
  /** 확정 기록(브리핑 항목) 근거 id. 비어 있을 수 없다. */
  evidenceIds: string[];
  photoId: string | null;
  /** NONE=사진 없음, CONFIRMED=촬영 시각이 그날과 맞음, UNKNOWN=촬영 시각 없음, CONFLICT=그날이 아니거나 말한 순서와 어긋남. */
  timeStatus: TimeStatus;
  /** CONFIRMED 가 아니면 시각을 확정해서 말하지 않았다는 표시. */
  estimated: boolean;
  emphasis: boolean;
  estimatedSec: number;
}

export interface ScenePlan {
  kind: 'SCENE_PLAN';
  briefingVersion: number;
  lifeDate: string;
  narration: NarrationConfig;
  scenes: Scene[];
  totalSec: number;
  maxTotalSec: number;
  /** 180초 초과로 합성 전에 줄인 내역. 줄이지 않았으면 null. */
  condensed: { reason: 'OVER_MAX_SEC'; beforeSec: number; droppedKeys: string[]; truncatedKeys: string[] } | null;
  /** 근거가 적어 3분보다 짧게 둔 경우 true. 허구로 채우지 않았다는 뜻이다. */
  shortRecord: boolean;
}

export const estimateSec = (text: string, cps: number): number =>
  Math.max(MIN_SCENE_SEC, Math.ceil((text.replace(/\s+/g, '').length / cps) * 10) / 10 + SCENE_PAUSE_SEC);

// ---- 모델 출력 검증 ----

const TIME_WORDS = /(?:새벽|아침|오전|점심|정오|오후|저녁|밤|자정|\d{1,2}\s*시|\d{1,2}\s*:\s*\d{2})/g;
/** 근거 글자 수 대비 대사 길이 상한. 적은 기록을 늘려 쓴 대사를 거절한다. */
const MAX_NARRATION_RATIO = 3;
const MAX_NARRATION_EXTRA = 30;

export type SceneDraft = { type: 'DAILY' | 'LEARNING'; narration: string; visual: string; evidenceIds: string[]; photoId: string | null };

export type DraftError = 'NOT_JSON' | 'BAD_SHAPE' | 'NO_EVIDENCE' | 'UNKNOWN_EVIDENCE' | 'UNKNOWN_PHOTO' | 'UNVERIFIED_TIME' | 'PADDED' | 'EMPTY';

export function parseDrafts(raw: string, plan: ProductionPlan, photos: PhotoRef[]): { ok: true; drafts: SceneDraft[] } | { ok: false; code: DraftError; index?: number } {
  let v: unknown;
  try { v = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, code: 'NOT_JSON' }; }
  if (!Array.isArray(v)) return { ok: false, code: 'BAD_SHAPE' };
  if (!v.length) return { ok: false, code: 'EMPTY' };
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const photoIds = new Set(photos.map((p) => p.id));
  const out: SceneDraft[] = [];
  for (const [index, e] of v.entries()) {
    const d = e as Record<string, unknown> | null;
    const narration = typeof d?.narration === 'string' ? d.narration.replace(/\s+/g, ' ').trim() : '';
    const visual = typeof d?.visual === 'string' ? d.visual.replace(/\s+/g, ' ').trim() : '';
    if (!d || !narration || !visual || (d.type !== 'DAILY' && d.type !== 'LEARNING') || !Array.isArray(d.evidenceIds) || d.evidenceIds.some((x) => typeof x !== 'string')
      || (d.photoId != null && typeof d.photoId !== 'string')) return { ok: false, code: 'BAD_SHAPE', index };
    const ids = [...new Set(d.evidenceIds as string[])];
    if (!ids.length) return { ok: false, code: 'NO_EVIDENCE', index };
    if (ids.some((id) => !byId.has(id))) return { ok: false, code: 'UNKNOWN_EVIDENCE', index };
    const photoId = (d.photoId as string | null | undefined) ?? null;
    if (photoId !== null && !photoIds.has(photoId)) return { ok: false, code: 'UNKNOWN_PHOTO', index };
    const source = ids.map((id) => byId.get(id)!.text).join(' ');
    // 근거 문장에 없는 시각 표현은 확정할 수 없다(촬영 시각 없음·충돌 포함, 시각을 지어내지 않는다).
    const allowed = new Set(source.match(TIME_WORDS) ?? []);
    if ((narration.match(TIME_WORDS) ?? []).some((t) => !allowed.has(t))) return { ok: false, code: 'UNVERIFIED_TIME', index };
    if (narration.replace(/\s+/g, '').length > source.replace(/\s+/g, '').length * MAX_NARRATION_RATIO + MAX_NARRATION_EXTRA) return { ok: false, code: 'PADDED', index };
    out.push({ type: d.type, narration, visual, evidenceIds: ids, photoId });
  }
  return { ok: true, drafts: out };
}

export function scenePrompt(plan: ProductionPlan, photos: PhotoRef[], cfg: NarrationConfig): string {
  const items = plan.items.map((i) => `- ${i.id}${i.emphasis ? ' [강조]' : ''}: ${i.text}`).join('\n');
  const ph = photos.length ? photos.map((p) => `- ${p.id}`).join('\n') : '없음';
  return [
    `하루 일기 영상의 대본과 장면 계획을 만드세요. 화자는 캐릭터 ${cfg.character} 이고 말투는 다음과 같습니다: ${cfg.styleInstruction}`,
    '아래 [확정 기록]의 문장만 근거로 쓰세요. 기록에 없는 사실·감정·시각·장소를 만들지 말고, 분량을 채우려고 내용을 늘리지 마세요. 기록이 적으면 장면도 적게 만드세요.',
    '개발·학습은 하루의 한 부분으로 다루고, 학습을 길게 확대하는 장면은 type "LEARNING", 나머지는 "DAILY" 로 구분하세요. 사용자가 [강조]한 내용을 먼저 다루세요.',
    '시각(아침·저녁·몇 시 등)은 기록 문장에 있을 때만 말하세요. 사진 촬영 시각은 알려 주지 않으며 대사에 쓰지 않습니다.',
    `전체 대사는 ${MAX_TOTAL_SEC}초(약 ${Math.floor(MAX_TOTAL_SEC * cfg.charsPerSecond)}자) 안이어야 합니다.`,
    'JSON 배열로만 답하세요. 각 장면: {"type":"DAILY|LEARNING","narration":"1인칭 대사","visual":"글자 없는 색연필 스케치 장면 설명","evidenceIds":["근거 id"],"photoId":"사진 id 또는 null"}. evidenceIds 는 비울 수 없습니다.',
    `[확정 기록]\n${items}`,
    `[사진]\n${ph}`,
  ].join('\n\n');
}

// ---- 시각 상태 ----

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const kstDate = (d: Date) => KST_DATE.format(d);

/** 장면 순서는 말한 순서(근거 항목 순서)를 따른다. 사진 촬영 시각은 그날과 맞고 말한 순서와 어긋나지 않을 때만 확정으로 본다. */
export function assignTime(drafts: SceneDraft[], plan: ProductionPlan, photos: PhotoRef[], lifeDate: string): { draft: SceneDraft; timeStatus: TimeStatus; emphasis: boolean }[] {
  const idx = new Map(plan.items.map((it, n) => [it.id, n]));
  const photoOf = new Map(photos.map((p) => [p.id, p]));
  const ordered = drafts
    .map((draft, n) => ({ draft, n, pos: Math.min(...draft.evidenceIds.map((id) => idx.get(id)!)) }))
    .sort((a, b) => a.pos - b.pos || a.n - b.n);
  const rows = ordered.map(({ draft }) => {
    const p = draft.photoId ? photoOf.get(draft.photoId)! : null;
    let timeStatus: TimeStatus = 'NONE';
    if (p) timeStatus = !p.capturedAt ? 'UNKNOWN' : kstDate(p.capturedAt) === lifeDate ? 'CONFIRMED' : 'CONFLICT';
    return { draft, timeStatus, emphasis: draft.evidenceIds.some((id) => plan.items[idx.get(id)!]!.emphasis) };
  });
  // 촬영 시각 순서가 말한 순서와 반대인 쌍은 어느 쪽도 확정하지 않는다.
  const at = (r: (typeof rows)[number]) => photoOf.get(r.draft.photoId!)!.capturedAt!.getTime();
  const timed = rows.filter((r) => r.timeStatus === 'CONFIRMED');
  timed.forEach((x, a) => timed.slice(a + 1).forEach((y) => {
    if (at(x) > at(y)) { x.timeStatus = 'CONFLICT'; y.timeStatus = 'CONFLICT'; }
  }));
  return rows;
}

// ---- 길이 검증과 축약 ----

function truncateToSec(text: string, sec: number, cps: number): string {
  const maxChars = Math.max(1, Math.floor((sec - SCENE_PAUSE_SEC) * cps));
  const sentences = text.split(/(?<=[.!?。])\s+/);
  let acc = '';
  for (const s of sentences) {
    if ((acc + s).replace(/\s+/g, '').length > maxChars) break;
    acc = acc ? `${acc} ${s}` : s;
  }
  return acc || text.replace(/\s+/g, ' ').slice(0, maxChars);
}

/**
 * 합성 전 길이 검증(AC-5). 180초를 넘으면 강조가 아닌 장면부터, 같은 조건에서는 뒤쪽·학습 확대 장면부터 뺀다.
 * 장면 하나만 남아도 넘으면 문장 단위로 줄인다. 내용을 늘려 맞추는 일은 없다.
 */
export function condense(scenes: Scene[], cfg: NarrationConfig, max = MAX_TOTAL_SEC): { scenes: Scene[]; condensed: ScenePlan['condensed'] } {
  const total = (l: Scene[]) => Math.round(l.reduce((s, x) => s + x.estimatedSec, 0) * 10) / 10;
  const before = total(scenes);
  if (before <= max) return { scenes, condensed: null };
  let kept = [...scenes];
  const dropped: string[] = [];
  const truncated: string[] = [];
  const dropRank = (s: Scene) => (s.emphasis ? 2 : 0) + (s.type === 'DAILY' ? 1 : 0);
  while (total(kept) > max && kept.length > 1) {
    const victim = [...kept].sort((a, b) => dropRank(a) - dropRank(b) || b.order - a.order)[0]!;
    kept = kept.filter((s) => s !== victim);
    dropped.push(victim.key);
  }
  if (total(kept) > max) {
    const s = kept[0]!;
    const narration = truncateToSec(s.narration, max, cfg.charsPerSecond);
    kept = [{ ...s, narration, estimatedSec: Math.min(max, estimateSec(narration, cfg.charsPerSecond)) }];
    truncated.push(s.key);
  }
  kept = kept.map((s, i) => ({ ...s, order: i + 1 }));
  return { scenes: kept, condensed: { reason: 'OVER_MAX_SEC', beforeSec: before, droppedKeys: dropped, truncatedKeys: truncated } };
}

// ---- 생성 ----

export type SceneResult =
  | { ok: true; plan: ScenePlan; proCalls: number }
  | { ok: false; code: 'NO_CONTENT' | 'PRO_WAITING' | 'BAD_OUTPUT'; state?: string; detail?: DraftError; proCalls: number };

/**
 * 확인된 제작 계획으로 장면 계획을 만든다. 대기·한도에서는 유료 모델로 전환하지 않고 상태 그대로 돌려준다.
 * 형식·검증 오류에 한해 같은 입력으로 한 번만 다시 호출한다.
 */
export async function buildScenePlan(i: {
  plan: ProductionPlan; photos: PhotoRef[]; lifeDate: string; infer: ProInfer; narration?: Partial<NarrationConfig>; maxTotalSec?: number;
}): Promise<SceneResult> {
  const cfg = { ...DEFAULT_NARRATION, ...i.narration };
  if (!i.plan.items.length) return { ok: false, code: 'NO_CONTENT', proCalls: 0 };
  const text = scenePrompt(i.plan, i.photos, cfg);
  let calls = 0;
  let detail: DraftError = 'BAD_SHAPE';
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const out = await i.infer({ text }).catch(() => ({ state: 'WAIT_RECONCILIATION' }) as { state: string });
    if (out.state !== 'SUCCEEDED' || typeof (out as { text?: unknown }).text !== 'string') return { ok: false, code: 'PRO_WAITING', state: out.state, proCalls: calls };
    const parsed = parseDrafts((out as { text: string }).text, i.plan, i.photos);
    if (!parsed.ok) { detail = parsed.code; continue; }
    const rows = assignTime(parsed.drafts, i.plan, i.photos, i.lifeDate);
    const scenes: Scene[] = rows.map((r, n) => ({
      key: `sc${n + 1}`, order: n + 1, type: r.draft.type, narration: r.draft.narration, visual: r.draft.visual, evidenceIds: r.draft.evidenceIds, photoId: r.draft.photoId,
      timeStatus: r.timeStatus, estimated: r.timeStatus !== 'CONFIRMED' && r.timeStatus !== 'NONE', emphasis: r.emphasis, estimatedSec: estimateSec(r.draft.narration, cfg.charsPerSecond),
    }));
    const max = i.maxTotalSec ?? MAX_TOTAL_SEC;
    const c = condense(scenes, cfg, max);
    const totalSec = Math.round(c.scenes.reduce((s, x) => s + x.estimatedSec, 0) * 10) / 10;
    return {
      ok: true, proCalls: calls,
      plan: { kind: 'SCENE_PLAN', briefingVersion: i.plan.briefingVersion, lifeDate: i.lifeDate, narration: cfg, scenes: c.scenes, totalSec, maxTotalSec: max, condensed: c.condensed, shortRecord: totalSec < max && c.condensed === null },
    };
  }
  return { ok: false, code: 'BAD_OUTPUT', detail, proCalls: calls };
}
