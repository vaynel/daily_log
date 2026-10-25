import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { BudgetLedger } from './meter.js';
import { SESSION_ID } from './meter.js';
import { INSTRUCTION } from './pipeline.js';
import { LIVE_PAGE } from './live-page.js';

/**
 * 실시간 음성 대화(TASK-75): 브라우저 마이크 PCM → 이 서버 → Gemini Live(BidiGenerateContent) → 오디오 → 브라우저.
 * 키는 서버 파일에서 읽어 업스트림 헤더로만 보낸다. 브라우저·로그·응답에는 키도 임시 토큰도 없다.
 */

export interface LivePricing { usdKrw: number; inputUsdPerMTok: number; outputUsdPerMTok: number }
/** 3.1 flash live 오디오 입력 $3/1M·출력 $12/1M. 텍스트 토큰도 같은 단가로 세는 보수 추정이다. 실제 청구액이 아니다. */
export const DEFAULT_LIVE_PRICING: LivePricing = { usdKrw: 1500, inputUsdPerMTok: 3, outputUsdPerMTok: 12 };

export interface LiveConfig {
  key: string;
  model: string;
  url: string;
  voice: string;
  instruction: string;
  pricing: LivePricing;
  /** 브라우저가 보내는 PCM16 mono 샘플레이트. */
  inputRate: number;
  /** 맥락 창 압축(슬라이딩 윈도우). null 이면 압축 없음(비용 비교용). */
  compression: { triggerTokens: number; targetTokens: number } | null;
  /** 한 턴의 입력 토큰이 이 값을 넘으면 새 턴 전에 세션을 끝낸다(비용 폭주 방지). */
  maxInputTokens: number;
  minSpeechMs: number;
  noSpeechMs: number;
  /** 마지막 음성 뒤에도 업스트림으로 계속 보내는 무음 길이(Live 의 자동 무음 감지가 말 끝을 판단하는 데 필요). */
  tailMs: number;
  prerollMs: number;
  rmsThreshold: number;
  maxSessionMs: number;
  connectTimeoutMs: number;
}

export const GEMINI_LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const num = (v: string | undefined, d: number, min: number, max: number) => {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('DAILY_LOG_VOICE_LIVE_* 설정값이 올바르지 않음');
  return n;
};

export function loadLiveConfig(key: string, env: NodeJS.ProcessEnv = process.env): LiveConfig {
  let pricing = DEFAULT_LIVE_PRICING;
  if (env.DAILY_LOG_VOICE_LIVE_PRICING_JSON) {
    let p: unknown;
    try { p = JSON.parse(env.DAILY_LOG_VOICE_LIVE_PRICING_JSON); } catch { throw new Error('DAILY_LOG_VOICE_LIVE_PRICING_JSON 이 올바른 JSON이 아님'); }
    pricing = { ...DEFAULT_LIVE_PRICING, ...(p as object) };
    for (const k of Object.keys(DEFAULT_LIVE_PRICING) as (keyof LivePricing)[]) {
      if (typeof pricing[k] !== 'number' || !Number.isFinite(pricing[k]) || pricing[k] < 0) throw new Error(`Live 단가 값이 올바르지 않음: ${k}`);
    }
  }
  const trigger = num(env.DAILY_LOG_VOICE_LIVE_COMPRESSION_TRIGGER_TOKENS, 8000, 0, 100000);
  const target = num(env.DAILY_LOG_VOICE_LIVE_COMPRESSION_TARGET_TOKENS, 4000, 1, 100000);
  if (trigger > 0 && target >= trigger) throw new Error('압축 목표 토큰은 시작 토큰보다 작아야 함');
  return {
    key,
    model: env.DAILY_LOG_VOICE_LIVE_MODEL?.trim() || 'gemini-3.1-flash-live-preview',
    url: env.DAILY_LOG_VOICE_LIVE_URL?.trim() || GEMINI_LIVE_URL,
    voice: env.DAILY_LOG_VOICE_LIVE_VOICE?.trim() || 'Kore',
    instruction: INSTRUCTION,
    pricing,
    inputRate: num(env.DAILY_LOG_VOICE_LIVE_INPUT_RATE, 16000, 8000, 48000),
    compression: trigger > 0 ? { triggerTokens: trigger, targetTokens: target } : null,
    maxInputTokens: num(env.DAILY_LOG_VOICE_LIVE_MAX_INPUT_TOKENS, 12000, 1000, 1000000),
    minSpeechMs: 300,
    noSpeechMs: 8000,
    tailMs: 1500,
    prerollMs: 300,
    rmsThreshold: 0.02,
    maxSessionMs: num(env.DAILY_LOG_VOICE_LIVE_MAX_SESSION_SEC, 900, 10, 7200) * 1000,
    connectTimeoutMs: 10000,
  };
}

