import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { paidCall } from '../budget/gateway.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import { TransportError } from '../voice/transports.js';
import { keyOutBackground } from './keying.js';
import { AssetStore, sha256, type AssetMeta, type AssetStatus } from './assetStore.js';
import { backgroundPrompt, posePrompt, sanitizeVisual, stripPhoto } from './imageInput.js';
import type { Scene } from './scenePlan.js';

const run = promisify(execFile);

/**
 * 장면 배경·캐릭터 자산 생성(TASK-23). 모든 유료 이미지 호출은 월 예산 원장(paidCall)을 거치고,
 * 실패·예산 부족은 상태로만 남기며 이미 만든 자산은 바꾸지 않는다. 글자는 이미지에 넣지 않고 별도 레이어로 둔다.
 */

export const IMAGE_MODEL = 'gemini-3.1-flash-image';
/** 장당 추정 비용(원). */
export const IMAGE_ESTIMATE_KRW = 100;
/** TASK-14 에서 선정한 캐릭터 A 기준 시트 v1 의 SHA-256. 다른 파일이면 거절한다. */
export const REFERENCE_SHEET_SHA256 = '8621a3082c9eb4221048fc062e0d5232b32003f5c490cd93cf0b2130531b1f3a';
export const EXPRESSIONS = ['웃음', '놀람', '생각', '졸림'] as const;
export const ACTIONS = ['정면', '3/4', '옆', '뒤'] as const;
export type Expression = (typeof EXPRESSIONS)[number];
export type Action = (typeof ACTIONS)[number];

export interface ImageInput { mime: string; data: Buffer }
export interface ImageRequest { prompt: string; images: ImageInput[] }
/** 이미지 생성 제공자 경계. 러너 시험은 모의 구현만 쓴다. 오류에는 본문·키를 담지 않고 코드만 둔다. */
export type ImageProvider = (req: ImageRequest) => Promise<{ image: Buffer }>;

