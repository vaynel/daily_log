import { BudgetLedger, SessionStore, type SessionRecord, type TurnMetrics } from './meter.js';
import { classifyFailure } from '../budget/gateway.js';
import type { MonthlyLedger, Purpose } from '../budget/ledger.js';
import { estimateTtsSeconds, sttCostKrw, ttsCostKrw, type Pricing } from './pricing.js';
import type { Transports } from './transports.js';
import { INTERVIEW_INSTRUCTION } from '../interview/policy.js';

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MIN_AUDIO_BYTES = 800;
export const MAX_UTTERANCE_SEC = 60;
const MIME = /^audio\/(webm|ogg|mp4)\b/;

export type TurnFailure = { ok: false; status: number; code: string; message: string };
export type TurnSuccess = {
  ok: true;
  turn: { n: number; userText: string; replyText: string; metrics: TurnMetrics };
  audio: { mime: string; data: Buffer };
};

const fail = (status: number, code: string, message: string): TurnFailure => ({ ok: false, status, code, message });

/** 인터뷰 지시문은 interview/policy.ts 가 정의한다(TASK-19). 순차 시험 경로도 같은 지시문을 쓴다. */
export const INSTRUCTION = INTERVIEW_INSTRUCTION;

export class VoiceService {
  private readonly busy = new Set<string>();
  private readonly history = new Map<string, { user: string; ai: string }[]>();
  constructor(private readonly o: {
    t: Transports; pricing: Pricing; ledger: BudgetLedger; sessions: SessionStore; now?: () => number; clock?: () => Date;
    /** 월 원장. 있으면 모든 유료 호출을 예약→확정으로 기록하고 프로세스 단위 ledger 는 보조 장치가 된다. */
    monthly?: MonthlyLedger; purpose?: Purpose;
  }) {}

  /** 유료 호출 전 예약. 월 원장이 없으면 항상 통과(프로세스 단위 검사만). */
  private async hold(operation: string, krw: number): Promise<{ ok: true; id?: string } | { ok: false }> {
    const m = this.o.monthly;
    if (!m) return { ok: true };
    const r = await m.reserve({ provider: operation === 'stt' ? 'openai' : 'gemini', operation, purpose: this.o.purpose ?? 'TEST', estimateKrw: krw });
    return r.ok ? { ok: true, id: r.id } : { ok: false };
  }
  private async settle(id: string | undefined, krw: number) { if (id) await this.o.monthly!.confirm(id, krw); }
  /** 실패: 4xx 명시 거절이면 해제, 그 외(결과 불명)는 예약액을 유지한 채 불명 처리. @returns 요금을 센 경우 true */
  private async failHold(id: string | undefined, e: unknown): Promise<boolean> {
    if (!id) return true;
    if (classifyFailure(e) === 'REJECTED') { await this.o.monthly!.releaseUnsent(id); return false; }
    await this.o.monthly!.markUnknown(id, 'CALL_ERROR');
    return true;
  }

  private nowMs() { return (this.o.now ?? (() => performance.now()))(); }

  private reject(s: SessionRecord, f: TurnFailure) {
    if (s.rejected.length < 200) s.rejected.push({ at: (this.o.clock ?? (() => new Date()))().toISOString(), code: f.code });
    this.o.sessions.save(s);
    return f;
  }

  async turn(sessionId: string, audio: Buffer, mime: string, clientDurationMs: number | undefined): Promise<TurnSuccess | TurnFailure> {
    const s = this.o.sessions.get(sessionId);
    if (!s) return fail(404, 'SESSION_NOT_FOUND', '세션을 찾을 수 없습니다. 새로 시작하세요.');
    if (s.endedAt) return fail(409, 'SESSION_ENDED', '이미 끝난 세션입니다.');
    if (s.stoppedReason === 'BUDGET') return fail(402, 'BUDGET_EXCEEDED', '예산 상한에 도달해 중단되었습니다.');
    if (this.busy.has(s.id)) return this.reject(s, fail(409, 'BUSY', '이전 발화를 처리 중입니다. 동시 발화는 지원하지 않습니다.'));
    this.busy.add(s.id);
    try {
      return await this.run(s, audio, mime, clientDurationMs);
    } finally {
      this.busy.delete(s.id);
    }
  }