export interface LiveTurn {
  n: number;
  at: string;
  userText: string;
  replyText: string;
  /** 사용자 말 끝(서버가 받은 마지막 음성 프레임) → 첫 오디오를 브라우저로 보낸 시각. */
  latencyMs: number | null;
  /** 말 끝 → 업스트림(Live)이 첫 오디오를 준 시각. 이 중계가 통제할 수 없는 부분. */
  upstreamLatencyMs: number | null;
  /** 이 서버가 더한 지연 = 마지막 음성 프레임 수신→업스트림 전송 + 첫 오디오 수신→브라우저 전송. */
  serverOverheadMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
  interrupted: boolean;
}

export interface LiveSessionRecord {
  id: string;
  kind: 'live';
  model: string;
  startedAt: string;
  endedAt: string | null;
  budgetKrw: number;
  estimatedCostKrw: number;
  totals: { inputTokens: number; outputTokens: number; maxInputTokens: number };
  compression: LiveConfig['compression'];
  interrupts: number;
  turns: LiveTurn[];
  notices: { at: string; code: string }[];
  stoppedReason: string | null;
  pricingNote: string;
}

/** 세션 기록(JSON, 0600). 원문 음성은 저장하지 않는다. 전사 텍스트는 이 파일에만 있다. */
export class LiveSessionStore {
  private readonly cache = new Map<string, LiveSessionRecord>();
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  private file(id: string) { return path.join(this.dir, `live-${id}.json`); }
  create(model: string, budgetKrw: number, compression: LiveConfig['compression'], now: Date): LiveSessionRecord {
    const s: LiveSessionRecord = {
      id: randomUUID(), kind: 'live', model, startedAt: now.toISOString(), endedAt: null, budgetKrw, estimatedCostKrw: 0,
      totals: { inputTokens: 0, outputTokens: 0, maxInputTokens: 0 }, compression, interrupts: 0, turns: [], notices: [], stoppedReason: null,
      pricingNote: '추정 비용(usageMetadata 토큰 × 설정 단가). 실제 청구액 아님',
    };
    this.save(s);
    return s;
  }
  get(id: string): LiveSessionRecord | undefined {
    if (!SESSION_ID.test(id)) return undefined;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    const s = JSON.parse(readFileSync(f, 'utf8')) as LiveSessionRecord;
    this.cache.set(id, s);
    return s;
  }
  save(s: LiveSessionRecord) {
    this.cache.set(s.id, s);
    const f = this.file(s.id);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, f);
  }
}

/** 화면·API 응답용: 전사 원문을 뺀 계측값만. */
export const redactLive = (s: LiveSessionRecord) => ({ ...s, turns: s.turns.map(({ userText, replyText, ...m }) => { void userText; void replyText; return m; }) });

interface Usage { inputTokens: number; outputTokens: number }

const rmsOf = (buf: Buffer) => {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
};

export interface LiveDeps {
  config: LiveConfig;
  ledger: BudgetLedger;
  store: LiveSessionStore;
  /** 시각(ms). 시험에서 교체 가능. */
  now: () => number;
  log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
  /** 한 번에 한 세션만(비용 보호). */
  active: { current: LiveRun | null };
  clock?: () => Date;
}

type ClientEvent = Record<string, unknown> & { type: string };

