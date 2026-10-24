/**
 * 추정 단가. 이 러너는 Wiki07 §6 원문을 열람하지 못했으므로 기본값은 공개 단가 기반 임시값이다.
 * PM이 Wiki07 값으로 DAILY_LOG_VOICE_PRICING_JSON 에서 덮어쓴다(실측 전 확인 필요). 실제 청구액이 아니다.
 */
export interface Pricing {
  usdKrw: number;
  sttUsdPerMinute: number;
  ttsInputUsdPerKChar: number;
  ttsOutputUsdPerSecond: number;
}

export const DEFAULT_PRICING: Pricing = {
  usdKrw: 1500,
  sttUsdPerMinute: 0.003,
  ttsInputUsdPerKChar: 0.0003,
  ttsOutputUsdPerSecond: 0.00025,
};

export function loadPricing(env: NodeJS.ProcessEnv = process.env): Pricing {
  const raw = env.DAILY_LOG_VOICE_PRICING_JSON;
  if (!raw) return DEFAULT_PRICING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DAILY_LOG_VOICE_PRICING_JSON 이 올바른 JSON이 아님');
  }
  const merged = { ...DEFAULT_PRICING, ...(parsed as object) } as Pricing;
  for (const k of Object.keys(DEFAULT_PRICING) as (keyof Pricing)[]) {
    if (typeof merged[k] !== 'number' || !Number.isFinite(merged[k]) || merged[k] < 0) throw new Error(`단가 값이 올바르지 않음: ${k}`);
  }
  return merged;
}

export const sttCostKrw = (p: Pricing, seconds: number) => (seconds / 60) * p.sttUsdPerMinute * p.usdKrw;
export const ttsCostKrw = (p: Pricing, chars: number, outSeconds: number) =>
  ((chars / 1000) * p.ttsInputUsdPerKChar + outSeconds * p.ttsOutputUsdPerSecond) * p.usdKrw;
/** 한국어 합성 음성 길이 상한 추정(초당 약 4자). 사전 예산 확인용 보수값. */
export const estimateTtsSeconds = (chars: number) => Math.ceil(chars / 4) + 1;
