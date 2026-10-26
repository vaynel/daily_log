import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AssetStatusState = 'WAITING_BUDGET' | 'WAITING_RESULT_UNKNOWN' | 'FAILED';
export interface AssetStatus { state: AssetStatusState; code: string; at: string; entryId?: string }
export interface AssetMeta {
  inputHash: string;
  outputSha256: string;
  mime: string;
  provider: string;
  createdAt: string;
  /** 캐릭터 자산이 따른 기준 시트의 SHA-256(외형 고정 증거). */
  referenceSha256?: string;
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 비공개 파일 저장소 위의 생성 자산 보관소. 자산 파일은 임시 파일에 쓴 뒤 이름을 바꿔 넣고,
 * 실패·대기 상태는 별도 status 파일에만 기록한다. 그래서 실패해도 기존 자산(이미지·메타)은 바뀌지 않는다.
 */
export class AssetStore {
  constructor(private readonly root: string) {}

  private dir(scope: string[], key: string): string {
    for (const p of [...scope, key]) if (!SAFE.test(p)) throw new Error('INVALID_ASSET_KEY');
    return path.join(this.root, ...scope, key);
  }

  async get(scope: string[], key: string): Promise<{ data: Buffer; meta: AssetMeta; file: string } | null> {
    const d = this.dir(scope, key);
    try {
      const meta = JSON.parse(await readFile(path.join(d, 'meta.json'), 'utf8')) as AssetMeta;
      const file = path.join(d, 'image.bin');
      return { data: await readFile(file), meta, file };
    } catch {
      return null;
    }
  }

  async status(scope: string[], key: string): Promise<AssetStatus | null> {
    try { return JSON.parse(await readFile(path.join(this.dir(scope, key), 'status.json'), 'utf8')) as AssetStatus; } catch { return null; }
  }

  async put(scope: string[], key: string, data: Buffer, meta: Omit<AssetMeta, 'outputSha256' | 'createdAt'>, now: Date): Promise<AssetMeta> {
    const d = this.dir(scope, key);
    await mkdir(d, { recursive: true });
    const full: AssetMeta = { ...meta, outputSha256: sha256(data), createdAt: now.toISOString() };
    const tmp = (n: string) => path.join(d, `${n}.${process.pid}.tmp`);
    await writeFile(tmp('image'), data);
    await writeFile(tmp('meta'), JSON.stringify(full));
    await rename(tmp('image'), path.join(d, 'image.bin'));
    await rename(tmp('meta'), path.join(d, 'meta.json'));
    await rm(path.join(d, 'status.json'), { force: true });
    return full;
  }

  async setStatus(scope: string[], key: string, s: AssetStatus): Promise<void> {
    const d = this.dir(scope, key);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'status.json'), JSON.stringify(s));
  }
}
