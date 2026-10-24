import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export class BudgetLedger {
  spentKrw = 0;
  constructor(public readonly limitKrw: number) {}
  /** 유료 호출 전에 확인: 지출 + 사전 추정이 상한을 넘으면 호출하지 않는다. */
  canSpend(estimateKrw: number) { return this.spentKrw < this.limitKrw && this.spentKrw + estimateKrw <= this.limitKrw; }
  add(krw: number) { this.spentKrw += krw; }
}

export interface TurnMetrics {
  n: number;
  at: string;
  latencyMs: { stt: number; pro: number; tts: number; total: number };
  sttSeconds: number;
  userChars: number;
  replyChars: number;
  ttsOutputSeconds: number;
  estimatedCostKrw: number;
}

/** 세션 기록(JSON). 발화·답변 원문은 저장하지 않고 길이·시간·비용만 남긴다. */
export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string | null;
  budgetKrw: number;
  calls: { stt: number; pro: number; tts: number };
  estimatedCostKrw: number;
  turns: TurnMetrics[];
  rejected: { at: string; code: string }[];
  stoppedReason: 'BUDGET' | null;
  pricingNote: string;
  feedback: { naturalness: number; unsupported: string[]; note: string; at: string } | null;
}

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SessionStore {
  private readonly cache = new Map<string, SessionRecord>();
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  create(budgetKrw: number, now: Date): SessionRecord {
    const s: SessionRecord = {
      id: randomUUID(), startedAt: now.toISOString(), endedAt: null, budgetKrw,
      calls: { stt: 0, pro: 0, tts: 0 }, estimatedCostKrw: 0, turns: [], rejected: [], stoppedReason: null,
      pricingNote: '추정 비용(임시 단가 가능). 실제 청구액 아님', feedback: null,
    };
    this.save(s);
    return s;
  }
  get(id: string): SessionRecord | undefined {
    if (!SESSION_ID.test(id)) return undefined;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const f = path.join(this.dir, `${id}.json`);
    if (!existsSync(f)) return undefined;
    const s = JSON.parse(readFileSync(f, 'utf8')) as SessionRecord;
    this.cache.set(id, s);
    return s;
  }
  save(s: SessionRecord) {
    this.cache.set(s.id, s);
    const f = path.join(this.dir, `${s.id}.json`);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, f);
  }
}
