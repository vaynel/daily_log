import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { PgRuleStore } from '../briefing/rules.js';
import { createProInfer, loadSiwcRuntime } from '../briefing/pro.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import type { Config } from '../config.js';
import { PermissionDeniedError, type StageHandler } from '../jobs/queue.js';
import { RecordStore } from '../records/store.js';
import { readKeyFile } from '../voice/keys.js';
import { loadPricing } from '../voice/pricing.js';
import { geminiNarrationTts, loadVoiceConfig } from './narration.js';
import { chromiumOverlay, type OverlayRenderer } from './overlay.js';
import { createVideoHandlers, pipelineOnStopped, type PipelineDeps } from './pipeline.js';
import { RenderGate } from './renderGate.js';
import { geminiImage } from './sceneAssets.js';

const REPO_ASSETS = path.resolve(import.meta.dirname, '../../../../assets');

/**
 * 운영 작업기(worker.ts)용 제작 처리기. 설정이 없는 제공자는 "없는 척 성공"하지 않고, 해당 단계가 호출 전에
 * PERMISSION 대기(예: TTS_NOT_CONFIGURED)로 멈춘다. 이때 예산 예약·외부 호출은 일어나지 않는다.
 * 품질 검수의 전사·사실/그림/학습/가독성 근거 제공자는 아직 연결되지 않아 quality 는 QUALITY_EVIDENCE_UNAVAILABLE 로 실패한다(통과로 추정 금지).
 */
export async function buildVideoRuntime(o: { config: Config; pool: pg.Pool; ledger: MonthlyLedger; env?: NodeJS.ProcessEnv }) {
  const env = o.env ?? process.env;
  const infer = await createProInfer(env, loadSiwcRuntime);
  const geminiKey = readKeyFile('DAILY_LOG_GEMINI_KEY_FILE', env.DAILY_LOG_GEMINI_KEY_FILE);
  const key = 'key' in geminiKey ? geminiKey.key : null;
  const voice = loadVoiceConfig(env.DAILY_LOG_VOICE_CONFIG?.trim() || path.join(REPO_ASSETS, 'voice/voice.json'));
  const records = new RecordStore(o.pool);

  let chromium: Awaited<ReturnType<typeof chromiumOverlay>> | null = null;
  const exe = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || env.DAILY_LOG_CHROMIUM_PATH?.trim();
  const overlay: OverlayRenderer = async (html) => {
    if (!exe) throw new Error('OVERLAY_UNAVAILABLE');
    chromium ??= await chromiumOverlay(exe);
    return chromium.render(html);
  };
  const missing = { tts: !key, image: !key, pro: !infer };

  const deps: PipelineDeps = {
    pool: o.pool, records, ledger: o.ledger, pricing: loadPricing(env),
    workDir: path.join(o.config.fileStorageDir, 'pipeline'), videoDir: path.join(o.config.fileStorageDir, 'videos'),
    infer: () => infer, voice: () => voice,
    tts: key ? geminiNarrationTts(key) : async () => { throw new PermissionDeniedError('TTS_NOT_CONFIGURED'); },
    image: key ? geminiImage(key) : async () => { throw new PermissionDeniedError('IMAGE_NOT_CONFIGURED'); },
    referenceSheetPath: path.join(REPO_ASSETS, 'character/A-ref-v1.jpg'),
    loadPhoto: async (storageKey) => {
      if (!/^[\w][\w.-]{0,200}$/.test(storageKey)) return null; // 저장소 키는 파일 이름만 허용
      return readFile(path.join(o.config.fileStorageDir, 'attachments', storageKey)).catch(() => null);
    },
    render: { overlay, workDir: path.join(o.config.fileStorageDir, 'pipeline', 'render-work') },
    gate: new RenderGate(o.pool),
    rules: new PgRuleStore(o.pool),
    quality: null,
    heartbeatMs: 15_000,
  };
  const handlers = createVideoHandlers(deps);
  // 호출 전 점검: 설정 없는 제공자를 쓰는 단계는 예산 예약 전에 권한 대기로 멈춘다.
  const guard = (h: StageHandler, absent: boolean, code: string): StageHandler => ({
    ...h, execute: async (ctx) => { if (absent) throw new PermissionDeniedError(code); return h.execute(ctx); },
  });
  handlers.scene_plan = guard(handlers.scene_plan!, missing.pro, 'PRO_UNAVAILABLE');
  handlers.narration = guard(handlers.narration!, missing.tts, 'TTS_NOT_CONFIGURED');
  handlers.assets = guard(handlers.assets!, missing.image, 'IMAGE_NOT_CONFIGURED');
  return { handlers, onStopped: pipelineOnStopped(o.pool), close: async () => { await chromium?.close(); } };
}
