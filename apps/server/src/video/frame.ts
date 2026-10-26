import { CANVAS, SAFE_MARGIN_PX, SUBTITLE_BOX, TEXT_WIDTH_PX, type SubtitleCue } from './subtitles.js';
import type { ZoomChunk } from './zoom.js';

/**
 * 장면 프레임 HTML(TASK-24). 합성기와 휴대폰 화면 점검이 같은 배치 규칙을 쓰도록 한 곳에 둔다.
 * 자막·확대 글자는 안전 여백 안쪽 상자에만 놓이며 줄은 서버가 이미 나눴으므로 브라우저가 다시 줄바꿈하지 않는다(white-space: pre).
 */
export const FONT_STACK = `'Noto Sans CJK KR','Noto Sans KR',Pretendard,'Malgun Gothic','Apple SD Gothic Neo',sans-serif`;
export const MONO_STACK = `'D2Coding','Noto Sans Mono CJK KR','Nanum Gothic Coding',Consolas,'DejaVu Sans Mono',monospace`;
export const ZOOM_BOX = { top: 240, bottom: 1300 } as const;

/** 이어짐 표시 거터는 안전 여백 바깥쪽 왼쪽 띠에 두어 본문 폭(=접는 기준)을 줄이지 않는다. */
export const GUTTER_MARK = '↳';
const GUTTER = { left: 16, width: SAFE_MARGIN_PX - 24 } as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function gutter(z: ZoomChunk): string {
  if (!z.wrapped) return '';
  const marks = z.continued.map((c) => (c ? GUTTER_MARK : '')).join('\n');
  return `<div id="zoomgutter" style="position:absolute;left:${GUTTER.left - SAFE_MARGIN_PX}px;top:0;width:${GUTTER.width}px;white-space:pre;text-align:right;font:500 ${Math.round(z.fontPx * 0.8)}px/${(z.fontPx * 1.4) / Math.round(z.fontPx * 0.8)} ${FONT_STACK};color:#8ab4ff">${marks}</div>`;
}

/** transparent=true 면 바탕을 비워 장면 프레임 위에 얹는 오버레이(TASK-25)로 쓴다. */
export function frameHtml(o: { cue?: SubtitleCue; zoom?: ZoomChunk; transparent?: boolean }): string {
  const sub = o.cue
    ? `<div id="sub" style="position:absolute;left:${SAFE_MARGIN_PX}px;width:${TEXT_WIDTH_PX}px;top:${SUBTITLE_BOX.top}px;height:${SUBTITLE_BOX.bottom - SUBTITLE_BOX.top}px;display:flex;align-items:center;justify-content:center;text-align:center"><span style="white-space:pre;font:700 ${o.cue.fontPx}px/1.35 ${FONT_STACK};color:#fff;text-shadow:0 0 6px #000,0 0 6px #000">${esc(o.cue.text)}</span></div>`
    : '';
  const zoom = o.zoom
    ? `<div id="zoom" style="position:absolute;left:${SAFE_MARGIN_PX}px;width:${TEXT_WIDTH_PX}px;top:${ZOOM_BOX.top}px;height:${ZOOM_BOX.bottom - ZOOM_BOX.top}px;overflow:visible"><div id="zoomtext" style="white-space:pre;display:inline-block;font:500 ${o.zoom.fontPx}px/1.4 ${o.zoom.mono ? MONO_STACK : FONT_STACK};color:#f4f4f4;background:#1d1f24;padding:0">${esc(o.zoom.displayLines.join('\n'))}</div>${gutter(o.zoom)}</div>`
    : '';
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${CANVAS.width}px;height:${CANVAS.height}px;position:relative;overflow:hidden;background:${o.transparent ? 'transparent' : '#2b2f36'}">${zoom}${sub}</body>`;
}
