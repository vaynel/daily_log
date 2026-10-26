import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MonthlyLedger } from '../budget/ledger.js';
import { TransportError } from '../voice/transports.js';
import { AssetStore, sha256 } from './assetStore.js';
import { backgroundRequest, sanitizeVisual } from './imageInput.js';
import { GeminiImageProvider, MockImageProvider } from './imageProvider.js';
import { buildLayers, CHARACTER_SHEET_SHA256, composeFrame, generateBackground, generatePose, loadCharacterSheet, poseKey } from './sceneAssets.js';

const SHEET = path.resolve(__dirname, '../../../../assets/character/A-ref-v1.jpg');

/** 원장 대역: paidCall 이 쓰는 메서드만 구현(실제 원장 시험은 budget/ledger.test.ts, PostgreSQL 필요). */
function fakeLedger(limit = 1000) {
  const entries: { id: string; state: string; est: number; key?: string }[] = [];
  const held = () => entries.reduce((s, e) => s + (e.state === 'RELEASED' ? 0 : e.est), 0);
  const l = {
    entries,
    async reserve(i: { estimateKrw: number; idempotencyKey?: string }) {
      const dup = entries.find((e) => i.idempotencyKey && e.key === i.idempotencyKey);
      if (dup) return { ok: true, id: dup.id, duplicate: true };
      if (held() + i.estimateKrw > limit) return { ok: false, code: 'BUDGET_EXCEEDED', remainingKrw: limit - held() };
      const e = { id: `e${entries.length + 1}`, state: 'RESERVED', est: i.estimateKrw, key: i.idempotencyKey };
      entries.push(e);
      return { ok: true, id: e.id, duplicate: false };
    },
    async confirm(id: string, krw: number) { const e = entries.find((x) => x.id === id)!; e.state = 'CONFIRMED'; e.est = krw; },
    async releaseUnsent(id: string) { entries.find((x) => x.id === id)!.state = 'RELEASED'; },
    async markUnknown(id: string) { entries.find((x) => x.id === id)!.state = 'UNKNOWN'; },
  };
  return l as typeof l & MonthlyLedger;
}

let photo: Buffer;
let sheet: Buffer;
beforeAll(async () => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'ph-')), 'p.jpg');
  // EXIF 위치 정보가 들어 있는 사진을 흉내 낸다(메타데이터 제거 확인용).
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', '-metadata', 'location=+37.5665+126.9780/', '-metadata', 'comment=GPSMARK', f]);
  // ffmpeg 는 JPEG 에 메타데이터를 쓰지 않으므로 EXIF(APP1) 구간을 직접 끼워 넣는다.
  const jpg = readFileSync(f);
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSMARK lat=37.5665 lon=126.9780')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  photo = Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
  sheet = await loadCharacterSheet(SHEET);
});

const mk = () => ({ store: new AssetStore(mkdtempSync(path.join(os.tmpdir(), 'assets-'))), scope: ['u1', 'iv1'], now: () => new Date('2026-10-26T00:00:00Z') });

describe('D22-01 이미지 입력', () => {
  it('제외 대상 문장을 설명에서 빼고, 전부 제외면 요청을 만들지 않는다', () => {
    const s = sanitizeVisual('책상 위에 노트북이 있다. 국회의원 선거 포스터가 붙어 있다.');
    expect(s).toEqual({ ok: true, text: '책상 위에 노트북이 있다.', removed: 1 });
    expect(sanitizeVisual('정당 집회 장면')).toEqual({ ok: false, code: 'EXCLUDED_ALL' });
    expect(backgroundRequest('고소장을 받은 장면', null)).toEqual({ ok: false, code: 'EXCLUDED_ALL' });
  });
  it('보안 학습 장면은 막지 않는다', () => {
    expect(sanitizeVisual('취약점 예방 화면을 보는 책상').ok).toBe(true);
  });
  it('제공자로 나가는 프롬프트에 대사·근거 id가 없고 글자 금지가 들어간다', async () => {
    const p = new MockImageProvider();
    const c = { ...mk(), ledger: fakeLedger(), provider: p };
    await generateBackground(c, { key: 'sc1', visual: '창가 책상과 노트북.' }, photo);
    expect(p.calls[0]!.prompt).toContain('글자·숫자');
    expect(p.calls[0]!.prompt).toContain('창가 책상과 노트북.');
    expect(p.calls[0]!.references.map((r) => r.role)).toEqual(['PHOTO']);
  });
  it('참조 사진은 메타데이터(위치·주석)가 제거되어 전달된다', async () => {
    const p = new MockImageProvider();
    await generateBackground({ ...mk(), ledger: fakeLedger(), provider: p }, { key: 'sc1', visual: '창가 책상.' }, photo);
    const sent = p.calls[0]!.references[0]!.data;
    expect(photo.includes('GPSMARK')).toBe(true);
    expect(sent.includes('GPSMARK')).toBe(false);
    expect(sent.includes('126.9780')).toBe(false);
  });
});

