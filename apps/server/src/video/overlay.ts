import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CANVAS } from './subtitles.js';

const OUT_SCALE = 720 / CANVAS.width;

/** 자막·확대 HTML 한 장을 투명 배경 PNG(출력 크기 720x1280)로 만든다. 시험에서는 모의 구현으로 대체한다. */
export type OverlayRenderer = (html: string) => Promise<Buffer>;

/**
 * 같은 HTML 은 같은 PNG 이므로 해시로 저장해 재사용한다(중간 결과 재사용, TASK-25).
 * 쓰는 도중 끊겨도 반쯤 쓴 파일이 남지 않게 임시 파일에 쓴 뒤 rename 한다.
 */
export async function cachedOverlay(dir: string, render: OverlayRenderer, html: string): Promise<{ file: string; reused: boolean }> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${createHash('sha256').update(html).digest('hex').slice(0, 32)}.png`);
  try {
    if ((await readFile(file)).length > 0) return { file, reused: true };
  } catch { /* 없음 */ }
  const png = await render(html);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
  return { file, reused: false };
}

/** Chromium 으로 그리는 운영용 구현. 브라우저는 한 번만 띄우고 close() 로 닫는다. */
export async function chromiumOverlay(executablePath: string): Promise<{ render: OverlayRenderer; close: () => Promise<void> }> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1'] });
  const page = await browser.newPage({ viewport: { width: CANVAS.width, height: CANVAS.height }, deviceScaleFactor: OUT_SCALE });
  return {
    render: async (html) => {
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: 'png', omitBackground: true });
    },
    close: () => browser.close(),
  };
}
