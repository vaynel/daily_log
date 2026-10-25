import type { ProductionPlan, ProInfer } from '../briefing/briefing.js';
import type { Snapshot, VersionKind } from '../records/store.js';
import { buildScenePlan, type NarrationConfig, type PhotoRef, type ScenePlan, type SceneResult } from './scenePlan.js';

/** RecordStore 중 장면 계획이 쓰는 부분(시험에서 메모리 구현으로 대체 가능). */
export interface SceneRecords {
  loadById(ownerId: string, id: string, now: Date): Promise<Snapshot | null>;
  listAttachments(ownerId: string, interviewId: string): Promise<{ id: string; kind: string; capturedAt: Date | null }[]>;
  appendVersion(ownerId: string, interviewId: string, kind: VersionKind, content: unknown, now: Date): Promise<{ version: number; duplicate: boolean }>;
}

export type SceneStageResult =
  | { ok: true; version: number; duplicate: boolean; plan: ScenePlan }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_CONFIRMED' | 'PRO_UNAVAILABLE' | Extract<SceneResult, { ok: false }>['code']; state?: string };

const isBriefingPlan = (c: unknown): c is ProductionPlan => (c as ProductionPlan | null)?.source === 'BRIEFING';
const isScenePlan = (c: unknown): c is ScenePlan => (c as ScenePlan | null)?.kind === 'SCENE_PLAN';

/** 저장된 최신 장면 계획(없으면 null). 확인된 브리핑 계획과 같은 PRODUCTION_PLAN 버전 목록에 kind 로 구분해 쌓인다. */
export const latestScenePlan = (snap: Snapshot): { version: number; plan: ScenePlan } | null => {
  const v = snap.versions.filter((x) => x.kind === 'PRODUCTION_PLAN' && isScenePlan(x.content)).sort((a, b) => b.version - a.version)[0];
  return v ? { version: v.version, plan: v.content as ScenePlan } : null;
};

/**
 * VIDEO_PRODUCTION 의 장면 계획 단계. 사용자가 확인한 브리핑 계획(PRODUCTION_PLAN, source=BRIEFING)만 입력으로 쓰고,
 * 같은 브리핑 버전의 장면 계획이 이미 있으면 Pro 를 다시 부르지 않는다. 사진은 촬영 시각이 있는 것만 시각 근거가 된다.
 */
export async function runScenePlanStage(i: {
  records: SceneRecords; ownerId: string; interviewId: string; infer: ProInfer | null; narration?: Partial<NarrationConfig>; now?: () => Date;
}): Promise<SceneStageResult> {
  const now = (i.now ?? (() => new Date()))();
  const snap = await i.records.loadById(i.ownerId, i.interviewId, now);
  if (!snap) return { ok: false, code: 'NOT_FOUND' };
  const input = snap.versions.filter((v) => v.kind === 'PRODUCTION_PLAN' && isBriefingPlan(v.content)).sort((a, b) => b.version - a.version)[0]?.content as ProductionPlan | undefined;
  if (snap.interview.status !== 'CONFIRMED' || !input) return { ok: false, code: 'NOT_CONFIRMED' };
  const prior = latestScenePlan(snap);
  if (prior && prior.plan.briefingVersion === input.briefingVersion) return { ok: true, version: prior.version, duplicate: true, plan: prior.plan };
  if (!i.infer) return { ok: false, code: 'PRO_UNAVAILABLE' };
  const photos: PhotoRef[] = (await i.records.listAttachments(i.ownerId, i.interviewId)).filter((a) => a.kind === 'PHOTO').map((a) => ({ id: a.id, capturedAt: a.capturedAt }));
  const r = await buildScenePlan({ plan: input, photos, lifeDate: snap.interview.lifeDate, infer: i.infer, narration: i.narration });
  if (!r.ok) return { ok: false, code: r.code, ...(r.state ? { state: r.state } : {}) };
  const saved = await i.records.appendVersion(i.ownerId, i.interviewId, 'PRODUCTION_PLAN', r.plan, now);
  return { ok: true, version: saved.version, duplicate: saved.duplicate, plan: r.plan };
}
