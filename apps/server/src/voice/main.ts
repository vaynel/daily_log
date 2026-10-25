import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildVoiceApp, DEFAULT_BUDGET_KRW } from './app.js';
import { loadVoiceKeys, VoiceConfigError } from './keys.js';
import { loadLiveConfig } from './live.js';
import { loadPricing } from './pricing.js';
import { geminiTts, openaiStt, siwcPro, type Transports } from './transports.js';

/** 음성 시험 서버 진입점. 키 파일 문제는 포트를 열기 전에 종료(코드 78)한다. */
async function main() {
  const env = process.env;
  let keys;
  try {
    keys = loadVoiceKeys(env);
  } catch (e) {
    if (e instanceof VoiceConfigError) {
      console.error(e.message);
      process.exit(78);
    }
    throw e;
  }
  const missing = ['DAILY_LOG_VOICE_SESSION_DIR', 'DAILY_LOG_SIWC_DIR', 'DAILY_LOG_VOICE_PRO_MODEL'].filter((k) => !env[k]?.trim());
  if (missing.length) {
    console.error(`음성 시험 설정 누락: ${missing.join(', ')}`);
    process.exit(78);
  }
  const budget = Number(env.DAILY_LOG_VOICE_BUDGET_KRW ?? DEFAULT_BUDGET_KRW);
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error('DAILY_LOG_VOICE_BUDGET_KRW 값이 올바르지 않음');
    process.exit(78);
  }
  // 저장소 루트의 scripts/siwc (src·dist 어느 쪽에서든 apps/server/<src|dist>/voice 기준 4단계 위).
  const root = path.resolve(import.meta.dirname, '../../../..');
  const rt = await import(pathToFileURL(path.join(root, 'scripts/siwc/runtime.mjs')).href);
  const auth = await import(pathToFileURL(path.join(root, 'scripts/siwc/auth.mjs')).href);
  const store = new auth.Store(path.resolve(env.DAILY_LOG_SIWC_DIR!));
  const transports: Transports = {
    stt: openaiStt(keys.openai),
    pro: siwcPro(rt.infer, store, env.DAILY_LOG_VOICE_PRO_MODEL!, env.DAILY_LOG_VOICE_PRO_SUPPORT_VERIFIED === 'true'),
    tts: geminiTts(keys.gemini),
  };
  const app = buildVoiceApp({ transports, sessionDir: path.resolve(env.DAILY_LOG_VOICE_SESSION_DIR!), budgetKrw: budget, pricing: loadPricing(env), live: loadLiveConfig(keys.gemini, env) });
  await app.listen({ port: Number(env.DAILY_LOG_VOICE_PORT ?? 3100), host: env.HOST?.trim() || '127.0.0.1' });
}

await main();
