import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AttachmentError, validateUpload, type AttachmentKind } from './policy.js';
import type { RecordStore } from '../records/store.js';

export interface UploadInput {
  ownerId: string;
  interviewId: string;
  key: string;
  kind: AttachmentKind;
  name: string;
  bytes: Buffer;
  itemId?: string;
  now: Date;
}

/**
 * 원본은 `<fileStorageDir>/attachments/<sha256>.<ext>` 에 내용당 한 번만 저장한다(같은 파일 재첨부·다른 기록 참조는 파일을 새로 쓰지 않음).
 * 검사 → 파일 저장 → DB 참조 순서이며, DB 저장이 거부되면 이번 요청이 새로 만든 파일은 지운다.
 */
export class AttachmentService {
  constructor(private readonly store: RecordStore, private readonly fileStorageDir: string) {}

  private dir() {
    return path.join(this.fileStorageDir, 'attachments');
  }

  async upload(i: UploadInput) {
    const v = validateUpload(i.kind, i.name, i.bytes, i.now);
    const storageKey = `${v.checksum}.${v.ext}`;
    const full = path.join(this.dir(), storageKey);
    const created = await this.writeOnce(full, i.bytes);
    try {
      const res = await this.store.saveFileAttachment(
        i.ownerId, i.interviewId, i.key,
        { itemId: i.itemId, storageKey, checksum: v.checksum, kind: v.kind, name: i.name.slice(0, 200), mime: v.mime, size: v.size, capturedAt: v.capturedAt, capturedSource: v.capturedSource },
        i.now,
      );
      // 저장하는 사이 다른 기록의 정리 작업이 같은 파일을 지웠다면 다시 쓴다(참조가 생긴 뒤에는 정리 작업이 지우지 않는다).
      await this.writeOnce(full, i.bytes);
      return { ...res, storageKey, kind: v.kind, capturedAt: v.capturedAt, capturedSource: v.capturedSource, size: v.size, storedNewFile: created };
    } catch (e) {
      // 같은 파일을 다른 요청이 이미 참조 중일 수 있으므로, 이번 요청이 만든 파일이고 참조가 하나도 없을 때만 지운다.
      if (created && !(await this.store.isStorageKeyReferenced(storageKey))) await rm(full, { force: true });
      throw e;
    }
  }

  /** 이미 있으면 쓰지 않는다. 임시 파일에 쓰고 rename 해 부분 파일이 남지 않게 한다. */
  private async writeOnce(full: string, bytes: Buffer): Promise<boolean> {
    if (await stat(full).then((s) => s.isFile(), () => false)) return false;
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, full);
    } finally {
      await rm(tmp, { force: true });
    }
    return true;
  }
}

export { AttachmentError };
