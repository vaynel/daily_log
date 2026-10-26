import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 생성 상태. 자산 파일과 별도 파일에 둬서 실패가 기존 자산을 건드리지 못하게 한다. */
export type AssetState = 'READY' | 'WAITING_BUDGET' | 'FAILED' | 'NEEDS_CHECK';
export interface AssetStatus {
  state: AssetState;
  /** 민감정보 없는 코드만. */
  code: string | null;
  attempts: number;
  updatedAt: string;
}
export interface AssetMeta {
  kind: 'BACKGROUND' | 'POSE';
  sha256: string;
  sourceSha256?: string;
  referenceSha256?: string;
  createdAt: string;
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * 파일 기반 자산 저장소. 이미지는 임시 파일에 쓴 뒤 rename 으로 교체하고, 상태(status.json)는 따로 기록한다.
 * 실패·예산 부족은 상태만 바꾸므로 이전에 만들어 둔 자산(image.jpg·meta.json)은 그대로 남는다.
 */
export class AssetStore {
  constructor(private readonly root: string) {}

  private dir(key: string) {
    if (!/^[a-f0-9]{8,64}$/.test(key)) throw new Error('자산 키가 올바르지 않음');
    return path.join(this.root, key);
  }

  async readImage(key: string): Promise<{ image: Buffer; meta: AssetMeta } | null> {
    try {
      const d = this.dir(key);
      const [image, meta] = await Promise.all([readFile(path.join(d, 'image.jpg')), readFile(path.join(d, 'meta.json'), 'utf8')]);
      const m = JSON.parse(meta) as AssetMeta;
      return sha256(image) === m.sha256 ? { image, meta: m } : null;
    } catch {
      return null;
    }
  }

  async status(key: string): Promise<AssetStatus | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(key), 'status.json'), 'utf8')) as AssetStatus;
    } catch {
      return null;
    }
  }

  async setStatus(key: string, state: AssetState, code: string | null): Promise<AssetStatus> {
    const prev = await this.status(key);
    const next: AssetStatus = { state, code, attempts: (prev?.attempts ?? 0) + (state === 'READY' || state === 'NEEDS_CHECK' || state === 'FAILED' ? 1 : 0), updatedAt: new Date().toISOString() };
    await this.atomic(path.join(this.dir(key), 'status.json'), Buffer.from(JSON.stringify(next)));
    return next;
  }

  /** 이미지와 메타를 새로 기록한다. 메타를 먼저 쓰고 이미지를 마지막에 교체한다(읽기는 해시 일치를 확인). */
  async putImage(key: string, image: Buffer, meta: Omit<AssetMeta, 'sha256' | 'createdAt'>): Promise<AssetMeta> {
    const full: AssetMeta = { ...meta, sha256: sha256(image), createdAt: new Date().toISOString() };
    const d = this.dir(key);
    await this.atomic(path.join(d, 'meta.json'), Buffer.from(JSON.stringify(full)));
    await this.atomic(path.join(d, 'image.jpg'), image);
    return full;
  }

  private async atomic(file: string, data: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}
