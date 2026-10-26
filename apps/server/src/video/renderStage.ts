import path from 'node:path';
import { NonRetryableError, type StageContext, type StageHandler } from '../jobs/queue.js';
import { renderVideo, RenderError, type RenderDeps, type RenderInput, type RenderOutcome } from './render.js';
import type { RenderGate } from './renderGate.js';

export const RENDER_STAGE = 'render';

export interface RenderStageDeps {
  gate: RenderGate;
  render: RenderDeps;
  /** 작업 대상(인터뷰)의 합성 입력을 모은다. 기록은 읽기만 한다. 입력이 없으면 null. */
  loadInput(subjectId: string, results: Record<string, unknown>): Promise<RenderInput | null>;
  /** 완성 영상 위치. */
  outFile(subjectId: string): string;
  /** 처리 중 임대를 연장하는 간격(ms). 큐 leaseMs 의 1/3 이하로 둔다. */
  heartbeatMs: number;
}

/** 작업 큐의 렌더 단계. 렌더는 gate 로 한 번에 하나만 돌고, 렌더 중에는 임대를 주기적으로 연장해 중복 실행을 막는다. */
export function createRenderHandler(d: RenderStageDeps): StageHandler {
  return {
    async execute(ctx: StageContext) {
      const input = await d.loadInput(ctx.subjectId, ctx.results);
      if (!input) throw new NonRetryableError('RENDER_INPUT_MISSING');
      const out = d.outFile(ctx.subjectId);
      // 차례를 기다리는 동안에도 작업이 RUNNING 이므로 대기 중에도 임대를 연장한다.
      const timer = setInterval(() => { void ctx.heartbeat().catch(() => {}); }, d.heartbeatMs);
      try {
        const r: RenderOutcome = await d.gate.run(() => renderVideo(d.render, input, out));
        return { result: { file: path.basename(r.file), sha256: r.sha256, bytes: r.bytes, durationSec: r.durationSec } };
      } catch (e) {
        // 입력 오류는 다시 해도 같다. 디스크·FFmpeg 오류는 일시 오류로 두어 큐의 자동 재시도 1회를 따른다.
        if (e instanceof RenderError && e.code === 'BAD_INPUT') throw new NonRetryableError('RENDER_BAD_INPUT');
        throw e;
      } finally {
        clearInterval(timer);
      }
    },
  };
}
