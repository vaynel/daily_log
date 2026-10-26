import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { paidCall } from '../budget/gateway.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import { TransportError } from '../voice/transports.js';
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
  | { ok: true; key: string; reused: boolean; meta: AssetMeta; image: Buffer }
  | { ok: false; key: string; code: 'BUDGET_WAIT' | 'CALL_REJECTED' | 'NEEDS_CHECK' | 'SAME_AS_INPUT' | 'BAD_IMAGE' | 'SHEET_MISMATCH'; status: AssetStatus | null };

export interface AssetDeps {
  store: AssetStore;
  ledger: MonthlyLedger;
  provider: ImageProvider;
  /** 캐릭터 A 기준 시트 파일 경로(assets/character/A-ref-v1.jpg). */
  referenceSheetPath: string;
  ffmpeg?: string;
}

const hashKey = (...parts: string[]) => sha256(Buffer.from(parts.join('\u0000'))).slice(0, 32);

async function produce(
  d: AssetDeps,
  o: { key: string; kind: AssetMeta['kind']; prompt: string; images: ImageInput[]; mustDiffer: string[]; meta: { sourceSha256?: string; referenceSha256?: string } },
): Promise<AssetResult> {
  const existing = await d.store.readImage(o.key);
  if (existing) return { ok: true, key: o.key, reused: true, meta: existing.meta, image: existing.image };
  const prev = await d.store.status(o.key);
  // 이전 호출의 성공 여부를 모르면 확인 전에는 다시 보내지 않는다(중복 과금 방지).
  if (prev?.state === 'NEEDS_CHECK') return { ok: false, key: o.key, code: 'NEEDS_CHECK', status: prev };
  const r = await paidCall({
    ledger: d.ledger, provider: 'gemini', operation: `image:${o.kind.toLowerCase()}`, purpose: 'PRODUCT', estimateKrw: IMAGE_ESTIMATE_KRW,
    idempotencyKey: `img:${o.key}:${prev?.attempts ?? 0}`,
    run: () => d.provider({ prompt: o.prompt, images: o.images }),
  });
  if (!r.ok) {
    if (r.code === 'BUDGET_EXCEEDED') return { ok: false, key: o.key, code: 'BUDGET_WAIT', status: await d.store.setStatus(o.key, 'WAITING_BUDGET', 'BUDGET_EXCEEDED') };
    if (r.code === 'CALL_REJECTED') return { ok: false, key: o.key, code: 'CALL_REJECTED', status: await d.store.setStatus(o.key, 'FAILED', 'CALL_REJECTED') };
    return { ok: false, key: o.key, code: 'NEEDS_CHECK', status: await d.store.setStatus(o.key, 'NEEDS_CHECK', 'CALL_UNKNOWN') };
  }
  let image: Buffer;
  try {
    image = await stripPhoto(r.value.image, d.ffmpeg); // 디코드 가능 여부 확인 + JPEG 정규화
  } catch {
    return { ok: false, key: o.key, code: 'BAD_IMAGE', status: await d.store.setStatus(o.key, 'FAILED', 'BAD_IMAGE') };
  }
  const outHash = sha256(image);
  if (o.mustDiffer.includes(outHash) || o.mustDiffer.includes(sha256(r.value.image))) {
    return { ok: false, key: o.key, code: 'SAME_AS_INPUT', status: await d.store.setStatus(o.key, 'FAILED', 'SAME_AS_INPUT') };
  }
  const meta = await d.store.putImage(o.key, image, { kind: o.kind, ...o.meta });
  await d.store.setStatus(o.key, 'READY', null);
  return { ok: true, key: o.key, reused: false, meta, image };
}

/** 사진 → 색연필 스케치 배경. 사진은 메타데이터를 벗겨 보내고, 결과가 입력과 같으면 실패로 둔다. */
export async function generateBackground(d: AssetDeps, i: { photo: Buffer; visual: string; excludedPhrases?: string[] }): Promise<AssetResult> {
  const stripped = await stripPhoto(i.photo, d.ffmpeg);
  const visual = sanitizeVisual(i.visual, i.excludedPhrases).text;
  const prompt = backgroundPrompt(visual);
  const photoSha = sha256(stripped);
  return produce(d, {
    key: hashKey('bg', photoSha, prompt), kind: 'BACKGROUND', prompt, images: [{ mime: 'image/jpeg', data: stripped }],
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

/** 배경 위에 캐릭터 컷을 올린 720x1280 프레임. 글자는 그리지 않는다. */
export async function composeFrame(background: Buffer, character: Buffer, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-frame-'));
  try {
    await writeFile(path.join(dir, 'bg.jpg'), background);
    await writeFile(path.join(dir, 'ch.jpg'), character);
    await run(ffmpeg, [
      '-v', 'error', '-y', '-i', path.join(dir, 'bg.jpg'), '-i', path.join(dir, 'ch.jpg'),
      '-filter_complex', `[0:v]scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=increase,crop=${FRAME_W}:${FRAME_H}[b];[1:v]scale=360:-2[c];[b][c]overlay=(W-w)/2:H-h-80`,
      '-frames:v', '1', '-q:v', '3', path.join(dir, 'out.jpg'),
    ]);
    return await readFile(path.join(dir, 'out.jpg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
