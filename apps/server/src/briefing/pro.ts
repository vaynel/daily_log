import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProInfer } from './briefing.js';

type SiwcInfer = (store: unknown, input: { model: string; text: string }, opts: { supportVerified: boolean }) => Promise<{ state: string; text?: string }>;
export interface SiwcRuntime { infer: SiwcInfer; store: unknown }

/**
 * Pro 구독 경로(scripts/siwc runtime.infer) 어댑터. 서버 설정이 빠졌거나 지원 확인(DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED=true)이
 * 없으면 null 을 돌려 PRO_UNAVAILABLE 로 fail closed 한다(제작 작업은 만들지 않음). 유료 모델로 자동 전환하지 않으며,
 * 대기·한도 상태는 state 코드 그대로 호출자에게 전달된다.
 */
export async function createProInfer(env: NodeJS.ProcessEnv, load: (siwcDir: string) => Promise<SiwcRuntime>): Promise<ProInfer | null> {
  const dir = env.DAILY_LOG_SIWC_DIR?.trim();
  const model = env.DAILY_LOG_VOICE_PRO_MODEL?.trim();
  if (!dir || !model || env.DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED?.trim() !== 'true') return null;
  let rt: SiwcRuntime;
  try { rt = await load(path.resolve(dir)); } catch { return null; }
  return (input) => rt.infer(rt.store, { model, text: input.text }, { supportVerified: true });
}

/** 저장소 루트의 scripts/siwc 를 읽는 실제 로더(apps/server/<src|dist>/briefing 기준 4단계 위). */
export async function loadSiwcRuntime(siwcDir: string): Promise<SiwcRuntime> {
  const root = path.resolve(import.meta.dirname, '../../../..');
  const rt = await import(pathToFileURL(path.join(root, 'scripts/siwc/runtime.mjs')).href);
  const auth = await import(pathToFileURL(path.join(root, 'scripts/siwc/auth.mjs')).href);
  return { infer: rt.infer, store: new auth.Store(siwcDir) };
}

const WAIT_REASONS: Record<string, string> = {
  WAIT_AUTH: 'Pro 계정 연결이 필요해 대기 중입니다.',
  WAIT_SUPPORT: 'Pro 지원 확인이 끝나지 않아 대기 중입니다.',
  WAIT_LIMIT: 'Pro 사용 한도에 도달해 한도가 풀릴 때까지 대기 중입니다. 유료 모델로는 바꾸지 않습니다.',
  WAIT_RETRY: 'Pro가 일시적으로 제한되어 잠시 뒤 다시 시도할 수 있습니다.',
  WAIT_PERMISSION: 'Pro 사용 권한 확인이 필요해 대기 중입니다.',
  WAIT_REVIEW: 'Pro 사용 검토가 끝나지 않아 대기 중입니다.',
  WAIT_RECONCILIATION: '이전 Pro 요청 결과를 확인하는 중이라 대기 중입니다.',
  UNSUPPORTED_INPUT: 'Pro가 이 입력을 처리하지 못했습니다.',
};
/** 사용자에게 보여 줄 대기 사유. 알 수 없는 상태 코드는 일반 문구로만 안내한다(원문 노출 없음). */
export const waitReason = (state: string | undefined): string => (state && WAIT_REASONS[state]) || 'Pro 정리가 지금 준비되지 않아 대기 중입니다.';
