import type { Snapshot } from '../records/store.js';
import type { InterviewRecords } from './routes.js';

export const TEST_OWNER = 'user-me';
export const TEST_INTERVIEW = '11111111-1111-4111-8111-111111111111';

/** 시험 전용 메모리 기록 저장소(PostgreSQL 없이 인터뷰 라우트를 검증). */
export class MemRecords implements InterviewRecords {
  items: { id: string; seq: number; kind: 'QUESTION' | 'ANSWER'; body: string; key: string }[] = [];
  audio: Snapshot['audio'] = [];
  attachments: { id: string; itemId: string | null; storageKey: string; checksum: string; name: string }[] = [{ id: 'a1', itemId: null, storageKey: 'k', checksum: 'c', name: 'seed' }];
  status: 'IN_PROGRESS' | 'CONFIRMED' = 'IN_PROGRESS';
  backup: Snapshot['pipeline']['backup'] = 'NONE';
  async loadById(ownerId: string, id: string): Promise<Snapshot | null> {
    if (ownerId !== TEST_OWNER || id !== TEST_INTERVIEW) return null;
    return {
      interview: { id, ownerId, lifeDate: '2026-10-25', startedAt: new Date(), status: this.status, revision: 1 }, resumes: [],
      items: this.items.map(({ key, ...i }) => { void key; return i; }), attachments: this.attachments,
      versions: [], pipeline: { production: 'NONE', review: 'NONE', backup: this.backup }, audio: this.audio,
    };
  }
  async saveItem(_o: string, _i: string, key: string, kind: 'QUESTION' | 'ANSWER', body: string) {
    if (this.items.some((x) => x.key === key)) return;
    this.items.push({ id: `i${this.items.length + 1}`, seq: this.items.length + 1, kind, body, key });
  }
}
