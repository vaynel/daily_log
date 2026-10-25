import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocketServer } from 'ws';
import type { SessionClaims } from '../auth/session.js';
import type { AuthFailure } from '../auth/plugin.js';
import type { MonthlyLedger } from '../budget/ledger.js';
import type { ItemKind, Snapshot } from '../records/store.js';
import { BudgetLedger } from '../voice/meter.js';
import { LiveRun, LiveSessionStore, type LiveConfig, type LiveDeps } from '../voice/live.js';
import { DEFAULT_LIMITS, type HistoryLine, type InterviewLimits } from './limits.js';
import type { LiveUsage, LiveUsageStore } from './usage.js';
import { describeAudioExpiry } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RecordStore 중 이 모듈이 쓰는 부분(시험에서 메모리 구현으로 대체 가능). */
export interface InterviewRecords {
  loadById(ownerId: string, id: string, now: Date): Promise<Snapshot | null>;
  saveItem(ownerId: string, interviewId: string, key: string, kind: ItemKind, body: string, now: Date): Promise<unknown>;
}

export interface InterviewRouteOptions {
  records: InterviewRecords;
  usage: LiveUsageStore;
  /** null 이면 대화 시작은 fail closed(LIVE_DISABLED). */
  live: LiveConfig | null;
  monthly?: MonthlyLedger;
  sessionDir: string;
  limits?: InterviewLimits;
  authenticate: (req: { headers: { cookie?: string } }) => { user: SessionClaims } | AuthFailure;
  now?: () => Date;
  /** 지연 계측용 단조 시각(ms). */
  liveNow?: () => number;
}

/** 끝난 사유 중 그날 대화를 닫는 것: 사용자가 끝냄·시간/비용 상한. 일시정지·연결 끊김·오류는 이어하기 가능. */
export const FINAL_REASONS = new Set(['USER_END', 'TIME_LIMIT', 'COST_LIMIT']);

type Block = null | 'CONFIRMED' | 'DAILY_LIMIT' | 'LIVE_DISABLED';

