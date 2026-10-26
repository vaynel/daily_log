import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { paidCall } from '../budget/gateway.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import { type AssetStatus, type AssetStore, sha256 } from './assetStore.js';
import { backgroundRequest, characterRequest, type ExcludedReason, type ImageRequest, type PoseSpec } from './imageInput.js';
import { IMAGE_ESTIMATE_KRW, type ImageProvider, stripPhoto } from './imageProvider.js';
import type { Scene } from './scenePlan.js';

const run = promisify(execFile);

/** 선정된 캐릭터 A 기준 시트 v1(assets/character/A-ref-v1.jpg)의 SHA-256. 다른 파일이면 외형 고정이 깨지므로 생성하지 않는다. */
export const CHARACTER_SHEET_SHA256 = '8621a3082c9eb4221048fc062e0d5232b32003f5c490cd93cf0b2130531b1f3a';

export async function loadCharacterSheet(file: string): Promise<Buffer> {
  const data = await readFile(file);
  if (sha256(data) !== CHARACTER_SHEET_SHA256) throw new Error('SHEET_MISMATCH');
  return data;
}

export type AssetResult =
  | { ok: true; reused: boolean; file: string; outputSha256: string; entryId?: string }
  | { ok: false; code: ExcludedReason | 'BUDGET_EXCEEDED' | 'CALL_REJECTED' | 'CALL_UNKNOWN' | 'SAME_AS_INPUT'; status: AssetStatus['state'] | null; preserved: boolean };

interface Ctx {
  store: AssetStore; ledger: MonthlyLedger; provider: ImageProvider; scope: string[]; now?: () => Date;
  /** 같은 입력의 재요청 번호. 처리 오류 자동 재시도 1회 한도는 작업 큐가 관리하고, 여기서는 멱등키만 구분한다. */
  attempt?: number;
}

/** 요청 한 건(예약 → 호출 → 확정). 실패·대기 시 자산 파일은 건드리지 않고 상태만 남긴다. */
async function generate(c: Ctx, key: string, req: ImageRequest, inputHash: string, extra: { referenceSha256?: string; mustDifferFrom?: Buffer }): Promise<AssetResult> {
  const now = (c.now ?? (() => new Date()))();
  const prior = await c.store.get(c.scope, key);
  if (prior?.meta.inputHash === inputHash) return { ok: true, reused: true, file: prior.file, outputSha256: prior.meta.outputSha256 };
  const r = await paidCall({
    ledger: c.ledger, provider: c.provider.name, operation: 'image', purpose: 'PRODUCT', estimateKrw: IMAGE_ESTIMATE_KRW,
    idempotencyKey: `img:${c.scope.join('/')}:${key}:${inputHash.slice(0, 16)}:${c.attempt ?? 1}`,
    run: () => c.provider.generate(req),
  });
  const preserved = prior !== null;
  if (!r.ok) {
    const state: AssetStatus['state'] = r.code === 'BUDGET_EXCEEDED' ? 'WAITING_BUDGET' : r.code === 'CALL_UNKNOWN' ? 'WAITING_RESULT_UNKNOWN' : 'FAILED';
    await c.store.setStatus(c.scope, key, { state, code: r.code, at: now.toISOString(), ...('entryId' in r ? { entryId: r.entryId } : {}) });
    return { ok: false, code: r.code, status: state, preserved };
  }
  // 사진 원본 그대로를 돌려주는 응답은 "그림으로 다시 그린" 결과가 아니다.
  if (extra.mustDifferFrom && sha256(r.value.data) === sha256(extra.mustDifferFrom)) {
    await c.store.setStatus(c.scope, key, { state: 'FAILED', code: 'SAME_AS_INPUT', at: now.toISOString(), entryId: r.entryId });
    return { ok: false, code: 'SAME_AS_INPUT', status: 'FAILED', preserved };
  }
  const meta = await c.store.put(c.scope, key, r.value.data, { inputHash, mime: r.value.mime, provider: c.provider.name, ...(extra.referenceSha256 ? { referenceSha256: extra.referenceSha256 } : {}) }, now);
  return { ok: true, reused: false, file: (await c.store.get(c.scope, key))!.file, outputSha256: meta.outputSha256, entryId: r.entryId };
}

/** 장면 배경: 사진(있으면)을 메타데이터 제거 후 참조로 보내 색연필 스케치로 다시 그린다. 글자는 넣지 않는다. */
export async function generateBackground(c: Ctx, scene: Pick<Scene, 'key' | 'visual'>, photo: Buffer | null): Promise<AssetResult> {
  const stripped = photo ? await stripPhoto(photo) : null;
  const built = backgroundRequest(scene.visual, stripped);
  if (!built.ok) {
    return { ok: false, code: built.code, status: null, preserved: (await c.store.get(c.scope, `bg-${scene.key}`)) !== null };
  }
  const inputHash = sha256(`${built.request.prompt}|${stripped ? sha256(stripped) : '-'}`);
  return generate(c, `bg-${scene.key}`, built.request, inputHash, { mustDifferFrom: stripped ?? undefined });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'x';
export const poseKey = (p: PoseSpec) => `pose-A-${slug(p.expression)}-${slug(p.action)}`;

/** 표정·동작 자산: 같은 조합은 한 번만 만들고 모든 장면이 재사용한다. 기준 시트 해시를 메타에 남긴다. */
export function generatePose(c: Ctx, pose: PoseSpec, sheet: Buffer): Promise<AssetResult> {
  const sheetSha = sha256(sheet);
  if (sheetSha !== CHARACTER_SHEET_SHA256) return Promise.reject(new Error('SHEET_MISMATCH'));
  const req = characterRequest(pose, sheet);
  return generate(c, poseKey(pose), req, sha256(`${req.prompt}|${sheetSha}`), { referenceSha256: sheetSha });
}

// ---- 레이어 ----

export interface LayerManifest {
  sceneKey: string;
  /** 글자가 없는 배경 그림. 일반 배경에는 어떤 문장도 그려 넣지 않는다. */
  background: { file: string };
  character: { file: string; referenceSha256: string; pose: PoseSpec } | null;
  /** 학습 자료(핵심 문장)는 그림에 굽지 않고 별도 글자 레이어로 둔다. 자막 합성 단계(TASK-24)가 그린다. */
  learning: { lines: string[] } | null;
}

export function buildLayers(scene: Pick<Scene, 'key' | 'type' | 'narration'>, background: string, character: { file: string; referenceSha256: string; pose: PoseSpec } | null): LayerManifest {
  const lines = scene.type === 'LEARNING' ? scene.narration.split(/(?<=[.!?。])\s+/).filter(Boolean) : [];
  return { sceneKey: scene.key, background: { file: background }, character, learning: lines.length ? { lines } : null };
}

/** 배경과 캐릭터 레이어를 9:16 한 장으로 합친다(글자 없음). 캐릭터는 아래 가운데, 폭 45%. */
export async function composeFrame(layers: LayerManifest): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frame-'));
  try {
    const out = path.join(dir, 'frame.png');
    const args = ['-v', 'error', '-y', '-i', layers.background.file];
    if (layers.character) {
      args.push('-i', layers.character.file, '-filter_complex', '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[b];[1:v]scale=324:-1[c];[b][c]overlay=(W-w)/2:H-h-80');
    } else {
      args.push('-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280');
    }
    args.push('-frames:v', '1', out);
    await run('ffmpeg', args, { timeout: 60_000 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
