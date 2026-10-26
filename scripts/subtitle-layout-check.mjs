// TASK-24 휴대폰 세로 화면 점검: 고정 장면의 자막·확대 상자가 1080x1920 안전 여백 안에 들어오는지 브라우저에서 잰다.
// 실제 Android 기기 확인이 아니다. 한글 글꼴이 없으면(FONT_MISSING) 글자 폭이 실제와 다를 수 있어 실패로 끝낸다(--allow-missing-font 로 진단만).
// 사용: E2E_SHOT_DIR=/tmp/shots node scripts/subtitle-layout-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = process.env.E2E_SHOT_DIR ?? '';
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!exe) throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 필요');
const allowMissing = process.argv.includes('--allow-missing-font');
const { chromium } = await import('playwright-core');

let hangul = '';
try { hangul = execFileSync('fc-list', [':lang=ko', 'family'], { encoding: 'utf8' }).trim(); } catch { /* fc-list 없음 */ }
const fontOk = hangul.length > 0;
console.log(`한글 글꼴: ${fontOk ? hangul.split('\n')[0] : 'FONT_MISSING'}`);
if (!fontOk && !allowMissing) { console.error('FONT_MISSING: 한글 글꼴이 설치된 환경에서 다시 실행하세요.'); process.exit(2); }

const frames = JSON.parse(execFileSync(path.join(root, 'node_modules/.bin/tsx'), ['src/video/frame.fixture.testutil.ts'], { cwd: path.join(root, 'apps/server'), encoding: 'utf8', maxBuffer: 1 << 24 }));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--no-zygote', '--num-raster-threads=1'] });
let bad = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  for (const f of frames) {
    await page.setContent(f.html);
    await page.evaluate(() => document.fonts.ready);
    for (const id of f.expect) {
      const r = await page.evaluate((i) => { const b = document.getElementById(i).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; }, id);
      const inside = r.l >= 72 - 0.5 && r.r <= 1080 - 72 + 0.5 && r.t >= 0 && r.b <= 1920;
      if (!inside) { bad++; console.error(`CLIPPED ${f.name} ${id} ${JSON.stringify(r)}`); }
    }
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `${f.name}.png`) });
  }
} finally { await browser.close(); }
console.log(`프레임 ${frames.length}개, 안전 여백 이탈 ${bad}개`);
assert.equal(bad, 0);
