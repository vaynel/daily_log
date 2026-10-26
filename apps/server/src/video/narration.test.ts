import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTempSchema } from '../records/db.testutil.js';
import { MonthlyLedger } from '../budget/ledger.js';
import { DEFAULT_PRICING } from '../voice/pricing.js';
import { pcmToWav, TransportError, type TtsResult } from '../voice/transports.js';
import { loadVoiceConfig, synthesizeNarration, type NarrationTts } from './narration.js';
import { runNarrationStage } from './narrationStage.js';
import { DEFAULT_NARRATION, type Scene, type ScenePlan } from './scenePlan.js';
import { buildSubtitles, checkSubtitles, maxUnitsPerLine, textUnits, wrapLines, TEXT_WIDTH_PX, type SubtitleCue } from './subtitles.js';
import { chunkMaterial, planZoom, reassemble, type LearningMaterial } from './zoom.js';

const VOICE_FILE = fileURLToPath(new URL('../../../../assets/voice/voice.json', import.meta.url));
const voice = loadVoiceConfig(VOICE_FILE);
const url = process.env.DATABASE_URL;

const wav = (sec: number, silent = false): TtsResult => {
  const n = Math.round(sec * 24000);
  const pcm = Buffer.alloc(n * 2);
  if (!silent) for (let i = 0; i < n; i++) pcm.writeInt16LE(((i % 50) - 25) * 100, i * 2);
  return { audio: pcmToWav(pcm), mime: 'audio/wav', outputSeconds: sec };
};
/** 글자 수 기준 5자/초로 길이를 정하는 모의 합성. 호출 인자를 모두 남긴다. */
const mockTts = (o: { failOn?: number; error?: Error; silent?: boolean } = {}) => {
  const calls: { text: string; voiceName: string; style: string }[] = [];
  const tts: NarrationTts = async (text, v) => {
    calls.push({ text, voiceName: v.voiceName, style: v.styleInstruction });
    if (o.failOn === calls.length) throw o.error ?? new TransportError('TTS_HTTP_500');
    return wav(Math.max(1, text.replace(/\s+/g, '').length / 5), o.silent);
  };
  return { tts, calls };
};

const mk = (n: number, type: Scene['type'], narration: string): Scene => ({
  key: `sc${n}`, order: n, type, narration, visual: 'v', evidenceIds: ['s1'], photoId: null, timeStatus: 'NONE', estimated: false, emphasis: false, estimatedSec: 5,
});
let day = 0;
/** 멱등키가 날짜·브리핑 버전을 포함하므로 시험마다 다른 날짜를 쓴다. */
const plan = (scenes: Scene[], over: Partial<ScenePlan> = {}): ScenePlan => ({
  kind: 'SCENE_PLAN', briefingVersion: 2, lifeDate: `2026-10-${String(++day).padStart(2, '0')}`, narration: { ...DEFAULT_NARRATION, voiceName: voice.voiceName }, scenes, totalSec: 10, maxTotalSec: 180, condensed: null, shortRecord: false, ...over,
});
const CODE: LearningMaterial = { sceneKey: 'sc2', kind: 'CODE', original: "const rows = await db.query('SELECT * FROM users WHERE id = $1', [id]);\nreturn rows[0];" };
const scenes = () => [
  mk(1, 'DAILY', '아침에 에코 버그를 고쳤다. 생각보다 오래 걸렸지만 마음은 가벼웠다.'),
  mk(2, 'LEARNING', '오늘은 SQL 인젝션 예방을 공부했다. 질문 자리에 값을 따로 넘기면 입력이 쿼리가 되지 않는다. 그래서 db.query 의 두 번째 인자를 쓴다.'),
];

describe('목소리 설정 (AC-1)', () => {
  it('저장소 voice.json 의 기본 목소리와 읽기 지시를 읽는다', () => {
    expect(voice).toMatchObject({ voiceName: 'Achird', provider: 'gemini-3.8-flash-tts' });
    expect(voice.styleInstruction).toContain('담담');
  });
});

