import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ImageProvider } from './sceneAssets.js';

const run = promisify(execFile);

/** 시험용 합성 사진(JPEG). 색 막대 위에 위치 구분용 격자를 그린다. */
export async function fixturePhoto(size = '640x480'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-fx-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=1`, '-frames:v', '1', path.join(dir, 'p.jpg')]);
    return await readFile(path.join(dir, 'p.jpg'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** JPEG 에 EXIF(APP1) 마커를 끼워 넣는다. */
export function withExifMarker(jpeg: Buffer, marker: string): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(marker)]);
  const seg = Buffer.alloc(4); seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
}

/** 모의 이미지 제공자: 입력 이미지를 윤곽선 처리해 원본과 다른 그림을 돌려준다(실제 화풍 아님). 받은 요청을 기록한다. */
export function mockImageProvider(o: { fail?: () => Error | null; echo?: boolean } = {}) {
  const calls: { prompt: string; imageHashes: string[]; images: Buffer[] }[] = [];
  const provider: ImageProvider = async (req) => {
    calls.push({ prompt: req.prompt, imageHashes: [], images: req.images.map((i) => i.data) });
    const err = o.fail?.();
    if (err) throw err;
    if (o.echo) return { image: req.images[0]!.data };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-mock-'));
    try {
      await writeFile(path.join(dir, 'in.jpg'), req.images[0]!.data);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, 'in.jpg'), '-vf', 'edgedetect=low=0.1:high=0.3,negate,noise=alls=20:allf=t', '-frames:v', '1', path.join(dir, 'out.png')]);
      return { image: await readFile(path.join(dir, 'out.png')) };
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  return { provider, calls };
}

/** 휴대폰 사진처럼 JPEG 뒤에 부가 데이터(두 번째 JPEG)를 붙인다. */
export function withTrailingJpeg(jpeg: Buffer, extra: Buffer): Buffer {
  return Buffer.concat([jpeg, extra]);
}

async function lavfiJpeg(filter: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-fx-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-q:v', '2', path.join(dir, 'p.jpg')]);
    return await readFile(path.join(dir, 'p.jpg'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export const solidJpeg = (color: string, size: string) => lavfiJpeg(`color=c=${color}:s=${size}`);

/** 회색 바탕 위의 캐릭터 대역: 검은 윤곽 안에 흰 몸(윤곽 안쪽 흰색은 지워지면 안 된다). */
export const characterOnGray = () =>
  lavfiJpeg('color=c=0xC8C8C8:s=540x960,drawbox=x=170:y=300:w=200:h=500:color=black:t=fill,drawbox=x=180:y=310:w=180:h=480:color=white:t=fill');
