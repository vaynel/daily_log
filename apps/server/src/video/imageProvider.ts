import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { TransportError } from '../voice/transports.js';
import type { ImageRequest } from './imageInput.js';

const run = promisify(execFile);

export const IMAGE_MODEL = 'gemini-3.1-flash-image';
/** 장당 추정액(관리자 안내 약 100원). 단가가 바뀌면 이 값만 갱신한다. */
export const IMAGE_ESTIMATE_KRW = 100;

export interface GeneratedImage { mime: string; data: Buffer }
export interface ImageProvider {
  readonly name: string;
  generate(req: ImageRequest): Promise<GeneratedImage>;
}

/**
 * Gemini 이미지 제공자. 오류에는 상태 코드(IMAGE_HTTP_xxx)·고정 코드만 담고 키·본문은 담지 않는다.
 * 4xx 는 명시 거절(REJECTED), 그 외 오류·시간 초과는 성공 여부 불명(UNKNOWN)으로 분류된다(budget/gateway).
 */
export class GeminiImageProvider implements ImageProvider {
  readonly name = 'gemini-image';
  constructor(private readonly o: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; model?: string }) {}

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const f = this.o.fetch ?? fetch;
    const parts: unknown[] = [{ text: req.prompt }, ...req.references.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data.toString('base64') } }))];
    let res: Response;
    try {
      res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${this.o.model ?? IMAGE_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: req.aspectRatio } } }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
      });
    } catch {
      throw new TransportError('IMAGE_NETWORK');
    }
    if (!res.ok) throw new TransportError(`IMAGE_HTTP_${res.status}`);
    let body: { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }[] } }[] };
    try { body = await res.json() as typeof body; } catch { throw new TransportError('IMAGE_BAD_BODY'); }
    for (const p of body.candidates?.[0]?.content?.parts ?? []) {
      const d = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined);
      if (d?.data) return { mime: d.mimeType ?? 'image/png', data: Buffer.from(d.data, 'base64') };
    }
    // 200 이지만 이미지가 없음(안전 필터 등): 과금 여부를 알 수 없으므로 불명으로 둔다.
    throw new TransportError('IMAGE_EMPTY');
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 60_000 });
}

/**
 * 모의 제공자(러너·시험 전용, 외부 호출·비용 없음). 실제 그림체가 아니라 FFmpeg 윤곽선 변환으로
 * "원본과 다른 파일"이 만들어지는 경로만 검증한다. 화풍·구조 품질의 근거로 쓰지 않는다.
 */
export class MockImageProvider implements ImageProvider {
  readonly name = 'mock-image';
  calls: ImageRequest[] = [];
  constructor(private readonly o: { fail?: () => Error | null } = {}) {}

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    this.calls.push(req);
    const err = this.o.fail?.();
    if (err) throw err;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mock-img-'));
    try {
      const src = req.references[0];
      if (!src) throw new TransportError('IMAGE_HTTP_400');
      await writeFile(path.join(dir, 'in.jpg'), src.data);
      const out = path.join(dir, 'out.png');
      if (src.role === 'PHOTO') {
        await ffmpeg(['-i', path.join(dir, 'in.jpg'), '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,edgedetect=low=0.08:high=0.25:mode=colormix,eq=saturation=0.6:brightness=0.12,noise=alls=12:allf=t', '-frames:v', '1', out]);
      } else {
        // 기준 시트 왼쪽 위 한 컷을 흰 바탕 정사각형으로 잘라 돌려준다(캐릭터 외형은 시트와 동일).
        await ffmpeg(['-i', path.join(dir, 'in.jpg'), '-vf', 'crop=iw/4:ih/2:0:0,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:white', '-frames:v', '1', out]);
      }
      return { mime: 'image/png', data: await readFile(out) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** 사진의 EXIF·GPS 등 메타데이터를 제거하고 긴 변을 줄인 JPEG 로 다시 만든다. 원본 파일은 건드리지 않는다. */
export async function stripPhoto(data: Buffer, maxSide = 1280): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'strip-'));
  try {
    await writeFile(path.join(dir, 'in'), data);
    await ffmpeg(['-i', path.join(dir, 'in'), '-map_metadata', '-1', '-vf', `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`, '-frames:v', '1', '-q:v', '3', path.join(dir, 'out.jpg')]);
    return await readFile(path.join(dir, 'out.jpg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