describe.skipIf(!url)('내레이션 합성 (실제 PostgreSQL 임시 스키마, 모의 TTS)', () => {
  let t: Awaited<ReturnType<typeof createTempSchema>>;
  let pool: pg.Pool;
  let seq = 0;
  const fresh = (limitKrw?: number) => {
    const at = new Date(`2031-${String(++seq).padStart(2, '0')}-15T12:00:00+09:00`);
    return new MonthlyLedger(pool, { limitKrw, clock: () => at });
  };
  beforeAll(async () => { t = await createTempSchema(url!); pool = t.pool(); });
  afterAll(async () => { await pool.end(); await t.drop(); });

  it('AC-1 모든 장면을 voice.json 의 같은 목소리·지시로 합성하고 원장에 확정한다', async () => {
    const { tts, calls } = mockTts();
    const ledger = fresh();
    const r = await synthesizeNarration({ plan: plan(scenes()), voice, tts, ledger, pricing: DEFAULT_PRICING });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.voiceName))).toEqual(new Set(['Achird']));
    expect(new Set(calls.map((c) => c.style))).toEqual(new Set([voice.styleInstruction]));
    if (!r.ok) return;
    expect(r.segments.every((s) => s.voiceName === 'Achird')).toBe(true);
    const snap = await ledger.snapshot();
    expect(snap.confirmedKrw).toBeCloseTo(r.costKrw, 1);
    expect(snap.reservedKrw).toBe(0);
  });

  it('구간 시간은 실제 합성 길이를 따르고 장면 사이에 0.5초 간격을 둔다', async () => {
    const r = await synthesizeNarration({ plan: plan(scenes()), voice, tts: mockTts().tts, ledger: fresh(), pricing: DEFAULT_PRICING });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = r.segments;
    expect(a!.startSec).toBe(0);
    expect(a!.endSec).toBeCloseTo(a!.durationSec, 2);
    expect(b!.startSec).toBeCloseTo(a!.endSec + 0.5, 2);
    expect(r.totalSec).toBeCloseTo(b!.endSec, 2);
  });

  it('계획의 목소리가 voice.json 과 다르면 합성 전에 멈추고 예비 목소리로 대체하지 않는다', async () => {
    const { tts, calls } = mockTts();
    const r = await synthesizeNarration({ plan: plan(scenes(), { narration: { ...DEFAULT_NARRATION, voiceName: 'Zubenelgenubi' } }), voice, tts, ledger: fresh(), pricing: DEFAULT_PRICING });
    expect(r).toEqual({ ok: false, code: 'VOICE_MISMATCH' });
    expect(calls).toHaveLength(0);
  });

  it('실제 합성 길이가 180초를 넘으면 완료하지 않는다', async () => {
    const long = [mk(1, 'DAILY', '가나다라마. '.repeat(200))];
    const r = await synthesizeNarration({ plan: plan(long), voice, tts: mockTts().tts, ledger: fresh(), pricing: DEFAULT_PRICING });
    expect(r).toEqual({ ok: false, code: 'OVER_MAX_SEC' });
  });

  describe('AC-5 음성 생성 실패 주입', () => {
    const run = (tts: NarrationTts, ledger = fresh(), p = plan(scenes())) => runNarrationStage({ plan: p, voice, tts, ledger, pricing: DEFAULT_PRICING, materials: [CODE] });

    it('두 번째 장면 5xx(결과 불명) → 실패, 값 없음, 예약액은 환급되지 않고 이후 장면도 호출하지 않는다', async () => {
      const { tts, calls } = mockTts({ failOn: 2 });
      const ledger = fresh();
      const r = await run(tts, ledger);
      expect(r).toMatchObject({ ok: false, code: 'TTS_UNKNOWN', sceneKey: 'sc2' });
      expect('value' in r).toBe(false);
      expect(calls).toHaveLength(2);
      expect((await ledger.snapshot()).unknownKrw).toBeGreaterThan(0);
    });
    it('4xx 거절 → TTS_FAILED, 예약 해제', async () => {
      const ledger = fresh();
      const r = await run(mockTts({ failOn: 1, error: new TransportError('TTS_HTTP_400') }).tts, ledger);
      expect(r).toMatchObject({ ok: false, code: 'TTS_FAILED', sceneKey: 'sc1' });
      expect((await ledger.snapshot()).committedKrw).toBe(0);
    });
    it('완전 무음 오디오·빈 응답 → TTS_EMPTY(무음 영상으로 넘기지 않음)', async () => {
      expect(await run(mockTts({ silent: true }).tts)).toMatchObject({ ok: false, code: 'TTS_EMPTY', sceneKey: 'sc1' });
      const empty: NarrationTts = async () => ({ audio: Buffer.alloc(0), mime: 'audio/wav', outputSeconds: 0 });
      expect(await run(empty)).toMatchObject({ ok: false, code: 'TTS_EMPTY' });
    });
    it('예산 부족 → TTS 호출 0회', async () => {
      const { tts, calls } = mockTts();
      const r = await run(tts, fresh(0.001));
      expect(r).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED', sceneKey: 'sc1' });
      expect(calls).toHaveLength(0);
    });
    it('같은 장면을 다시 합성하려 하면 중복 과금 요청을 보내지 않고 불명으로 멈춘다', async () => {
      const ledger = fresh();
      const { tts, calls } = mockTts();
      const p = plan(scenes());
      expect((await run(tts, ledger, p)).ok).toBe(true);
      const again = await run(tts, ledger, p);
      expect(again).toMatchObject({ ok: false, code: 'TTS_UNKNOWN' });
      expect(calls).toHaveLength(2);
    });
  });

  it('통합: 음성·자막·학습 확대가 같은 시간축에 놓인다', async () => {
    const r = await runNarrationStage({ plan: plan(scenes()), voice, tts: mockTts().tts, ledger: fresh(), pricing: DEFAULT_PRICING, materials: [CODE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value;
    expect(v.zooms.map((z) => z.sceneKey)).toEqual(['sc2']);
    const seg2 = v.segments[1]!;
    expect(v.zooms[0]!.chunks[0]!.startSec).toBeCloseTo(seg2.startSec, 1);
    expect(v.subtitles.filter((c) => c.sceneKey === 'sc1').every((c) => c.mode === 'FULL')).toBe(true);
    expect(v.subtitles.filter((c) => c.sceneKey === 'sc2').every((c) => c.mode === 'KEY')).toBe(true);
  });
});

describe('자막 (AC-2, AC-4)', () => {
  const seg = { startSec: 10, endSec: 20 };
  const squash = (s: string) => s.replace(/\s+/g, '');

  it('일상 장면은 대사 전체가 자막에 들어간다', () => {
    const s = scenes()[0]!;
    const cues = buildSubtitles(s, seg);
    expect(squash(cues.map((c) => c.text).join(''))).toBe(squash(s.narration));
    expect(cues.every((c) => c.mode === 'FULL')).toBe(true);
  });
  it('학습 장면은 학습 자료와 겹치는 핵심 문장만 남기고 대사보다 짧다', () => {
    const s = scenes()[1]!;
    const cues = buildSubtitles(s, seg, CODE.original);
    const text = squash(cues.map((c) => c.text).join(''));
    expect(cues.every((c) => c.mode === 'KEY')).toBe(true);
    expect(text.length).toBeLessThan(squash(s.narration).length);
    expect(squash(s.narration)).toContain(text.slice(0, 12));
    expect(cues.map((c) => c.text).join(' ')).toContain('db.query');
  });
  it('모든 자막은 시간순·비겹침이고 장면 구간 안에 있으며 두 줄·화면 폭 이내다', () => {
    const sc = [mk(1, 'DAILY', '아침에 에코 버그를 고쳤다. '.repeat(8)), mk(2, 'LEARNING', scenes()[1]!.narration)];
    const segs = [{ sceneKey: 'sc1', startSec: 0, endSec: 12 }, { sceneKey: 'sc2', startSec: 12.5, endSec: 30 }];
    const cues = [...buildSubtitles(sc[0]!, segs[0]!), ...buildSubtitles(sc[1]!, segs[1]!, CODE.original)];
    expect(checkSubtitles(cues, sc, segs)).toEqual([]);
    for (const c of cues) for (const l of c.text.split('\n')) expect(textUnits(l) * c.fontPx).toBeLessThanOrEqual(TEXT_WIDTH_PX);
  });
  it('긴 단어도 한 줄 폭을 넘지 않게 자른다', () => {
    const lines = wrapLines('가'.repeat(60), maxUnitsPerLine(52));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => textUnits(l) <= maxUnitsPerLine(52))).toBe(true);
  });
  it('검증기는 폭 초과·겹침·장면 밖·대사에 없는 글자를 잡아낸다', () => {
    const sc = [mk(1, 'DAILY', '버그를 고쳤다.')];
    const segs = [{ sceneKey: 'sc1', startSec: 0, endSec: 5 }];
    const bad: SubtitleCue[] = [
      { sceneKey: 'sc1', mode: 'FULL', text: '가'.repeat(40), fontPx: 52, startSec: 0, endSec: 3 },
      { sceneKey: 'sc1', mode: 'FULL', text: '없는 문장', fontPx: 52, startSec: 2, endSec: 6 },
    ];
    const codes = checkSubtitles(bad, sc, segs).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['LINE_TOO_WIDE', 'TEXT_NOT_IN_NARRATION', 'OVERLAP', 'OUTSIDE_SCENE']));
  });
});

