/**
 * 캐릭터 컷의 흰/회색 바탕을 투명하게 만든다(TASK-23). 색 하나를 통째로 지우면 흰 머리·흰 바지·회색 후드까지 사라지므로,
 * 가장자리에서 바탕색과 가까운 픽셀만 따라 들어가는 채우기(flood fill)로 바깥 바탕만 제거한다.
 * 굵은 윤곽선 안쪽은 바깥과 이어지지 않아 그대로 남는다.
 */

export interface Bbox { x0: number; y0: number; x1: number; y1: number }

/** RGBA 버퍼의 바깥 바탕을 투명(alpha 0)으로 바꾼다. 남은 불투명 영역의 경계 상자를 돌려준다(없으면 null). */
export function keyOutBackground(rgba: Buffer, w: number, h: number, tolerance = 48): Bbox | null {
  const idx = (x: number, y: number) => (y * w + x) * 4;
  // 바탕색 = 테두리 픽셀 채널별 중앙값.
  const edge: number[][] = [[], [], []];
  const push = (x: number, y: number) => { for (let c = 0; c < 3; c++) edge[c]!.push(rgba[idx(x, y) + c]!); };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
  const bg = edge.map((v) => v.sort((a, b) => a - b)[v.length >> 1]!);
  const near = (i: number) => {
    const dr = rgba[i]! - bg[0]!, dg = rgba[i + 1]! - bg[1]!, db = rgba[i + 2]! - bg[2]!;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
  };
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const p = y * w + x;
    if (!seen[p] && near(p * 4)) { seen[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (seen[p]) { rgba[p * 4 + 3] = 0; continue; }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
