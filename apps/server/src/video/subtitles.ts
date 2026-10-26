import type { Scene } from './scenePlan.js';
import type { NarrationSegment } from './narration.js';

/**
 * 자막 구성(TASK-24). 일상 장면은 대사 전체를, 학습 장면은 대사에서 고른 핵심 문장만 보인다.
 * 자막 글자는 모두 대사 원문에서 가져오며 새 문장을 만들지 않는다. 시간은 실제 합성 길이에 비례해 나눈다.
 * 규칙은 세로 9:16(1080x1920) 휴대폰 화면 기준이다.
 */

export const CANVAS = { width: 1080, height: 1920 } as const;
/** 좌우 안전 여백(px). 자막·확대 화면은 이 안쪽에만 놓는다. */
export const SAFE_MARGIN_PX = 72;
export const TEXT_WIDTH_PX = CANVAS.width - SAFE_MARGIN_PX * 2;
/** 자막이 놓이는 세로 구간(px). 아래쪽 앱 UI·플랫폼 버튼 영역을 피한다. */
export const SUBTITLE_BOX = { top: 1340, bottom: 1700 } as const;

export const DAILY_FONT_PX = 52;
export const KEY_FONT_PX = 60;
export const MAX_SUB_LINES = 2;
export const MAX_KEY_CUES = 3;

export type SubtitleMode = 'FULL' | 'KEY';
export interface SubtitleCue {
  sceneKey: string;
  mode: SubtitleMode;
  /** 줄바꿈은 \n. 줄마다 화면 폭 안에 들어가도록 이미 나눈 상태다. */
  text: string;
  fontPx: number;
  startSec: number;
  endSec: number;
}

/** 글자 폭(em 단위). 한글·한자·전각은 1, 공백 0.3, 그 밖의 반각 글자 0.58. */
export function textUnits(s: string): number {
  let u = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === ' ') u += 0.3;
    else if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x1f000) u += 1;
    else u += 0.58;
  }
  return u;
}

export const maxUnitsPerLine = (fontPx: number) => Math.floor(TEXT_WIDTH_PX / fontPx);

/** 공백 단위로 줄을 채우고, 한 단어가 한 줄보다 길면 글자 단위로 자른다. */
export function wrapLines(text: string, maxUnits: number): string[] {
  const lines: string[] = [];
  let cur = '';
  const push = () => { if (cur) lines.push(cur); cur = ''; };
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (textUnits(next) <= maxUnits) { cur = next; continue; }
    push();
    if (textUnits(word) <= maxUnits) { cur = word; continue; }
    for (const ch of word) {
      if (textUnits(cur + ch) > maxUnits) push();
      cur += ch;
    }
  }
  push();
  return lines;
}

export const splitSentences = (text: string): string[] =>
  text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。…])\s+/).filter(Boolean);

const weight = (s: string) => Math.max(1, s.replace(/\s+/g, '').length);

/** 문장 하나를 maxLines 줄 단위 자막으로 나눈다. */
export function sentenceToCues(sentence: string, fontPx: number): string[] {
  const lines = wrapLines(sentence, maxUnitsPerLine(fontPx));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += MAX_SUB_LINES) out.push(lines.slice(i, i + MAX_SUB_LINES).join('\n'));
  return out;
}

const STOP = new Set(['오늘', '그리고', '그래서', '하지만', '나는', '내가', '정말', '조금', '이번']);
const tokens = (s: string) => (s.match(/[A-Za-z_][A-Za-z0-9_]{1,}|[가-힣]{2,}|\d+/g) ?? []).filter((t) => !STOP.has(t));

/**
 * 학습 장면의 핵심 문장. 학습 자료(코드·수식·노트 원문)와 단어가 많이 겹치는 문장을 우선하고,
 * 겹침이 없으면 첫 문장을 쓴다. 최대 2문장, 대사의 순서를 지킨다. 대사에 없는 말은 만들지 않는다.
 */
export function pickKeySentences(narration: string, material: string | null, max = 2): string[] {
  const sentences = splitSentences(narration);
  if (sentences.length <= 1) return sentences;
  const mat = new Set(tokens(material ?? ''));
  const scored = sentences.map((s, i) => ({ s, i, score: tokens(s).filter((t) => mat.has(t)).length }));
  const chosen = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i);
  return chosen.map((c) => c.s);
}