describe('학습 확대 화면 (AC-3)', () => {
  const long = Array.from({ length: 30 }, (_, i) => (i % 10 === 9 ? '' : `  const value${i} = compute(${i}, 'x');`)).join('\n');

  it('코드는 조각을 이어 붙이면 원문과 정확히 같고 빈 줄에서 먼저 나뉜다', () => {
    const c = chunkMaterial({ sceneKey: 'sc2', kind: 'CODE', original: long });
    expect(c.pieces.length).toBeGreaterThan(1);
    expect(reassemble(c.pieces)).toBe(long);
    expect(c.pieces.every((p) => p.displayLines.length <= 11)).toBe(true);
    expect(c.pieces[0]!.original.endsWith('\n')).toBe(true);
  });
  it('수식(줄 단위)도 원문 그대로 보존하고 글자 크기를 하한 이상으로 둔다', () => {
    const f = 'E[X] = Σ x · P(X = x)\nVar(X) = E[X²] − (E[X])²';
    const c = chunkMaterial({ sceneKey: 'sc2', kind: 'FORMULA', original: f });
    expect(reassemble(c.pieces)).toBe(f);
    expect(c.pieces[0]!.fontPx).toBeGreaterThanOrEqual(34);
  });
  it('가로로 긴 줄은 보이기만 접고 원문 줄은 바꾸지 않는다', () => {
    const line = `const result = await fetchUserProfile(${'argument, '.repeat(12)}last);`;
    const c = chunkMaterial({ sceneKey: 'sc2', kind: 'CODE', original: line });
    expect(c.pieces[0]!.wrapped).toBe(true);
    expect(c.pieces[0]!.displayLines.join('')).toBe(line);
    expect(c.pieces[0]!.original).toBe(line);
  });
  it('시간이 모자라면 내용을 줄이지 않고 실패한다', () => {
    const m: LearningMaterial = { sceneKey: 'sc2', kind: 'CODE', original: long };
    expect(planZoom(m, { startSec: 0, endSec: 3 })).toMatchObject({ ok: false, code: 'TOO_MANY_CHUNKS' });
    const ok = planZoom(m, { startSec: 4, endSec: 24 });
    expect(ok.ok && ok.plan.chunks.map((c) => [c.startSec, c.endSec])).toEqual([[4, 4 + 20 / 3], [4 + 20 / 3, 4 + 40 / 3], [4 + 40 / 3, 24]].map(([a, b]) => [Math.round(a! * 100) / 100, Math.round(b! * 100) / 100]));
  });
  it('빈 자료는 거절한다', () => {
    expect(planZoom({ sceneKey: 'sc2', kind: 'NOTE', original: '  \n' }, { startSec: 0, endSec: 9 })).toMatchObject({ ok: false, code: 'EMPTY_MATERIAL' });
  });
});
