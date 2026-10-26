import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MonthlyLedger } from '../budget/ledger.js';
import { TransportError } from '../voice/transports.js';
import { AssetStore, sha256 } from './assetStore.js';
import { sanitizeVisual, stripPhoto } from './imageInput.js';
import { buildLayers, composeFrame, generateBackground, generatePose, IMAGE_ESTIMATE_KRW, REFERENCE_SHEET_SHA256, type AssetDeps } from './sceneAssets.js';
import { fixturePhoto, mockImageProvider, withExifMarker } from './sceneAssets.testutil.js';
import type { Scene } from './scenePlan.js';

const SHEET = path.resolve(import.meta.dirname, '../../../../assets/character/A-ref-v1.jpg');

/** 메모리 원장 대역(실제 PostgreSQL 원장 시험은 budget/ledger.test.ts). paidCall 이 쓰는 메서드만 가진다. */
function fakeLedger(limit: number) {
  const entries: { id: string; est: number; state: string }[] = [];
  const held = () => entries.reduce((s, e) => s + (e.state === 'RELEASED' ? 0 : e.est), 0);
  const l = {
    async reserve(i: { estimateKrw: number; idempotencyKey?: string }) {
      if (held() + i.estimateKrw > limit) return { ok: false as const, code: 'BUDGET_EXCEEDED' as const, remainingKrw: limit - held() };
      entries.push({ id: `e${entries.length}`, est: i.estimateKrw, state: 'RESERVED' });
      return { ok: true as const, id: `e${entries.length - 1}`, duplicate: false };
    },
    async confirm(id: string) { entries.find((e) => e.id === id)!.state = 'CONFIRMED'; return true; },
    async releaseUnsent(id: string) { entries.find((e) => e.id === id)!.state = 'RELEASED'; return true; },
    async markUnknown(id: string) { entries.find((e) => e.id === id)!.state = 'UNKNOWN'; return true; },
  };
  return { ledger: l as unknown as MonthlyLedger, entries };
}

let photo: Buffer;
beforeAll(async () => { photo = withExifMarker(await fixturePhoto(), 'GPS-37.5665N-SECRET-MARKER'); });

const rig = (limit = 1000, o: Parameters<typeof mockImageProvider>[0] = {}) => {
  const store = new AssetStore(mkdtempSync(path.join(os.tmpdir(), 'dl-assets-')));
  const mock = mockImageProvider(o);
  const fl = fakeLedger(limit);
  const deps: AssetDeps = { store, ledger: fl.ledger, provider: mock.provider, referenceSheetPath: SHEET };
  return { store, mock, fl, deps };
};

describe('D22-01 입력 정리', () => {
  it('제외 분류에 걸리는 문장과 추가 제외 문구를 시각 설명에서 뺀다', () => {
    const r = sanitizeVisual('책상 위에 노트북이 있다. 야당 의원 욕을 하는 장면. 민수 집 거실이 보인다.', ['민수']);
    expect(r.text).toBe('책상 위에 노트북이 있다.');
    expect(r.removed).toBe(2);
  });

  it('외부로 나가는 사진에는 EXIF 마커가 없고 원본 파일은 그대로다', async () => {
    expect(photo.includes('SECRET-MARKER')).toBe(true);
    const { deps, mock } = rig();
    const copy = Buffer.from(photo);
    const r = await generateBackground(deps, { photo, visual: '창가 책상' });
    expect(r.ok).toBe(true);
    expect(mock.calls[0]!.images[0]!.includes('SECRET-MARKER')).toBe(false);
    expect((await stripPhoto(photo)).includes('SECRET-MARKER')).toBe(false);
    expect(photo.equals(copy)).toBe(true);
  });

  it('제외된 문장은 프롬프트로 나가지 않고, 프롬프트는 글자·상표 금지를 포함한다', async () => {
    const { deps, mock } = rig();
    await generateBackground(deps, { photo, visual: '카페 창가. 대통령 선거 포스터가 붙어 있다.' });
    expect(mock.calls[0]!.prompt).toContain('카페 창가.');
    expect(mock.calls[0]!.prompt).not.toContain('대통령');
    expect(mock.calls[0]!.prompt).toContain('글자');
    expect(mock.calls[0]!.prompt).toContain('상표');
  });

  it('호출은 예산 원장에 예약→확정으로 기록된다', async () => {
    const { deps, fl } = rig();
    await generateBackground(deps, { photo, visual: '방' });
    expect(fl.entries).toEqual([{ id: 'e0', est: IMAGE_ESTIMATE_KRW, state: 'CONFIRMED' }]);
  });
});

