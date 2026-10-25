import type { Snapshot, VersionKind } from '../records/store.js';
import { RecordError } from '../records/store.js';
import type { BriefingRecords } from './routes.js';

import { TEST_INTERVIEW, TEST_OWNER } from '../interview/memory.testutil.js';

export const B_OWNER = TEST_OWNER;
export const B_ID = TEST_INTERVIEW;

/** 시험 전용 메모리 저장소. PG 구현(RecordStore.confirmBriefing)과 같은 원자성 규칙을 따른다. */
export class MemBriefingRecords implements BriefingRecords {
  items: Snapshot['items'] = [];
  attachments: Snapshot['attachments'] = [];
  versions: Snapshot['versions'] = [];
  status: 'IN_PROGRESS' | 'CONFIRMED' = 'IN_PROGRESS';
  revision = 1;
  production: Snapshot['pipeline']['production'] = 'NONE';
  jobs: { id: string; kind: string; subjectId: string; stages: string[]; key: string }[] = [];
  failJobInsert = false;
  async loadById(ownerId: string, id: string): Promise<Snapshot | null> {
    if (ownerId !== B_OWNER || id !== B_ID) return null;
    return {
      interview: { id, ownerId, lifeDate: '2026-10-25', startedAt: new Date(), status: this.status, revision: this.revision }, resumes: [],
      items: this.items, attachments: this.attachments, versions: structuredClone(this.versions),
      pipeline: { production: this.production, review: 'NONE', backup: 'NONE' }, audio: [],
    };
  }
  async saveItem(_o: string, _i: string, _key: string, kind: 'QUESTION' | 'ANSWER', body: string) {
    this.items.push({ id: `i${this.items.length + 1}`, seq: this.items.length + 1, kind, body });
  }
  async appendVersion(_o: string, _i: string, kind: VersionKind, content: unknown) {
    const last = this.versions.filter((v) => v.kind === kind).at(-1);
    if (last && JSON.stringify(last.content) === JSON.stringify(content)) return { version: last.version, duplicate: true };
    const version = (last?.version ?? 0) + 1;
    this.versions.push({ kind, version, content: structuredClone(content) });
    return { version, duplicate: false };
  }
  async confirmBriefing(_o: string, _i: string, o: { briefingVersion: number; plan: unknown; job: { kind: string; stages: string[]; idempotencyKey: string } }) {
    const last = this.versions.filter((v) => v.kind === 'SUMMARY').at(-1)?.version ?? 0;
    if (last !== o.briefingVersion) throw new RecordError('STALE_BRIEFING', 'stale');
    const prior = this.jobs.find((j) => j.key === o.job.idempotencyKey);
    if (prior) return { jobId: prior.id, duplicate: true, revision: this.revision };
    if (this.status === 'CONFIRMED') throw new RecordError('CONFIRMED_LOCKED', 'locked');
    // 트랜잭션 흉내: 작업 등록이 실패하면 확정·계획·상태가 모두 그대로여야 한다.
    if (this.failJobInsert) throw new Error('job insert failed');
    this.status = 'CONFIRMED'; this.revision += 1; this.production = 'QUEUED';
    this.versions.push({ kind: 'PRODUCTION_PLAN', version: 1, content: o.plan });
    const job = { id: `job${this.jobs.length + 1}`, kind: o.job.kind, subjectId: B_ID, stages: o.job.stages, key: o.job.idempotencyKey };
    this.jobs.push(job);
    return { jobId: job.id, duplicate: false, revision: this.revision };
  }
}
