import { BudgetLedger, SessionStore, type SessionRecord, type TurnMetrics } from './meter.js';
import { estimateTtsSeconds, sttCostKrw, ttsCostKrw, type Pricing } from './pricing.js';
import type { Transports } from './transports.js';

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

const INSTRUCTION = [
  '당신은 사용자의 하루를 함께 돌아보는 다정한 대화 상대입니다. 친한 사람과 이야기하듯 자연스러운 구어체 존댓말로 말하세요.',
  '답변 순서: (1) 방금 말한 내용의 구체적인 단어나 사실을 짚어 짧게 되받고, 그 말에 담긴 감정을 먼저 알아주세요(예: "아, 그게 드디어 됐군요. 뿌듯하셨겠어요."). (2) 이어서 상대가 더 이야기하고 싶어지는 열린 질문을 하나만 하세요.',
  '질문은 방금 이야기를 파고드는 후속 질문(어떻게 했는지, 왜 그랬는지, 그때 기분이나 의외였던 점)으로 하고, "어땠나요?" 같은 막연한 질문이나 앞과 같은 형태의 질문을 반복하지 마세요. 상대가 길게 털어놓을 때는 질문 없이 공감만 해도 됩니다.',
  '조언·평가·설교를 하지 말고, 대화의 초점을 자신에게 가져오지 마세요. 긍정적이고 따뜻하게, 칭찬은 구체적으로 하되 매번 하지는 마세요.',
  '소리 내어 읽기 좋게 전체 2~3문장, 짧게 말하세요. 사용자가 말하지 않은 사실을 만들거나 전날 일을 이어 묻지 마세요.',
].join('\n');

export class VoiceService {
  private readonly busy = new Set<string>();
  private readonly history = new Map<string, { user: string; ai: string }[]>();
  constructor(private readonly o: {
    t: Transports; pricing: Pricing; ledger: BudgetLedger; sessions: SessionStore; now?: () => number; clock?: () => Date;
  }) {}

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

    const charge = (krw: number) => { ledger.add(krw); s.estimatedCostKrw += krw; };
    const t0 = this.nowMs();

    // STT — 실패해도 호출이 나갔을 수 있어 사전 추정액을 청구로 센다.
    s.calls.stt++;
    let userText: string;
    try {
      userText = (await t.stt(audio, mime, sec)).text.trim();
      charge(sttEst);
    } catch {
      charge(sttEst);
      return this.reject(s, fail(502, 'STT_FAILED', '음성 인식에 실패했습니다. 잠시 후 다시 말씀해 주세요.'));
    }
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
    s.calls.tts++;
    let tts;
    try {
      tts = await t.tts(replyText);
    } catch {
      charge(ttsEst);
      return this.reject(s, fail(502, 'TTS_FAILED', '음성 합성에 실패했습니다.'));
    }
    const t3 = this.nowMs();
    const ttsCost = ttsCostKrw(pricing, replyText.length, tts.outputSeconds);
    charge(ttsCost);

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