export function registerInterview(app: FastifyInstance, o: InterviewRouteOptions) {
  const now = o.now ?? (() => new Date());
  const limits = o.limits ?? DEFAULT_LIMITS;
  const store = new LiveSessionStore(o.sessionDir);
  const active: LiveDeps['active'] = { current: null };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;

  const blockOf = (snap: Snapshot, u: LiveUsage | null): Block =>
    snap.interview.status === 'CONFIRMED' ? 'CONFIRMED' : u?.status === 'ENDED' ? 'DAILY_LIMIT' : !o.live ? 'LIVE_DISABLED' : null;

  const usageView = (u: LiveUsage | null) => ({
    usedMs: u?.usedMs ?? 0, costKrw: Math.round((u?.costKrw ?? 0) * 100) / 100, status: u?.status ?? 'NONE', endReason: u?.endReason ?? null,
    limits: { maxMs: limits.maxMs, wrapMs: limits.wrapMs, maxCostKrw: limits.maxCostKrw, wrapCostKrw: limits.wrapCostKrw },
  });

  app.get('/api/interview/:id/state', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const snap = await o.records.loadById(owner(req), id, now());
    if (!snap) return reply.code(404).send({ error: 'NOT_FOUND' });
    const u = await o.usage.get(owner(req), id);
    const block = blockOf(snap, u);
    return reply.header('cache-control', 'private, no-store').send({
      id, lifeDate: snap.interview.lifeDate, writingStatus: snap.interview.status, revision: snap.interview.revision,
      conversation: snap.items.map((i) => ({ id: i.id, seq: i.seq, kind: i.kind, body: i.body })),
      attachmentCount: snap.attachments.length,
      usage: usageView(u),
      canTalk: block === null, blockReason: block,
      audioNotice: describeAudioExpiry(snap.audio, { items: snap.items.length, attachments: snap.attachments.length }, snap.pipeline?.backup),
    });
  });

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/interview/ws') return;
    const deny = (line: string) => { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    // 인증(쿠키 세션)·허용 계정은 HTTP 훅과 같은 규칙. 업그레이드는 훅을 거치지 않으므로 직접 검사한다.
    const auth = o.authenticate(req as unknown as FastifyRequest);
    if ('status' in auth) return deny(auth.status === 403 ? '403 Forbidden' : auth.status === 503 ? '503 Service Unavailable' : '401 Unauthorized');
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* 잘못된 Origin */ }
      if (host !== req.headers.host) return deny('403 Forbidden');
    }
    const interviewId = url.searchParams.get('id') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => {
      const refuse = (reason: string, message: string) => { ws.send(JSON.stringify({ type: 'stopped', reason, message })); ws.close(1008); };
      void (async () => {
        const ownerId = auth.user.sub;
        if (!UUID.test(interviewId)) return refuse('NOT_FOUND', '기록을 찾을 수 없습니다.');
        if (!o.live) return refuse('LIVE_DISABLED', '실시간 대화가 설정되지 않았습니다. 관리자에게 문의하세요.');
        if (active.current) return refuse('BUSY', '이미 진행 중인 대화가 있습니다. 다른 기기에서 먼저 일시정지하세요.');
        const snap = await o.records.loadById(ownerId, interviewId, now()).catch(() => null);
        if (!snap) return refuse('NOT_FOUND', '기록을 찾을 수 없습니다.');
        const existing = await o.usage.get(ownerId, interviewId);
        const block = blockOf(snap, existing);
        if (block === 'CONFIRMED') return refuse('CONFIRMED', '확정된 기록에는 대화를 이어갈 수 없습니다.');
        if (block === 'DAILY_LIMIT') return refuse('DAILY_LIMIT', '오늘 대화는 이미 마쳤습니다. 하루에 한 번만 대화할 수 있습니다.');
        // 동시 연결 방지는 위 active 확인과 이 동기 구간에서 자리를 잡아 보장한다.
        if (active.current) return refuse('BUSY', '이미 진행 중인 대화가 있습니다.');
        const usage = await o.usage.open(ownerId, interviewId, now());
        if (usage.usedMs >= limits.maxMs || usage.costKrw >= limits.maxCostKrw) {
          await o.usage.add(ownerId, interviewId, 0, 0, usage.usedMs >= limits.maxMs ? 'TIME_LIMIT' : 'COST_LIMIT', now());
          return refuse('DAILY_LIMIT', '오늘 대화 한도에 도달했습니다.');
        }
        if (active.current) return refuse('BUSY', '이미 진행 중인 대화가 있습니다.');
        const connId = randomUUID();
        const history: HistoryLine[] = snap.items.map((i) => ({ role: i.kind === 'ANSWER' ? 'user' : 'model', text: i.body }));
        const log = { info: (obj: object, msg: string) => app.log.info(obj, msg), warn: (obj: object, msg: string) => app.log.warn(obj, msg) };
        const run = new LiveRun({
          config: o.live, ledger: new BudgetLedger(limits.maxCostKrw * 2) /* 보조 안전망: 세션 상한(COST_LIMIT)이 먼저 판정한다 */, monthly: o.monthly, store,
          now: o.liveNow ?? (() => performance.now()), log, active, clock: now,
          product: {
            purpose: 'PRODUCT', limits, priorUsedMs: usage.usedMs, priorCostKrw: usage.costKrw, history, attachments: snap.attachments,
            onTurn: async (t) => {
              // 사용자 말(ANSWER) 다음에 AI 말(QUESTION). 같은 키 재전송은 중복 저장되지 않는다.
              if (t.userText) await o.records.saveItem(ownerId, interviewId, `live:${connId}:${t.n}:a`, 'ANSWER', t.userText, now());
              if (t.replyText) await o.records.saveItem(ownerId, interviewId, `live:${connId}:${t.n}:q`, 'QUESTION', t.replyText, now());
            },
            onEnd: async (info) => { await o.usage.add(ownerId, interviewId, info.usedMs, info.costKrw, FINAL_REASONS.has(info.reason) ? info.reason : null, now()); },
          },
        }, ws, url.searchParams);
        active.current = run;
        void run.start();
      })().catch(() => { try { refuse('INTERNAL', '대화를 시작하지 못했습니다. 잠시 후 다시 시도하세요.'); } catch { /* 이미 닫힘 */ } });
    });
  });
  app.addHook('onClose', async () => { active.current?.stop('SERVER_CLOSE', ''); wss.close(); });
  return { store, active };
}
