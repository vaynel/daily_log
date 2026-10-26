import { TEXT_WIDTH_PX, textUnits, wrapLines } from './subtitles.js';

/**
 * 학습 확대 화면(TASK-24). 코드·수식·노트는 원문을 한 글자도 바꾸지 않고, 화면에 다 들어가지 않으면
 * 줄 경계에서 나눠 차례로 보여 준다. 긴 줄은 보이기만 접고(soft wrap) 원문 줄은 그대로 보존한다.
 * 어떤 내용도 요약·생략하지 않으며, 보여 줄 시간이 모자라면 줄이지 않고 실패로 돌려준다.
 */

export type MaterialKind = 'CODE' | 'FORMULA' | 'NOTE';
export interface LearningMaterial { sceneKey: string; kind: MaterialKind; original: string }

export interface ZoomChunk {
  /** 이 조각이 담당하는 원문(줄바꿈 \n 포함, 변형 없음). */
  original: string;
  /** 화면에 그릴 줄. 긴 원문 줄은 접혀 있을 수 있다. */
  displayLines: string[];
  fontPx: number;
  mono: boolean;
  /** 접힌 줄이 있으면 true — 화면에 이어짐 표시(↳)를 그린다. */
  wrapped: boolean;
  startSec: number;
  endSec: number;
}
export interface ZoomPlan { sceneKey: string; kind: MaterialKind; chunks: ZoomChunk[] }

export const CODE_FONT_MAX_PX = 44;
export const CODE_FONT_MIN_PX = 34;
export const NOTE_FONT_PX = 48;
export const MAX_DISPLAY_LINES = 11;
export const MIN_CHUNK_SEC = 2.5;
const MONO_EM = 0.6;
/** 모노스페이스에서 한글 등 전각 글자는 2칸. */
const cols = (s: string) => { let n = 0; for (const ch of s) n += textUnits(ch) >= 1 ? 2 : 1; return n; };

function foldLine(line: string, maxCols: number): string[] {
  if (cols(line) <= maxCols) return [line];
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (cols(cur + ch) > maxCols) { out.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkMaterial(m: LearningMaterial): { sceneKey: string; kind: MaterialKind; pieces: Omit<ZoomChunk, 'startSec' | 'endSec'>[] } {
  const src = m.original.replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const mono = m.kind !== 'NOTE';
  const maxLineCols = Math.max(1, ...lines.map(cols));
  let fontPx = NOTE_FONT_PX;
  let foldCols = Infinity;
  if (mono) {
    fontPx = Math.max(CODE_FONT_MIN_PX, Math.min(CODE_FONT_MAX_PX, Math.floor(TEXT_WIDTH_PX / (MONO_EM * maxLineCols))));
    foldCols = Math.floor(TEXT_WIDTH_PX / (MONO_EM * fontPx));
  }
  const noteUnits = Math.floor(TEXT_WIDTH_PX / NOTE_FONT_PX);
  // 원문 줄마다 화면 줄 목록을 만든다. 조각은 원문 줄 경계에서만 나눈다.
  const shown = lines.map((l) => (mono ? foldLine(l, foldCols) : l.trim() ? wrapLines(l, noteUnits) : ['']));
  const pieces: { start: number; end: number }[] = [];
  let start = 0, count = 0, lastBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    const n = shown[i]!.length;
    if (count + n > MAX_DISPLAY_LINES && i > start) {
      // 빈 줄(문단·함수 경계)이 있으면 거기서 끊는다.
      const cut = lastBlank >= start ? lastBlank + 1 : i;
      pieces.push({ start, end: cut });
      start = cut; count = 0; lastBlank = -1;
      for (let k = start; k < i; k++) { count += shown[k]!.length; if (!lines[k]!.trim()) lastBlank = k; }
    }
    count += n;
    if (!lines[i]!.trim()) lastBlank = i;
  }
  pieces.push({ start, end: lines.length });
  return {
    sceneKey: m.sceneKey, kind: m.kind,
    pieces: pieces.map((p) => ({
      original: lines.slice(p.start, p.end).join('\n'),
      displayLines: shown.slice(p.start, p.end).flat(),
      fontPx, mono, wrapped: shown.slice(p.start, p.end).some((s) => s.length > 1),
    })),
  };
}

/** 조각을 이어 붙이면 원문과 같은지(AC-3). */
export const reassemble = (pieces: { original: string }[]) => pieces.map((p) => p.original).join('\n');

export type ZoomResult = { ok: true; plan: ZoomPlan } | { ok: false; code: 'TOO_MANY_CHUNKS' | 'EMPTY_MATERIAL' | 'ALTERED'; needSec?: number };

/** 장면의 음성 구간 [startSec, endSec] 에 조각을 같은 간격으로 놓는다. 조각당 MIN_CHUNK_SEC 를 못 채우면 실패. */
export function planZoom(m: LearningMaterial, window: { startSec: number; endSec: number }): ZoomResult {
  if (!m.original.trim()) return { ok: false, code: 'EMPTY_MATERIAL' };
  const c = chunkMaterial(m);
  if (reassemble(c.pieces) !== m.original.replace(/\r\n/g, '\n')) return { ok: false, code: 'ALTERED' };
  const span = window.endSec - window.startSec;
  const need = c.pieces.length * MIN_CHUNK_SEC;
  if (span + 1e-6 < need) return { ok: false, code: 'TOO_MANY_CHUNKS', needSec: need };
  const each = span / c.pieces.length;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ok: true,
    plan: { sceneKey: m.sceneKey, kind: m.kind, chunks: c.pieces.map((p, i) => ({ ...p, startSec: r2(window.startSec + i * each), endSec: r2(window.startSec + (i + 1) * each) })) },
  };
}