describe('AC-1 배경은 원본 그대로가 아니다 (모의 제공자: 경로 검증만)', () => {
  it('결과 파일이 원본과 다른 이미지로 저장되고 예산이 확정된다', async () => {
    const l = fakeLedger();
    const c = { ...mk(), ledger: l, provider: new MockImageProvider() };
    const r = await generateBackground(c, { key: 'sc1', visual: '창가 책상.' }, photo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outputSha256).not.toBe(sha256(photo));
    expect(statSync(r.file).size).toBeGreaterThan(1000);
    expect(l.entries).toEqual([expect.objectContaining({ state: 'CONFIRMED', est: 100 })]);
  });
  it('제공자가 사진을 그대로 돌려주면 자산으로 받아들이지 않는다', async () => {
    const same = { name: 'echo', generate: async (req: { references: { data: Buffer }[] }) => ({ mime: 'image/jpeg', data: req.references[0]!.data }) };
    const c = { ...mk(), ledger: fakeLedger(), provider: same };
    const r = await generateBackground(c, { key: 'sc1', visual: '창가 책상.' }, photo);
    expect(r).toMatchObject({ ok: false, code: 'SAME_AS_INPUT', status: 'FAILED' });
    expect(await c.store.get(c.scope, 'bg-sc1')).toBeNull();
  });
  it('같은 입력은 다시 만들지 않고(비용 0) 재사용한다', async () => {
    const p = new MockImageProvider();
    const c = { ...mk(), ledger: fakeLedger(), provider: p };
    await generateBackground(c, { key: 'sc1', visual: '창가 책상.' }, photo);
    const again = await generateBackground(c, { key: 'sc1', visual: '창가 책상.' }, photo);
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(p.calls).toHaveLength(1);
  });
});

describe('AC-3 캐릭터 자산', () => {
  it('기준 시트가 다르면 거부한다', async () => {
    await expect(generatePose({ ...mk(), ledger: fakeLedger(), provider: new MockImageProvider() }, { expression: '웃음', action: '서기' }, Buffer.from('other'))).rejects.toThrow('SHEET_MISMATCH');
    expect(sha256(sheet)).toBe(CHARACTER_SHEET_SHA256);
  });
  it('기준 시트를 참조로 보내고 시트 해시를 메타에 남기며, 같은 조합은 재사용한다', async () => {
    const p = new MockImageProvider();
    const c = { ...mk(), ledger: fakeLedger(), provider: p };
    const pose = { expression: '웃음', action: '노트북 보기' };
    const a = await generatePose(c, pose, sheet);
    const b = await generatePose(c, pose, sheet);
    expect(a.ok && b.ok && b.reused && a.outputSha256 === b.outputSha256).toBe(true);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.references[0]).toMatchObject({ role: 'CHARACTER_SHEET' });
    expect(sha256(p.calls[0]!.references[0]!.data)).toBe(CHARACTER_SHEET_SHA256);
    const stored = await c.store.get(c.scope, poseKey(pose));
    expect(stored?.meta.referenceSha256).toBe(CHARACTER_SHEET_SHA256);
  });
});

