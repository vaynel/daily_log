import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * 제외 명령 분류와 사용자 반복 제외 기준(TASK-22).
 * - 이번 영상 제외: 이번 브리핑의 해당 항목만 영상에서 뺀다. 규칙은 만들지 않는다.
 * - 원본 삭제: 이 경로에서는 실행하지 않는다(별도 삭제 확인 절차). 영상 제외와 분리한다.
 * - 반복 제외: 사용자가 확인(confirm)한 뒤에만 범주·키워드로 저장한다. 발언 원문은 저장하지 않는다.
 * 정치·비방·뒷담화·형사 사건은 exclusion.ts 의 상시 기준으로 이미 항상 적용되며, 여기 규칙은 그 위에 더하는 사용자 기준이다.
 */
export type CommandScope = 'THIS_VIDEO' | 'DELETE_ORIGINAL' | 'ALWAYS_EXCLUDE' | 'UNCLEAR';

const NEGATED_DELETE = /(?:삭제|지우|지워|없애|파기)\S*\s*(?:하지\s*)?(?:말|마|않|안)/g;
const DELETE = /삭제|지우|지워|없애|파기/;
const ALWAYS = /앞으로|다음부터|이제부터|항상|매번|계속|언제나|영원히/;
const EXCLUDE = /빼|제외|넣지|쓰지|언급하지|다루지/;

/** 음성·버튼 명령 문장을 범위로 분류한다. 삭제가 있으면 항상 삭제로 보고 영상 제외나 규칙으로 처리하지 않는다. */
export function classifyCommand(text: string): CommandScope {
  const t = text.replace(NEGATED_DELETE, ' ');
  if (DELETE.test(t)) return 'DELETE_ORIGINAL';
  if (!EXCLUDE.test(t)) return 'UNCLEAR';
  return ALWAYS.test(t) ? 'ALWAYS_EXCLUDE' : 'THIS_VIDEO';
}

/** 명령에서 따옴표로 지정한 단어만 키워드 후보로 뽑는다. 문장 전체를 저장하지 않는다. */
export function keywordsFromCommand(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["'“”‘’「」]([^"'“”‘’「」]{2,20})["'“”‘’「」]/g)) out.push(m[1]!.trim());
  return [...new Set(out)].slice(0, MAX_KEYWORDS);
}

export const RULE_CATEGORIES = ['PRIVATE_LIFE', 'WORK_CONFIDENTIAL', 'OTHER'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];
export const RULE_CATEGORY_LABEL: Record<RuleCategory, string> = { PRIVATE_LIFE: '사생활', WORK_CONFIDENTIAL: '업무 비공개', OTHER: '기타' };

export const MAX_KEYWORDS = 5;
export const MAX_RULES = 50;
const KEYWORD_LEN = [2, 20] as const;

export interface RuleEvent { at: string; action: 'CREATED' | 'UPDATED' | 'DISABLED' | 'ENABLED'; category: RuleCategory; keywordCount: number }
export interface ExclusionRule { id: string; category: RuleCategory; keywords: string[]; active: boolean; createdAt: string; updatedAt: string; history: RuleEvent[] }

export type RuleInput = { category: RuleCategory; keywords: string[] };

/** 범주와 키워드 검증·정리. 문장 길이의 입력이나 개수 초과는 거부한다(원문 복제 방지). */
export function normalizeRuleInput(i: { category?: unknown; keywords?: unknown }): RuleInput | null {
  if (typeof i.category !== 'string' || !(RULE_CATEGORIES as readonly string[]).includes(i.category)) return null;
  if (!Array.isArray(i.keywords) || i.keywords.length < 1 || i.keywords.length > MAX_KEYWORDS) return null;
  const keywords: string[] = [];
  for (const k of i.keywords) {
    if (typeof k !== 'string') return null;
    const v = k.replace(/\s+/g, ' ').trim();
    if (v.length < KEYWORD_LEN[0] || v.length > KEYWORD_LEN[1] || v.split(' ').length > 2) return null;
    if (!keywords.some((x) => x.toLowerCase() === v.toLowerCase())) keywords.push(v);
  }
  return { category: i.category as RuleCategory, keywords };
}

/** 활성 규칙 중 문장에 걸리는 것. 없으면 null. */
export function matchRule(text: string, rules: ExclusionRule[]): ExclusionRule | null {
  const t = text.toLowerCase();
  return rules.find((r) => r.active && r.keywords.some((k) => t.includes(k.toLowerCase()))) ?? null;
}

export class RuleError extends Error {
  constructor(readonly code: 'LIMIT' | 'NOT_FOUND', message: string) { super(message); }
}

export interface ExclusionRuleStore {
  list(ownerId: string): Promise<ExclusionRule[]>;
  /** 같은 범주·키워드가 이미 있으면 그 규칙을 (비활성이면 다시 켜서) 돌려준다. */
  create(ownerId: string, input: RuleInput, now: Date): Promise<ExclusionRule>;
  update(ownerId: string, id: string, patch: { category?: RuleCategory; keywords?: string[]; active?: boolean }, now: Date): Promise<ExclusionRule>;
}

const sameKeywords = (a: string[], b: string[]) => a.length === b.length && [...a].map((x) => x.toLowerCase()).sort().join('\u0000') === [...b].map((x) => x.toLowerCase()).sort().join('\u0000');
const event = (r: Pick<ExclusionRule, 'category' | 'keywords'>, action: RuleEvent['action'], now: Date): RuleEvent => ({ at: now.toISOString(), action, category: r.category, keywordCount: r.keywords.length });