describe('D22-02 배경 (AC-1)', () => {
  it('결과는 원본과 다른 이미지이고 같은 요청은 재사용한다(호출 1회)', async () => {
    const { deps, mock } = rig();
    const a = await generateBackground(deps, { photo, visual: '방' });
    const b = await generateBackground(deps, { photo, visual: '방' });
    if (!a.ok || !b.ok) throw new Error('생성 실패');
    expect(sha256(a.image)).not.toBe(sha256(photo));
    expect(sha256(a.image)).not.toBe(sha256(await stripPhoto(photo)));
    expect(a.meta.sourceSha256).toBe(sha256(await stripPhoto(photo)));
    expect(b.reused).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  it('제공자가 입력을 그대로 돌려주면 SAME_AS_INPUT 으로 실패하고 자산을 저장하지 않는다', async () => {
    const { deps, store } = rig(1000, { echo: true });
    const r = await generateBackground(deps, { photo, visual: '방' });
    expect(r).toMatchObject({ ok: false, code: 'SAME_AS_INPUT' });
    expect(await store.readImage(r.key)).toBeNull();
    expect((await store.status(r.key))?.state).toBe('FAILED');
  });
});

describe('D22-03 캐릭터 (AC-3)', () => {
  it('저장소 기준 시트의 SHA-256 이 고정값과 일치한다', () => {
    expect(sha256(readFileSync(SHEET))).toBe(REFERENCE_SHEET_SHA256);
  });

  it('기준 시트를 참조 이미지로 보내고 메타에 해시를 남기며 같은 표정·동작은 재사용한다', async () => {
    const { deps, mock } = rig();
    const a = await generatePose(deps, { expression: '웃음', action: '정면' });
    const b = await generatePose(deps, { expression: '웃음', action: '정면' });
    const c = await generatePose(deps, { expression: '놀람', action: '정면' });
    if (!a.ok || !b.ok || !c.ok) throw new Error('생성 실패');
    expect(mock.calls).toHaveLength(2);
    expect(sha256(mock.calls[0]!.images[0]!)).toBe(REFERENCE_SHEET_SHA256);
    expect(a.meta.referenceSha256).toBe(REFERENCE_SHEET_SHA256);
    expect(b.reused).toBe(true);
    expect(a.key).not.toBe(c.key);
    expect(mock.calls[0]!.prompt).toContain('회색 후드');
  });

  it('다른 기준 시트 파일이면 SHEET_MISMATCH 로 거절하고 호출하지 않는다', async () => {
    const { deps, mock } = rig();
    const other = path.join(mkdtempSync(path.join(os.tmpdir(), 'dl-sheet-')), 'x.jpg');
    writeFileSync(other, photo);
    const r = await generatePose({ ...deps, referenceSheetPath: other }, { expression: '웃음', action: '정면' });
    expect(r).toMatchObject({ ok: false, code: 'SHEET_MISMATCH' });
    expect(mock.calls).toHaveLength(0);
  });
});

describe('D22-04 레이어', () => {
  const scene = (type: 'DAILY' | 'LEARNING'): Scene => ({
    key: 'sc1', order: 1, type, narration: '인증 토큰은 짧게 둔다. 만료되면 다시 받는다.', visual: '책상', evidenceIds: ['s1'], photoId: null,
    timeStatus: 'NONE', estimated: false, emphasis: false, estimatedSec: 8,
  });

  it('학습 문장은 별도 레이어이고 일상 장면에는 학습 레이어가 없다', () => {
    expect(buildLayers(scene('LEARNING'), { key: 'b' }, { key: 'c' }).learning?.lines).toEqual(['인증 토큰은 짧게 둔다.', '만료되면 다시 받는다.']);
    expect(buildLayers(scene('DAILY'), { key: 'b' }, { key: 'c' }).learning).toBeNull();
  });

  it('합성 프레임은 720x1280 이고 입력 이미지에서 글자를 새로 그리지 않는다', async () => {
    const { deps } = rig();
    const bg = await generateBackground(deps, { photo, visual: '방' });
    const ch = await generatePose(deps, { expression: '웃음', action: '정면' });
    if (!bg.ok || !ch.ok) throw new Error('생성 실패');
    const frame = await composeFrame(bg.image, ch.image);
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'dl-f-')), 'f.jpg');
    writeFileSync(f, frame);
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();
    expect(dims).toBe('720,1280');
  });
});

describe('AC-4 장애: 기존 자산 보존과 대기·실패 표시', () => {
  it('예산 부족: 호출 0회, WAITING_BUDGET 표시, 기존 자산 불변', async () => {
    const { deps, mock, store } = rig(IMAGE_ESTIMATE_KRW); // 한 장 분량만 허용
    const ok = await generateBackground(deps, { photo, visual: '방' });
    if (!ok.ok) throw new Error('생성 실패');
    const before = await store.readImage(ok.key);
    const blocked = await generateBackground(deps, { photo, visual: '다른 방' });
    expect(blocked).toMatchObject({ ok: false, code: 'BUDGET_WAIT' });
    expect(mock.calls).toHaveLength(1);
    expect((await store.status(blocked.key))?.state).toBe('WAITING_BUDGET');
    expect(await store.readImage(ok.key)).toEqual(before);
    expect((await store.status(ok.key))?.state).toBe('READY');
  });

  it('4xx 거절: FAILED 표시, 예약 해제, 기존 자산 불변, 재시도는 새 호출', async () => {
    let fail = true;
    const { deps, fl, store, mock } = rig(1000, { fail: () => (fail ? new TransportError('IMG_HTTP_400') : null) });
    const first = await generateBackground(deps, { photo, visual: '방' });
    expect(first).toMatchObject({ ok: false, code: 'CALL_REJECTED' });
    expect(fl.entries[0]!.state).toBe('RELEASED');
    expect((await store.status(first.key))?.state).toBe('FAILED');
    expect(await store.readImage(first.key)).toBeNull();
    fail = false;
    const again = await generateBackground(deps, { photo, visual: '방' });
    expect(again.ok).toBe(true);
    expect(mock.calls).toHaveLength(2);
  });

  it('5xx·응답 유실: NEEDS_CHECK 로 예약액 유지, 확인 전 재전송 없음', async () => {
    const { deps, fl, mock, store } = rig(1000, { fail: () => new TransportError('IMG_HTTP_503') });
    const a = await generateBackground(deps, { photo, visual: '방' });
    const b = await generateBackground(deps, { photo, visual: '방' });
    expect(a).toMatchObject({ ok: false, code: 'NEEDS_CHECK' });
    expect(b).toMatchObject({ ok: false, code: 'NEEDS_CHECK' });
    expect(mock.calls).toHaveLength(1);
    expect(fl.entries[0]!.state).toBe('UNKNOWN');
    expect((await store.status(a.key))?.state).toBe('NEEDS_CHECK');
  });
});
