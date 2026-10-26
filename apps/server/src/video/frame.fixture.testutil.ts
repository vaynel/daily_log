import { buildSubtitles } from './subtitles.js';
import { chunkMaterial } from './zoom.js';
import { type Scene } from './scenePlan.js';
import { frameHtml } from './frame.js';

/** 휴대폰 화면 점검용 고정 장면(최악에 가까운 긴 문장·긴 코드 줄 포함). scripts/subtitle-layout-check.mjs 가 JSON 으로 읽는다. */
const mk = (n: number, type: Scene['type'], narration: string): Scene => ({ key: `sc${n}`, order: n, type, narration, visual: 'v', evidenceIds: ['s1'], photoId: null, timeStatus: 'NONE', estimated: false, emphasis: false, estimatedSec: 8 });
const daily = mk(1, 'DAILY', '아침에 에코 버그를 고쳤다. 생각보다 오래 걸렸지만 끝내고 나니 마음이 한결 가벼워졌고 점심은 천천히 먹었다. supercalifragilisticexpialidocious_variable_name 같은 긴 이름도 있었다.');
const learn = mk(2, 'LEARNING', '오늘은 SQL 인젝션 예방을 공부했다. 질문 자리에 값을 따로 넘기면 입력이 쿼리가 되지 않는다. 그래서 db.query 의 두 번째 인자를 쓴다.');
const code = "const rows = await db.query('SELECT * FROM users WHERE id = $1 AND status = $2', [id, status]);\nif (!rows.length) throw new Error('not found');\nreturn rows[0];";
const formula = 'Var(X) = E[X²] − (E[X])²\nP(A|B) = P(B|A)·P(A) / P(B)';
const frames: { name: string; html: string; expect: string[] }[] = [];
for (const c of buildSubtitles(daily, { startSec: 0, endSec: 12 })) frames.push({ name: `daily-${frames.length}`, html: frameHtml({ cue: c }), expect: ['sub'] });
for (const c of buildSubtitles(learn, { startSec: 12, endSec: 24 }, code)) frames.push({ name: `key-${frames.length}`, html: frameHtml({ cue: c }), expect: ['sub'] });
for (const [kind, original] of [['CODE', code], ['FORMULA', formula]] as const) {
  for (const p of chunkMaterial({ sceneKey: 'sc2', kind, original }).pieces) {
    frames.push({ name: `zoom-${kind}-${frames.length}`, html: frameHtml({ zoom: { ...p, startSec: 0, endSec: 3 } }), expect: ['zoomtext'] });
  }
}
process.stdout.write(JSON.stringify(frames));