/** 저장소 공통 변경 로직. 이력에는 동작·범주·키워드 개수만 남기고 키워드 값도 복제하지 않는다. */
export function createRule(existing: ExclusionRule[], input: RuleInput, now: Date): { rule: ExclusionRule; created: boolean } {
  const dup = existing.find((r) => r.category === input.category && sameKeywords(r.keywords, input.keywords));
  if (dup) return { rule: dup.active ? dup : reviseRule(dup, { active: true }, now), created: false };
  if (existing.length >= MAX_RULES) throw new RuleError('LIMIT', '저장할 수 있는 제외 기준 수를 넘었습니다');
  const iso = now.toISOString();
  return { rule: { id: randomUUID(), ...input, active: true, createdAt: iso, updatedAt: iso, history: [event(input, 'CREATED', now)] }, created: true };
}

export function reviseRule(r: ExclusionRule, patch: { category?: RuleCategory; keywords?: string[]; active?: boolean }, now: Date): ExclusionRule {
  const next: ExclusionRule = { ...r, category: patch.category ?? r.category, keywords: patch.keywords ?? r.keywords, history: [...r.history] };
  const edited = next.category !== r.category || !sameKeywords(next.keywords, r.keywords);
  if (edited) next.history.push(event(next, 'UPDATED', now));
  if (patch.active !== undefined && patch.active !== r.active) { next.active = patch.active; next.history.push(event(next, patch.active ? 'ENABLED' : 'DISABLED', now)); }
  if (next.history.length !== r.history.length) next.updatedAt = now.toISOString();
  return next;
}

const plain = (r: ExclusionRule & { ownerId: string }): ExclusionRule => structuredClone({ id: r.id, category: r.category, keywords: r.keywords, active: r.active, createdAt: r.createdAt, updatedAt: r.updatedAt, history: r.history });

/** 시험·DB 없는 환경용. */
export class MemoryRuleStore implements ExclusionRuleStore {
  readonly rows = new Map<string, ExclusionRule & { ownerId: string }>();
  private mine(ownerId: string) { return [...this.rows.values()].filter((r) => r.ownerId === ownerId); }
  async list(ownerId: string) { return this.mine(ownerId).map(plain); }
  async create(ownerId: string, input: RuleInput, now: Date) {
    const { rule } = createRule(await this.list(ownerId), input, now);
    this.rows.set(rule.id, { ...structuredClone(rule), ownerId });
    return rule;
  }
  async update(ownerId: string, id: string, patch: { category?: RuleCategory; keywords?: string[]; active?: boolean }, now: Date) {
    const cur = this.rows.get(id);
    if (!cur || cur.ownerId !== ownerId) throw new RuleError('NOT_FOUND', '제외 기준을 찾을 수 없습니다');
    const next = reviseRule(plain(cur), patch, now);
    this.rows.set(id, { ...next, ownerId });
    return structuredClone(next);
  }
}

const toRule = (r: Record<string, unknown>): ExclusionRule => ({
  id: r.id as string, category: r.category as RuleCategory, keywords: r.keywords as string[], active: r.active as boolean,
  createdAt: new Date(r.created_at as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(), history: r.history as RuleEvent[],
});

export class PgRuleStore implements ExclusionRuleStore {
  constructor(private readonly pool: pg.Pool) {}
  async list(ownerId: string) {
    const r = await this.pool.query('SELECT * FROM exclusion_rules WHERE owner_id = $1 ORDER BY created_at, id', [ownerId]);
    return r.rows.map(toRule);
  }
  async create(ownerId: string, input: RuleInput, now: Date) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`exclusion_rules:${ownerId}`]);
      const cur = (await c.query('SELECT * FROM exclusion_rules WHERE owner_id = $1 ORDER BY created_at, id', [ownerId])).rows.map(toRule);
      const { rule, created } = createRule(cur, input, now);
      if (created) {
        await c.query('INSERT INTO exclusion_rules (id, owner_id, category, keywords, active, history, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)',
          [rule.id, ownerId, rule.category, rule.keywords, rule.active, JSON.stringify(rule.history), now]);
      } else if (rule.history.length !== cur.find((x) => x.id === rule.id)!.history.length) {
        await c.query('UPDATE exclusion_rules SET active = $3, history = $4::jsonb, updated_at = $5 WHERE id = $1 AND owner_id = $2', [rule.id, ownerId, rule.active, JSON.stringify(rule.history), now]);
      }
      await c.query('COMMIT');
      return rule;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async update(ownerId: string, id: string, patch: { category?: RuleCategory; keywords?: string[]; active?: boolean }, now: Date) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT * FROM exclusion_rules WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, ownerId]);
      if (!r.rows[0]) throw new RuleError('NOT_FOUND', '제외 기준을 찾을 수 없습니다');
      const next = reviseRule(toRule(r.rows[0]), patch, now);
      await c.query('UPDATE exclusion_rules SET category = $3, keywords = $4, active = $5, history = $6::jsonb, updated_at = $7 WHERE id = $1 AND owner_id = $2',
        [id, ownerId, next.category, next.keywords, next.active, JSON.stringify(next.history), now]);
      await c.query('COMMIT');
      return next;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
}