describe('AC-4 예산 부족·생성 실패', () => {
  const scene = { key: 'sc1', visual: '창가 책상.' };
  it('예산 부족이면 제공자를 부르지 않고 기존 배경을 그대로 두며 대기를 표시한다', async () => {
    const base = mk();
    const ok = await generateBackground({ ...base, ledger: fakeLedger(), provider: new MockImageProvider() }, scene, photo);
    expect(ok.ok).toBe(true);
    const before = (await base.store.get(base.scope, 'bg-sc1'))!;
    const p = new MockImageProvider();
    const r = await generateBackground({ ...base, ledger: fakeLedger(50), provider: p }, { ...scene, visual: '다른 설명으로 바뀐 장면.' }, photo);
    expect(r).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED', status: 'WAITING_BUDGET', preserved: true });
    expect(p.calls).toHaveLength(0);
    const after = (await base.store.get(base.scope, 'bg-sc1'))!;
    expect(after.meta).toEqual(before.meta);
    expect(sha256(after.data)).toBe(sha256(before.data));
    expect(await base.store.status(base.scope, 'bg-sc1')).toMatchObject({ state: 'WAITING_BUDGET' });
  });
  it('4xx 거절은 실패로 표시하고 예약을 해제하며, 기존 자산은 보존한다', async () => {
    const base = mk();
    await generateBackground({ ...base, ledger: fakeLedger(), provider: new MockImageProvider() }, scene, photo);
    const l = fakeLedger();
    const bad = new MockImageProvider({ fail: () => new TransportError('IMAGE_HTTP_400') });
    const r = await generateBackground({ ...base, ledger: l, provider: bad }, { ...scene, visual: '새 설명.' }, photo);
    expect(r).toMatchObject({ ok: false, code: 'CALL_REJECTED', status: 'FAILED', preserved: true });
    expect(l.entries[0]!.state).toBe('RELEASED');
    expect((await base.store.get(base.scope, 'bg-sc1'))!.meta.inputHash).toBeTruthy();
  });
  it('응답 유실(5xx·네트워크)은 예약을 유지하고 결과 확인 대기로 표시하며, 같은 요청을 다시 보내지 않는다', async () => {
    const base = mk();
    const l = fakeLedger();
    const bad = new MockImageProvider({ fail: () => new TransportError('IMAGE_HTTP_503') });
    const r = await generateBackground({ ...base, ledger: l, provider: bad }, scene, photo);
    expect(r).toMatchObject({ ok: false, code: 'CALL_UNKNOWN', status: 'WAITING_RESULT_UNKNOWN', preserved: false });
    expect(l.entries[0]!.state).toBe('UNKNOWN');
    const ok = new MockImageProvider();
    const again = await generateBackground({ ...base, ledger: l, provider: ok }, scene, photo);
    expect(again).toMatchObject({ ok: false, code: 'CALL_UNKNOWN' });
    expect(ok.calls).toHaveLength(0);
  });
  it('Gemini 제공자: HTTP 오류 코드만 남기고 키는 오류에 없다', async () => {
    const p = new GeminiImageProvider({ apiKey: 'SECRET-KEY', fetch: (async () => new Response('{"error":"SECRET-KEY"}', { status: 429 })) as typeof fetch });
    const e = await p.generate({ prompt: 'x', references: [], aspectRatio: '9:16' }).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(TransportError);
    expect(String(e)).not.toContain('SECRET');
    expect((e as TransportError).code).toBe('IMAGE_HTTP_429');
  });
  it('Gemini 제공자: 요청 형식과 응답 이미지 해석', async () => {
    let seen: { url: string; body: { contents: { parts: unknown[] }[]; generationConfig: { imageConfig: { aspectRatio: string } } }; key: string } | null = null;
    const png = Buffer.from('PNGDATA');
    const p = new GeminiImageProvider({ apiKey: 'K', fetch: (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string), key: (init.headers as Record<string, string>)['x-goog-api-key']! };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }), { status: 200 });
    }) as unknown as typeof fetch });
    const out = await p.generate({ prompt: 'p', references: [{ mime: 'image/jpeg', data: Buffer.from('r'), role: 'PHOTO' }], aspectRatio: '9:16' });
    expect(out.data.equals(png)).toBe(true);
    expect(seen!.url).toContain('gemini-3.1-flash-image:generateContent');
    expect(seen!.body.contents[0]!.parts).toHaveLength(2);
    expect(seen!.body.generationConfig.imageConfig.aspectRatio).toBe('9:16');
  });
});

describe('D22-04 레이어 분리', () => {
  it('학습 장면의 핵심 문장은 글자 레이어로만 두고 그림 합성 결과에는 들어가지 않는다', async () => {
    const base = mk();
    const c = { ...base, ledger: fakeLedger(), provider: new MockImageProvider() };
    const bg = await generateBackground(c, { key: 'sc2', visual: '노트북 화면 앞 책상.' }, photo);
    const pose = await generatePose(c, { expression: '생각', action: '턱 괴기' }, sheet);
    if (!bg.ok || !pose.ok) throw new Error('setup');
    const scene = { key: 'sc2', type: 'LEARNING' as const, narration: '인덱스는 조회를 빠르게 한다. 쓰기는 조금 느려진다.' };
    const layers = buildLayers(scene, bg.file, { file: pose.file, referenceSha256: CHARACTER_SHEET_SHA256, pose: { expression: '생각', action: '턱 괴기' } });
    expect(layers.learning?.lines).toEqual(['인덱스는 조회를 빠르게 한다.', '쓰기는 조금 느려진다.']);
    expect(buildLayers({ ...scene, type: 'DAILY' }, bg.file, null).learning).toBeNull();
    const frame = await composeFrame(layers);
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: frame }).toString().trim();
    expect(dims).toBe('720,1280');
  });
});