export function geminiImage(key: string, fetchImpl: typeof fetch = fetch, model = IMAGE_MODEL): ImageProvider {
  return async (req) => {
    // 키는 URL이 아니라 헤더로만 보낸다.
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: req.prompt }, ...req.images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.data.toString('base64') } }))] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
      }),
    });
    if (!res.ok) throw new TransportError(`IMG_HTTP_${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    const data = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new TransportError('IMG_EMPTY');
    return { image: Buffer.from(data, 'base64') };
  };
}

export type AssetResult =
  | { ok: true; key: string; reused: boolean; meta: AssetMeta; image: Buffer; /** 글자 의심이 남아 사람 확인이 필요한 자산. */ needsCheck?: boolean }
  | { ok: false; key: string; code: 'BUDGET_WAIT' | 'CALL_REJECTED' | 'NEEDS_CHECK' | 'SAME_AS_INPUT' | 'BAD_IMAGE' | 'SHEET_MISMATCH'; status: AssetStatus | null };

export interface AssetDeps {
  store: AssetStore;
  ledger: MonthlyLedger;
  provider: ImageProvider;
  /** 캐릭터 A 기준 시트 파일 경로(assets/character/A-ref-v1.jpg). */
  referenceSheetPath: string;
  ffmpeg?: string;
  /** 결과 이미지에 읽을 수 있는 글자가 남았는지 검사한다(true=의심). 없으면 검사하지 않는다. */
  detectText?: (image: Buffer) => Promise<boolean>;
}

const hashKey = (...parts: string[]) => sha256(Buffer.from(parts.join('\u0000'))).slice(0, 32);

/** 장면(자산 키)당 글자 의심 재생성은 1회까지. */
export const MAX_TEXT_REGEN = 1;

async function produce(
  d: AssetDeps,
  o: {
    key: string; kind: AssetMeta['kind']; prompt: string | ((retry: boolean) => string); images: ImageInput[]; mustDiffer: string[];
    meta: { sourceSha256?: string; referenceSha256?: string }; checkText?: boolean;
  },
): Promise<AssetResult> {
  const existing = await d.store.readImage(o.key);
  if (existing) {
    const st = await d.store.status(o.key);
    return { ok: true, key: o.key, reused: true, meta: existing.meta, image: existing.image, ...(st?.state === 'NEEDS_CHECK' ? { needsCheck: true } : {}) };
  }
  const prev = await d.store.status(o.key);
  // 이전 호출의 성공 여부를 모르면 확인 전에는 다시 보내지 않는다(중복 과금 방지).
  if (prev?.state === 'NEEDS_CHECK') return { ok: false, key: o.key, code: 'NEEDS_CHECK', status: prev };
  const base = prev?.attempts ?? 0;
  let kept: { image: Buffer; suspect: boolean } | null = null;
  for (let regen = 0; regen <= MAX_TEXT_REGEN; regen++) {
    const prompt = typeof o.prompt === 'string' ? o.prompt : o.prompt(regen > 0);
    const r = await paidCall({
      ledger: d.ledger, provider: 'gemini', operation: `image:${o.kind.toLowerCase()}`, purpose: regen > 0 ? 'RETRY' : 'PRODUCT', estimateKrw: IMAGE_ESTIMATE_KRW,
      idempotencyKey: `img:${o.key}:${base}:${regen}`,
      run: () => d.provider({ prompt, images: o.images }),
    });
    if (!r.ok) {
      // 재생성 단계의 실패는 첫 결과를 버리지 않고 글자 의심 상태로 남긴다.
      if (kept) break;
      if (r.code === 'BUDGET_EXCEEDED') return { ok: false, key: o.key, code: 'BUDGET_WAIT', status: await d.store.setStatus(o.key, 'WAITING_BUDGET', 'BUDGET_EXCEEDED') };
      if (r.code === 'CALL_REJECTED') return { ok: false, key: o.key, code: 'CALL_REJECTED', status: await d.store.setStatus(o.key, 'FAILED', 'CALL_REJECTED') };
      return { ok: false, key: o.key, code: 'NEEDS_CHECK', status: await d.store.setStatus(o.key, 'NEEDS_CHECK', 'CALL_UNKNOWN') };
    }
    let image: Buffer;
    try {
      image = await stripPhoto(r.value.image, d.ffmpeg); // 디코드 가능 여부 확인 + JPEG 정규화
    } catch {
      if (kept) break;
      return { ok: false, key: o.key, code: 'BAD_IMAGE', status: await d.store.setStatus(o.key, 'FAILED', 'BAD_IMAGE') };
    }
    const outHash = sha256(image);
    if (o.mustDiffer.includes(outHash) || o.mustDiffer.includes(sha256(r.value.image))) {
      if (kept) break;
      return { ok: false, key: o.key, code: 'SAME_AS_INPUT', status: await d.store.setStatus(o.key, 'FAILED', 'SAME_AS_INPUT') };
    }
    const suspect = o.checkText && d.detectText ? await d.detectText(image) : false;
    kept = { image, suspect };
    if (!suspect) break;
  }
  const { image, suspect } = kept!;
  const meta = await d.store.putImage(o.key, image, { kind: o.kind, ...o.meta });
  // 글자 의심이 재생성 후에도 남으면 자산은 보관하되 사람 확인 필요로 표시한다.
  await d.store.setStatus(o.key, suspect ? 'NEEDS_CHECK' : 'READY', suspect ? 'TEXT_SUSPECT' : null);
  return { ok: true, key: o.key, reused: false, meta, image, ...(suspect ? { needsCheck: true } : {}) };
}

/** 사진 → 색연필 스케치 배경. 사진은 메타데이터를 벗겨 보내고, 결과가 입력과 같으면 실패로 둔다. */
export async function generateBackground(d: AssetDeps, i: { photo: Buffer; visual: string; excludedPhrases?: string[] }): Promise<AssetResult> {
  const stripped = await stripPhoto(i.photo, d.ffmpeg);
  const visual = sanitizeVisual(i.visual, i.excludedPhrases).text;
  const prompt = backgroundPrompt(visual);
  const photoSha = sha256(stripped);
  return produce(d, {
    key: hashKey('bg', photoSha, prompt), kind: 'BACKGROUND', prompt: (retry) => (retry ? backgroundPrompt(visual, true) : prompt), checkText: true, images: [{ mime: 'image/jpeg', data: stripped }],
    mustDiffer: [photoSha, sha256(i.photo)], meta: { sourceSha256: photoSha },
  });
}

/** 기준 시트를 참조로 넣어 표정·동작 자산을 만든다. 같은 표정·동작은 다시 만들지 않고 재사용한다. */
export async function generatePose(d: AssetDeps, i: { expression: Expression; action: Action }): Promise<AssetResult> {
  if (!EXPRESSIONS.includes(i.expression) || !ACTIONS.includes(i.action)) throw new Error('지원하지 않는 표정·동작');
  const sheet = await readFile(d.referenceSheetPath);
  const sheetSha = sha256(sheet);
  if (sheetSha !== REFERENCE_SHEET_SHA256) return { ok: false, key: hashKey('pose', sheetSha), code: 'SHEET_MISMATCH', status: null };
  return produce(d, {
    key: hashKey('pose', sheetSha, i.expression, i.action), kind: 'POSE', prompt: posePrompt(i.expression, i.action),
    images: [{ mime: 'image/jpeg', data: sheet }], mustDiffer: [sheetSha], meta: { referenceSha256: sheetSha },
  });
}

// ---- 레이어 ----

export interface SceneLayers {
  sceneKey: string;
  background: { key: string };
  character: { key: string };
  /** 학습 장면의 핵심 문장. 이미지에 굽지 않고 자막·학습 자료 단계(TASK-24/25)가 따로 그린다. */
  learning: { lines: string[] } | null;
}

export function buildLayers(scene: Scene, background: { key: string }, character: { key: string }): SceneLayers {
  const lines = scene.narration.split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter(Boolean);
  return { sceneKey: scene.key, background, character, learning: scene.type === 'LEARNING' ? { lines } : null };
}

export const FRAME_W = 720;
export const FRAME_H = 1280;
/** 캐릭터 높이(화면 높이 대비)와 바닥 여백. 발이 아래쪽 바닥에 닿는 배치. */
export const CHARACTER_HEIGHT_RATIO = 0.45;
export const CHARACTER_BOTTOM_MARGIN = 48;
const CHARACTER_MAX_W = Math.round(FRAME_W * 0.9);

async function decodeRgba(file: string, maxDim: number, ffmpeg: string): Promise<{ rgba: Buffer; w: number; h: number }> {
  const dims = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [iw, ih] = dims.stdout.trim().split(',').map(Number) as [number, number];
  const k = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * k)), h = Math.max(2, Math.round(ih * k));
  const out = await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: w * h * 4 + 1024 });
  return { rgba: out.stdout, w, h };
}

/**
 * 배경 위에 캐릭터를 올린 720x1280 프레임. 캐릭터 컷의 흰/회색 바탕은 투명하게 처리하고(keyOutBackground),
 * 캐릭터 몸만 잘라 화면 높이 약 45% 로 맞춰 가운데 아래쪽(발이 바닥 근처)에 둔다. 글자는 그리지 않는다.
 */
export async function composeFrame(background: Buffer, character: Buffer, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-frame-'));
  try {
    const bgFile = path.join(dir, 'bg.jpg');
    const chFile = path.join(dir, 'ch.jpg');
    await writeFile(bgFile, background);
    await writeFile(chFile, character);
    const { rgba, w, h } = await decodeRgba(chFile, 1024, ffmpeg);
    const box = keyOutBackground(rgba, w, h);
    if (!box) throw new Error('CHARACTER_EMPTY');
    const cw = box.x1 - box.x0 + 1, ch = box.y1 - box.y0 + 1;
    await writeFile(path.join(dir, 'ch.rgba'), rgba);
    let th = Math.round(FRAME_H * CHARACTER_HEIGHT_RATIO);
    let tw = Math.round((cw * th) / ch);
    if (tw > CHARACTER_MAX_W) { tw = CHARACTER_MAX_W; th = Math.round((ch * tw) / cw); }
    const out = path.join(dir, 'out.jpg');
    await run(ffmpeg, [
      '-v', 'error', '-y', '-i', bgFile, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', path.join(dir, 'ch.rgba'),
      '-filter_complex',
      `[0:v]scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=increase,crop=${FRAME_W}:${FRAME_H}[b];` +
        `[1:v]crop=${cw}:${ch}:${box.x0}:${box.y0},scale=${tw}:${th}[c];[b][c]overlay=(W-w)/2:H-h-${CHARACTER_BOTTOM_MARGIN}`,
      '-frames:v', '1', '-q:v', '3', out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