  private async run(s: SessionRecord, audio: Buffer, mime: string, clientDurationMs: number | undefined): Promise<TurnSuccess | TurnFailure> {
    const { t, pricing, ledger, sessions } = this.o;
    if (!MIME.test(mime)) return this.reject(s, fail(415, 'UNSUPPORTED_MIME', '지원하지 않는 오디오 형식입니다.'));
    if (audio.length > MAX_AUDIO_BYTES) return this.reject(s, fail(413, 'AUDIO_TOO_LARGE', '발화가 너무 깁니다. 더 짧게 말해 주세요.'));
    if (audio.length < MIN_AUDIO_BYTES) return this.reject(s, fail(422, 'EMPTY_AUDIO', '들린 음성이 없습니다. 다시 말씀해 주세요.'));

    // 길이를 모르면 상한으로 보수적으로 추정한다(무료 입력이 예산을 우회하지 못하게).
    const sec = clientDurationMs && clientDurationMs > 0 ? Math.min(clientDurationMs / 1000, MAX_UTTERANCE_SEC) : MAX_UTTERANCE_SEC;
    const sttEst = sttCostKrw(pricing, sec);
    const stop = () => {
      s.stoppedReason = 'BUDGET';
      return this.reject(s, fail(402, 'BUDGET_EXCEEDED', '예산 상한에 도달해 유료 호출 전에 중단했습니다.'));
    };
    if (!ledger.canSpend(sttEst)) return stop();
    const sttHold = await this.hold('stt', sttEst);
    if (!sttHold.ok) return stop();

    const charge = (krw: number) => { ledger.add(krw); s.estimatedCostKrw += krw; };
    const t0 = this.nowMs();

    // STT — 실패해도 호출이 나갔을 수 있어 사전 추정액을 청구로 센다.
    s.calls.stt++;
    let userText: string;
    try {
      userText = (await t.stt(audio, mime, sec)).text.trim();
    } catch (e) {
      if (await this.failHold(sttHold.id, e)) charge(sttEst);
      return this.reject(s, fail(502, 'STT_FAILED', '음성 인식에 실패했습니다. 잠시 후 다시 말씀해 주세요.'));
    }
    charge(sttEst);
    await this.settle(sttHold.id, sttEst);
    const t1 = this.nowMs();
    if (!userText) return this.reject(s, fail(422, 'STT_EMPTY', '말씀을 알아듣지 못했습니다. 다시 말씀해 주세요.'));

    // Pro 텍스트 (구독 경로: 비용 0, 호출 수만 계측). 자동 재시도·유료 대체 없음.
    s.calls.pro++;
    const hist = this.history.get(s.id) ?? [];
    const prompt = [INSTRUCTION, ...hist.slice(-6).flatMap((h) => [`사용자: ${h.user}`, `인터뷰어: ${h.ai}`]), `사용자: ${userText}`, '인터뷰어:'].join('\n');
    let replyText: string;
    try {
      const r = await t.pro(prompt);
      if (r.state !== 'SUCCEEDED' || !r.text?.trim()) {
        sessions.save(s);
        return this.reject(s, fail(503, `PRO_${r.state}`.slice(0, 40), '답변을 만들 수 없어 대기합니다. 유료 경로로 자동 전환하지 않습니다.'));
      }
      replyText = r.text.trim();
    } catch {
      return this.reject(s, fail(502, 'PRO_FAILED', '답변 생성에 실패했습니다.'));
    }
    const t2 = this.nowMs();

    const ttsEst = ttsCostKrw(pricing, replyText.length, estimateTtsSeconds(replyText.length));
    if (!ledger.canSpend(ttsEst)) return stop();
    const ttsHold = await this.hold('tts', ttsEst);
    if (!ttsHold.ok) return stop();
    s.calls.tts++;
    let tts;
    try {
      tts = await t.tts(replyText);
    } catch (e) {
      if (await this.failHold(ttsHold.id, e)) charge(ttsEst);
      return this.reject(s, fail(502, 'TTS_FAILED', '음성 합성에 실패했습니다.'));
    }
    const t3 = this.nowMs();
    const ttsCost = ttsCostKrw(pricing, replyText.length, tts.outputSeconds);
    charge(ttsCost);
    await this.settle(ttsHold.id, ttsCost);

    hist.push({ user: userText, ai: replyText });
    this.history.set(s.id, hist);
    const metrics: TurnMetrics = {
      n: s.turns.length + 1,
      at: (this.o.clock ?? (() => new Date()))().toISOString(),
      latencyMs: { stt: Math.round(t1 - t0), pro: Math.round(t2 - t1), tts: Math.round(t3 - t2), total: Math.round(t3 - t0) },
      sttSeconds: sec,
      userChars: userText.length,
      replyChars: replyText.length,
      ttsOutputSeconds: Math.round(tts.outputSeconds * 100) / 100,
      estimatedCostKrw: Math.round((sttEst + ttsCost) * 100) / 100,
    };
    s.turns.push(metrics);
    sessions.save(s);
    return { ok: true, turn: { n: metrics.n, userText, replyText, metrics }, audio: { mime: tts.mime, data: tts.audio } };
  }
}