export interface SentenceWindow { text: string; startSec: number; endSec: number }

/** 실제 음성 구간을 글자 수 비례로 문장에 나눈다(문장 경계는 무음 감지가 아닌 비례 추정). */
export function sentenceWindows(narration: string, seg: Pick<NarrationSegment, 'startSec' | 'endSec'>): SentenceWindow[] {
  const sentences = splitSentences(narration);
  const total = sentences.reduce((s, x) => s + weight(x), 0);
  const span = seg.endSec - seg.startSec;
  let acc = 0;
  return sentences.map((text) => {
    const startSec = seg.startSec + (acc / total) * span;
    acc += weight(text);
    return { text, startSec: round2(startSec), endSec: round2(seg.startSec + (acc / total) * span) };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function cuesInWindow(w: SentenceWindow, scene: Scene, mode: SubtitleMode, fontPx: number): SubtitleCue[] {
  const parts = sentenceToCues(w.text, fontPx);
  const total = parts.reduce((s, x) => s + weight(x), 0);
  let acc = 0;
  return parts.map((text) => {
    const startSec = w.startSec + (acc / total) * (w.endSec - w.startSec);
    acc += weight(text);
    return { sceneKey: scene.key, mode, text, fontPx, startSec: round2(startSec), endSec: round2(w.startSec + (acc / total) * (w.endSec - w.startSec)) };
  });
}

/** 장면별 자막. DAILY=전체 문장(FULL), LEARNING=핵심 문장만(KEY, 더 큰 글자). */
export function buildSubtitles(scene: Scene, seg: Pick<NarrationSegment, 'startSec' | 'endSec'>, material: string | null = null): SubtitleCue[] {
  const windows = sentenceWindows(scene.narration, seg);
  if (scene.type === 'DAILY') return windows.flatMap((w) => cuesInWindow(w, scene, 'FULL', DAILY_FONT_PX));
  const keys = new Set(pickKeySentences(scene.narration, material));
  return windows.filter((w) => keys.has(w.text)).flatMap((w) => cuesInWindow(w, scene, 'KEY', KEY_FONT_PX)).slice(0, MAX_KEY_CUES);
}

// ---- 검증(D23-04) ----

export type SubtitleIssue =
  | { code: 'LINE_TOO_WIDE' | 'TOO_MANY_LINES' | 'BAD_TIME' | 'OVERLAP' | 'OUTSIDE_SCENE' | 'TEXT_NOT_IN_NARRATION'; sceneKey: string; index: number };

const squash = (s: string) => s.replace(/\s+/g, '');

/** 자막 규칙 위반(잘림 위험·시간 겹침·장면 밖 노출·대사에 없는 글자)을 모두 모아 돌려준다. */
export function checkSubtitles(cues: SubtitleCue[], scenes: Scene[], segs: Pick<NarrationSegment, 'sceneKey' | 'startSec' | 'endSec'>[]): SubtitleIssue[] {
  const issues: SubtitleIssue[] = [];
  const segOf = new Map(segs.map((s) => [s.sceneKey, s]));
  const sceneOf = new Map(scenes.map((s) => [s.key, s]));
  let prev: SubtitleCue | null = null;
  cues.forEach((c, index) => {
    const add = (code: SubtitleIssue['code']) => issues.push({ code, sceneKey: c.sceneKey, index });
    const lines = c.text.split('\n');
    if (lines.length > MAX_SUB_LINES) add('TOO_MANY_LINES');
    if (lines.some((l) => textUnits(l) * c.fontPx > TEXT_WIDTH_PX)) add('LINE_TOO_WIDE');
    if (!(c.endSec > c.startSec)) add('BAD_TIME');
    const seg = segOf.get(c.sceneKey);
    if (!seg || c.startSec < seg.startSec - 0.01 || c.endSec > seg.endSec + 0.01) add('OUTSIDE_SCENE');
    if (prev && c.startSec < prev.endSec - 0.01) add('OVERLAP');
    const sc = sceneOf.get(c.sceneKey);
    if (!sc || !squash(sc.narration).includes(squash(c.text))) add('TEXT_NOT_IN_NARRATION');
    prev = c;
  });
  return issues;
}