export class LiveRun {
  private upstream: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private readonly rec: LiveSessionRecord;
  private readonly c: LiveConfig;
  // 마이크 게이트(서버측 에너지 기반 무음/짧은 소리 판정)
  private mode: 'IDLE' | 'ACTIVE' = 'IDLE';
  private preroll: Buffer[] = [];
  private prerollMs = 0;
  private cand: Buffer[] = [];
  private candMs = 0;
  private candGapMs = 0;
  private silentMs = 0;
  private tailMs = 0;
  private lastVoiceAt: number | null = null;
  private lastVoicedInboundMs = 0;
  // 턴 계측
  private cur: {
    userText: string; replyText: string; speechEndAt: number | null; firstRecvAt: number | null; firstSentAt: number | null;
    inboundMs: number; usage: Usage | null; costKrw: number; turn: LiveTurn | null;
  } | null = null;
  private lastFinal: NonNullable<LiveRun['cur']> | null = null;
  private lastPromptTokens = 0;
  private sessionTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: LiveDeps, private readonly client: WebSocket, private readonly query: URLSearchParams) {
    this.c = { ...d.config };
    const clampQ = (name: string, def: number, min: number, max: number) => {
      const v = Number(query.get(name));
      return Number.isFinite(v) && v >= min && v <= max && query.get(name) ? v : def;
    };
    this.c.noSpeechMs = clampQ('noSpeechMs', this.c.noSpeechMs, 1000, 30000);
    this.c.minSpeechMs = clampQ('minSpeechMs', this.c.minSpeechMs, 100, 2000);
    this.rec = d.store.create(this.c.model, d.ledger.limitKrw, this.c.compression, (d.clock ?? (() => new Date()))());
  }

  private send(ev: ClientEvent) { if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(ev)); }
  private notice(code: string, message: string) {
    if (this.rec.notices.length < 200) this.rec.notices.push({ at: (this.d.clock ?? (() => new Date()))().toISOString(), code });
    this.d.store.save(this.rec);
    this.send({ type: 'notice', code, message });
  }

  start() {
    const budgetKrw = this.d.ledger.limitKrw;
    // 예산이 이미 소진됐으면 연결 자체를 만들지 않는다.
    if (!this.d.ledger.canSpend(this.estimateTurnKrw())) return this.stop('BUDGET', '예산 상한에 도달해 시작하지 않았습니다.');
    const ws = new WebSocket(this.c.url, { headers: { 'x-goog-api-key': this.c.key }, handshakeTimeout: this.c.connectTimeoutMs });
    this.upstream = ws;
    this.connectTimer = setTimeout(() => this.stop('LIVE_CONNECT', '실시간 서버에 연결하지 못했습니다.'), this.c.connectTimeoutMs);
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      const st = res.statusCode ?? 0;
      this.stop(st === 401 || st === 403 ? 'LIVE_AUTH' : 'LIVE_CONNECT', st === 401 || st === 403 ? '실시간 서버가 키를 거부했습니다. 키를 확인하세요.' : '실시간 서버에 연결하지 못했습니다.');
    });
    ws.on('error', () => this.stop('LIVE_CONNECT', '실시간 서버 연결 오류입니다.'));
    ws.on('close', () => this.stop(this.ready ? 'LIVE_CLOSED' : 'LIVE_CONNECT', '실시간 서버와 연결이 끊어졌습니다.'));
    ws.on('open', () => ws.send(JSON.stringify({ setup: this.setupMessage() })));
    ws.on('message', (raw) => this.onUpstream(raw));
    this.sessionTimer = setTimeout(() => this.stop('TIME_LIMIT', '시험 세션 최대 시간에 도달해 종료했습니다.'), this.c.maxSessionMs);
    this.client.on('message', (data, isBinary) => (isBinary ? this.onMic(data) : this.onClientText(data)));
    this.client.on('close', () => this.stop('CLIENT_CLOSED', ''));
    this.client.on('error', () => this.stop('CLIENT_CLOSED', ''));
    void budgetKrw;
  }

  private setupMessage() {
    const c = this.c;
    return {
      model: `models/${c.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice } } },
      },
      systemInstruction: { parts: [{ text: c.instruction }] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(c.compression ? { contextWindowCompression: { triggerTokens: c.compression.triggerTokens, slidingWindow: { targetTokens: c.compression.targetTokens } } } : {}),
    };
  }

  private estimateTurnKrw() {
    const p = this.c.pricing;
    // 지난 턴의 입력 토큰(없으면 2,000)과 출력 400토큰을 보수적으로 잡는다.
    const inTok = this.lastPromptTokens || 2000;
    return ((inTok * p.inputUsdPerMTok + 400 * p.outputUsdPerMTok) / 1e6) * p.usdKrw;
  }

  private onClientText(data: RawData) {
    try {
      const m = JSON.parse(data.toString()) as { type?: string };
      if (m.type === 'end') this.stop('USER_END', '');
    } catch { /* 무시 */ }
  }

  private onMic(data: RawData) {
    const recvAt = this.d.now();
    if (!this.ready || this.ended || this.rec.stoppedReason) return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (buf.length < 2 || buf.length > 32768 || buf.length % 2) return;
    const ms = (buf.length / 2 / this.c.inputRate) * 1000;
    const voiced = rmsOf(buf) > this.c.rmsThreshold;
    if (voiced) this.lastVoiceAt = recvAt;

    if (this.mode === 'ACTIVE') {
      this.sendAudio(buf, recvAt, voiced);
      if (voiced) this.tailMs = 0;
      else if ((this.tailMs += ms) >= this.c.tailMs) { this.mode = 'IDLE'; this.silentMs = 0; this.preroll = []; this.prerollMs = 0; }
      return;
    }

    // IDLE: 확정 전 소리는 업스트림에 보내지 않는다(짧은 소리·무음은 응답도 비용도 없다).
    if (voiced) {
      this.silentMs = 0;
      for (const b of this.preroll) { this.cand.push(b); this.candMs += (b.length / 2 / this.c.inputRate) * 1000; }
      this.preroll = []; this.prerollMs = 0;
      this.cand.push(buf); this.candMs += ms; this.candGapMs = 0;
      if (this.candMs >= this.c.minSpeechMs) this.confirmSpeech(recvAt);
      return;
    }
    if (this.candMs > 0) {
      this.cand.push(buf); this.candGapMs += ms;
      if (this.candGapMs > 400) {
        // 확정 길이에 못 미친 짧은 소리.
        this.cand = []; this.candMs = 0; this.candGapMs = 0;
        this.notice('TOO_SHORT', '너무 짧은 소리라 무시했습니다. 다시 말씀해 주세요.');
      }
      return;
    }
    this.preroll.push(buf); this.prerollMs += ms;
    while (this.prerollMs > this.c.prerollMs && this.preroll.length > 1) { const x = this.preroll.shift()!; this.prerollMs -= (x.length / 2 / this.c.inputRate) * 1000; }
    if ((this.silentMs += ms) >= this.c.noSpeechMs) {
      this.silentMs = 0;
      this.notice('NO_SPEECH', '음성이 들리지 않았습니다(무음). 마이크를 확인하고 말씀해 주세요.');
    }
  }

  private confirmSpeech(recvAt: number) {
    // 새 턴을 시작하기 전에 예산을 확인한다. 넘으면 이 소리는 업스트림에 한 바이트도 보내지 않는다.
    if (!this.d.ledger.canSpend(this.estimateTurnKrw())) return this.stop('BUDGET', '예산 상한에 도달해 새 대화를 시작하지 않고 종료했습니다.');
    this.mode = 'ACTIVE'; this.tailMs = 0;
    const pending = this.cand; this.cand = []; this.candMs = 0; this.candGapMs = 0;
    pending.forEach((b, i) => this.sendAudio(b, recvAt, i === pending.length - 1));
  }

  private sendAudio(buf: Buffer, recvAt: number, voiced: boolean) {
    if (this.upstream?.readyState !== WebSocket.OPEN) return;
    this.upstream.send(JSON.stringify({ realtimeInput: { audio: { data: buf.toString('base64'), mimeType: `audio/pcm;rate=${this.c.inputRate}` } } }));
    if (voiced) this.lastVoicedInboundMs = this.d.now() - recvAt;
  }

  private turnObj() {
    if (!this.cur) this.cur = { userText: '', replyText: '', speechEndAt: null, firstRecvAt: null, firstSentAt: null, inboundMs: 0, usage: null, costKrw: 0, turn: null };
    return this.cur;
  }

  private onUpstream(raw: RawData) {
    const recvAt = this.d.now();
    let msg: {
      setupComplete?: unknown;
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
        inputTranscription?: { text?: string }; outputTranscription?: { text?: string };
        turnComplete?: boolean; interrupted?: boolean;
      };
      usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number; candidatesTokenCount?: number };
    };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (this.ended) return;

    if (msg.setupComplete !== undefined && !this.ready) {
      this.ready = true;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.d.log.info({ sessionId: this.rec.id, model: this.c.model }, 'live session ready');
      this.send({ type: 'ready', sessionId: this.rec.id, inputRate: this.c.inputRate, outputRate: 24000, budgetKrw: this.rec.budgetKrw, model: this.c.model });
      return;
    }
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.rec.interrupts++;
        if (this.cur) this.finalize(true);
        this.send({ type: 'interrupted' });
        this.d.store.save(this.rec);
      }
      if (sc.inputTranscription?.text) this.turnObj().userText += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) this.turnObj().replyText += sc.outputTranscription.text;
      for (const p of sc.modelTurn?.parts ?? []) {
        const b64 = p.inlineData?.data;
        if (!b64) continue;
        const t = this.turnObj();
        if (t.firstRecvAt === null) { t.firstRecvAt = recvAt; t.speechEndAt = this.lastVoiceAt; t.inboundMs = this.lastVoicedInboundMs; }
        if (this.client.readyState === WebSocket.OPEN) this.client.send(Buffer.from(b64, 'base64'), { binary: true });
        if (t.firstSentAt === null) {
          t.firstSentAt = this.d.now();
          const lat = t.speechEndAt === null ? null : Math.max(0, Math.round(t.firstSentAt - t.speechEndAt));
          this.send({ type: 'first_audio', n: this.rec.turns.length + 1, latencyMs: lat });
        }
      }
    }
    if (msg.usageMetadata) this.onUsage(msg.usageMetadata);
    if (sc?.turnComplete) this.finalize(false);
  }

  private onUsage(u: { promptTokenCount?: number; responseTokenCount?: number; candidatesTokenCount?: number }) {
    const target = this.cur ?? this.lastFinal;
    if (!target) return;
    const usage = { inputTokens: Math.max(0, Number(u.promptTokenCount) || 0), outputTokens: Math.max(0, Number(u.responseTokenCount ?? u.candidatesTokenCount) || 0) };
    const p = this.c.pricing;
    const cost = ((usage.inputTokens * p.inputUsdPerMTok + usage.outputTokens * p.outputUsdPerMTok) / 1e6) * p.usdKrw;
    const prev = target.usage;
    this.d.ledger.add(cost - target.costKrw);
    this.rec.estimatedCostKrw += cost - target.costKrw;
    this.rec.totals.inputTokens += usage.inputTokens - (prev?.inputTokens ?? 0);
    this.rec.totals.outputTokens += usage.outputTokens - (prev?.outputTokens ?? 0);
    this.rec.totals.maxInputTokens = Math.max(this.rec.totals.maxInputTokens, usage.inputTokens);
    target.usage = usage; target.costKrw = cost;
    this.lastPromptTokens = usage.inputTokens;
    if (target.turn) Object.assign(target.turn, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costKrw: round2(cost) });
    this.d.store.save(this.rec);
    if (target.turn) this.send({ type: 'usage', n: target.turn.n, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costKrw: round2(cost), sessionCostKrw: round2(this.rec.estimatedCostKrw) });
    // 다음 턴 전에 점검: 맥락이 상한을 넘었거나 예산을 다 썼으면 새 턴을 받지 않는다.
    if (usage.inputTokens > this.c.maxInputTokens) this.stop('CONTEXT', '대화 맥락이 커져 비용 보호를 위해 종료했습니다.');
    else if (this.d.ledger.spentKrw >= this.d.ledger.limitKrw) this.stop('BUDGET', '예산 상한에 도달해 종료했습니다.');
  }

  private finalize(interrupted: boolean) {
    const t = this.cur;
    if (!t) return;
    const hasContent = t.userText || t.replyText || t.firstRecvAt !== null;
    this.cur = null;
    if (!hasContent) return;
    const lat = t.firstSentAt !== null && t.speechEndAt !== null ? Math.max(0, Math.round(t.firstSentAt - t.speechEndAt)) : null;
    const up = t.firstRecvAt !== null && t.speechEndAt !== null ? Math.max(0, Math.round(t.firstRecvAt - t.speechEndAt)) : null;
    const overhead = t.firstRecvAt !== null && t.firstSentAt !== null ? Math.round(t.inboundMs + (t.firstSentAt - t.firstRecvAt)) : null;
    const turn: LiveTurn = {
      n: this.rec.turns.length + 1, at: (this.d.clock ?? (() => new Date()))().toISOString(),
      userText: t.userText.trim(), replyText: t.replyText.trim(), latencyMs: lat, upstreamLatencyMs: up, serverOverheadMs: overhead,
      inputTokens: t.usage?.inputTokens ?? 0, outputTokens: t.usage?.outputTokens ?? 0, costKrw: round2(t.costKrw), interrupted,
    };
    t.turn = turn;
    this.lastFinal = t;
    this.rec.turns.push(turn);
    this.d.store.save(this.rec);
    // 계측 로그에는 숫자만 남긴다(전사 원문·키 금지).
    this.d.log.info({ sessionId: this.rec.id, n: turn.n, latencyMs: lat, upstreamLatencyMs: up, serverOverheadMs: overhead, interrupted }, 'live turn');
    const { userText, replyText, ...rest } = turn;
    this.send({ type: 'turn', ...rest, userText, replyText });
  }

  stop(reason: string, message: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.cur) this.finalize(false);
    for (const t of [this.sessionTimer, this.connectTimer]) if (t) clearTimeout(t);
    if (reason !== 'CLIENT_CLOSED' && reason !== 'USER_END') this.rec.stoppedReason = reason;
    this.rec.endedAt = (this.d.clock ?? (() => new Date()))().toISOString();
    this.d.store.save(this.rec);
    if (reason !== 'CLIENT_CLOSED') this.send({ type: 'stopped', reason, message, sessionId: this.rec.id, summary: redactLive(this.rec) });
    try { this.upstream?.close(); } catch { /* 이미 닫힘 */ }
    try { this.upstream?.terminate(); } catch { /* 이미 닫힘 */ }
    try { this.client.close(1000); } catch { /* 이미 닫힘 */ }
    if (this.d.active.current === this) this.d.active.current = null;
    this.d.log.info({ sessionId: this.rec.id, reason, turns: this.rec.turns.length }, 'live session ended');
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface LiveRouteOptions {
  /** 키 문제 등으로 비활성이면 사유 코드만. fail closed: 이 경우 세션을 시작하지 않는다. */
  config: LiveConfig | null;
  disabledReason?: string;
  ledger: BudgetLedger;
  sessionDir: string;
  now?: () => number;
}

export function registerLive(app: FastifyInstance, o: LiveRouteOptions) {
  const store = new LiveSessionStore(o.sessionDir);
  const active: LiveDeps['active'] = { current: null };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  app.get('/voice-live', async (_req, reply) =>
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store')
      .header('Permissions-Policy', 'microphone=(self)').send(LIVE_PAGE));

  app.get<{ Params: { id: string } }>('/voice-live/api/sessions/:id', async (req, reply) => {
    const s = store.get(req.params.id);
    return s ? redactLive(s) : reply.status(404).send({ code: 'SESSION_NOT_FOUND' });
  });

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/voice-live/ws') return; // 다른 업그레이드는 건드리지 않는다.
    // 교차 출처 웹 페이지가 유료 세션을 열지 못하게 한다.
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* 잘못된 Origin */ }
      if (host !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const log = { info: (obj: object, msg: string) => app.log.info(obj, msg), warn: (obj: object, msg: string) => app.log.warn(obj, msg) };
      const refuse = (reason: string, message: string) => {
        ws.send(JSON.stringify({ type: 'stopped', reason, message }));
        ws.close(1008);
      };
      if (!o.config) return refuse('LIVE_DISABLED', '실시간 대화가 설정되지 않았습니다(키 또는 설정 확인).');
      if (active.current) return refuse('BUSY', '이미 진행 중인 실시간 세션이 있습니다.');
      const run = new LiveRun({ config: o.config, ledger: o.ledger, store, now: o.now ?? (() => performance.now()), log, active }, ws, url.searchParams);
      active.current = run;
      run.start();
    });
  });
  app.addHook('onClose', async () => { active.current?.stop('SERVER_CLOSE', ''); wss.close(); });
  return { store, active };
}
