/** 음성 인터뷰 화면의 순수 로직(상태 전이·문구). 브라우저 API는 audio.ts 와 InterviewScreen 에만 둔다. */

export type Phase = 'idle' | 'asking-mic' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'ended' | 'blocked';

export interface Limits { maxMs: number; wrapMs: number; maxCostKrw: number; wrapCostKrw: number }
export interface UsageView { usedMs: number; costKrw: number; status: 'NONE' | 'OPEN' | 'ENDED'; endReason: string | null; limits: Limits }
export interface AudioNotice { code: 'AUDIO_EXPIRED'; message: string; speech: string; expiredCount: number; preserved: { items: number; attachments: number }; backup: string }
export interface InterviewState {
  id: string; lifeDate: string; writingStatus: 'IN_PROGRESS' | 'CONFIRMED';
  conversation: { id: string; seq: number; kind: 'QUESTION' | 'ANSWER'; body: string }[];
  attachmentCount: number; usage: UsageView; canTalk: boolean; blockReason: null | 'CONFIRMED' | 'DAILY_LIMIT' | 'LIVE_DISABLED'; audioNotice: AudioNotice | null;
}

export type MicProblem = 'DENIED' | 'NO_DEVICE' | 'UNSUPPORTED' | 'FAILED';

/** getUserMedia 오류 → 사용자가 이해할 수 있는 분류. 오류 메시지 원문은 쓰지 않는다. */
export function classifyMicError(e: unknown): MicProblem {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'DENIED';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'NO_DEVICE';
  if (name === 'TypeError' || name === 'NotSupportedError') return 'UNSUPPORTED';
  return 'FAILED';
}

export const MIC_HELP: Record<MicProblem, { title: string; steps: string }> = {
  DENIED: { title: '마이크 사용이 허용되지 않았습니다', steps: '주소창 왼쪽의 자물쇠(또는 사이트 설정)에서 마이크를 "허용"으로 바꾼 뒤 [다시 시도]를 누르세요. 지금은 아무것도 녹음되지 않습니다.' },
  NO_DEVICE: { title: '마이크를 찾을 수 없습니다', steps: '이어폰·마이크 연결을 확인하거나 다른 앱이 마이크를 쓰고 있지 않은지 확인한 뒤 [다시 시도]를 누르세요.' },
  UNSUPPORTED: { title: '이 브라우저는 음성 대화를 지원하지 않습니다', steps: 'HTTPS 주소로 접속했는지 확인하고, 최신 Chrome 등 다른 브라우저에서 열어 보세요.' },
  FAILED: { title: '마이크를 시작하지 못했습니다', steps: '잠시 뒤 [다시 시도]를 누르세요. 계속되면 브라우저를 다시 시작해 보세요.' },
};

export interface StopInfo {
  title: string;
  /** 사용자가 할 수 있는 해결 행동. */
  action: string;
  /** 이어서 대화할 수 있는지(그날 사용을 소진하지 않는 종료). */
  resumable: boolean;
  phase: 'paused' | 'ended' | 'blocked';
}

const STOP: Record<string, StopInfo> = {
  USER_PAUSE: { title: '일시정지했습니다. 마이크가 꺼졌습니다.', action: '준비되면 [이어서 말하기]를 누르세요.', resumable: true, phase: 'paused' },
  USER_END: { title: '오늘 대화를 마쳤습니다.', action: '하루에 한 번만 대화할 수 있어 내일 다시 시작할 수 있습니다.', resumable: false, phase: 'ended' },
  TIME_LIMIT: { title: '대화 시간 10분이 되어 마무리했습니다.', action: '대화한 내용은 저장되어 있습니다. 내일 다시 시작할 수 있습니다.', resumable: false, phase: 'ended' },
  COST_LIMIT: { title: '이번 대화의 사용 한도에 도달해 마무리했습니다.', action: '대화한 내용은 저장되어 있습니다. 내일 다시 시작할 수 있습니다.', resumable: false, phase: 'ended' },
  DAILY_LIMIT: { title: '오늘 대화는 이미 마쳤습니다.', action: '하루에 한 번만 대화할 수 있습니다. 저장된 내용은 아래에서 볼 수 있습니다.', resumable: false, phase: 'blocked' },
  CONFIRMED: { title: '확정된 기록에는 대화를 이어갈 수 없습니다.', action: '내용을 고치려면 기록 상세에서 수정을 요청하세요.', resumable: false, phase: 'blocked' },
  LIVE_DISABLED: { title: '음성 대화가 아직 켜지지 않았습니다.', action: '관리자에게 설정을 요청하세요. 글 메모와 사진 첨부는 계속 사용할 수 있습니다.', resumable: false, phase: 'blocked' },
  BUSY: { title: '다른 화면에서 대화 중입니다.', action: '다른 기기에서 일시정지한 뒤 [이어서 말하기]를 누르세요.', resumable: true, phase: 'paused' },
  NOT_FOUND: { title: '기록을 찾을 수 없습니다.', action: '화면을 새로고침한 뒤 다시 시도하세요.', resumable: true, phase: 'paused' },
  LIVE_CLOSED: { title: '음성 서버와 연결이 끊어졌습니다.', action: '지금까지의 내용은 저장되어 있습니다. [다시 연결]을 눌러 이어가세요.', resumable: true, phase: 'paused' },
  LIVE_CONNECT: { title: '음성 서버에 연결하지 못했습니다.', action: '네트워크를 확인한 뒤 [다시 연결]을 누르세요. 저장된 내용은 그대로입니다.', resumable: true, phase: 'paused' },
  LIVE_AUTH: { title: '음성 서버 설정에 문제가 있습니다.', action: '관리자에게 알려 주세요. 글 메모와 사진 첨부는 계속 사용할 수 있습니다.', resumable: false, phase: 'blocked' },
  CONTEXT: { title: '대화가 길어져 비용 보호를 위해 멈췄습니다.', action: '저장된 내용은 그대로입니다. [다시 연결]로 이어갈 수 있습니다.', resumable: true, phase: 'paused' },
  BUDGET: { title: '이번 달 추가 비용 한도에 도달해 대화를 멈췄습니다.', action: '자동으로 유료 전환하지 않습니다. 글 메모와 사진 첨부는 계속 사용할 수 있습니다.', resumable: false, phase: 'blocked' },
  LEDGER_UNAVAILABLE: { title: '비용 확인을 하지 못해 시작하지 않았습니다.', action: '잠시 후 [다시 연결]을 눌러 주세요.', resumable: true, phase: 'paused' },
  INTERNAL: { title: '대화를 시작하지 못했습니다.', action: '잠시 후 [다시 연결]을 눌러 주세요.', resumable: true, phase: 'paused' },
  CONNECTION_LOST: { title: '네트워크 연결이 끊어졌습니다.', action: '지금까지의 내용은 저장되어 있습니다. 연결을 확인한 뒤 [다시 연결]을 누르세요.', resumable: true, phase: 'paused' },
};

export const describeStop = (reason: string): StopInfo =>
  STOP[reason] ?? { title: '대화가 멈췄습니다.', action: '[다시 연결]을 눌러 이어가세요. 저장된 내용은 그대로입니다.', resumable: true, phase: 'paused' };

/** 서버가 보내는 일시 안내 코드 → 화면 문구(서버 message 가 있으면 우선). */
export const NOTICE_HELP: Record<string, string> = {
  NO_SPEECH: '소리가 들리지 않습니다. 마이크가 가려지지 않았는지 확인하고 말씀해 주세요.',
  TOO_SHORT: '너무 짧은 소리라 무시했습니다. 천천히 다시 말씀해 주세요.',
  SAVE_FAILED: '방금 대화를 저장하지 못했습니다. 연결을 확인해 주세요.',
  TIME_LIMIT_NEAR: '대화 시간이 끝나 이번 말씀까지만 듣고 마무리합니다.',
};

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 남은 대화 시간(이어하기 합산). */
export const remainingMs = (u: Pick<UsageView, 'usedMs' | 'limits'>) => Math.max(0, u.limits.maxMs - u.usedMs);

export interface ServerEvent { type: string; [k: string]: unknown }

/** 서버 이벤트에 따른 단계 전이. 알 수 없는 이벤트는 현재 단계를 유지한다. */
export function nextPhase(cur: Phase, ev: ServerEvent, speaking: boolean): Phase {
  switch (ev.type) {
    case 'ready': return 'listening';
    case 'interrupted': return 'listening';
    case 'first_audio': return 'speaking';
    case 'turn': return speaking ? 'speaking' : 'listening';
    case 'stopped': return describeStop(String(ev.reason)).phase;
    default: return cur;
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  idle: '대기 중 · 마이크 꺼짐',
  'asking-mic': '마이크 허용을 기다리는 중',
  connecting: '연결 중',
  listening: '듣는 중 · 마이크 켜짐',
  thinking: '생각 중',
  speaking: 'AI가 말하는 중',
  paused: '일시정지 · 마이크 꺼짐',
  ended: '대화 끝 · 마이크 꺼짐',
  blocked: '대화할 수 없음 · 마이크 꺼짐',
};

/** 마이크가 실제로 켜져 있는 단계(녹음 중 표시와 일치해야 한다). */
export const micIsOn = (p: Phase) => p === 'listening' || p === 'thinking' || p === 'speaking' || p === 'connecting';

export interface TurnLat { n: number; latencyMs: number | null; upstreamLatencyMs: number | null; serverOverheadMs: number | null }

/** 단계별 지연 표시 문구(말 끝→첫 음성 = 음성 서비스 + 이 서버 추가분). */
export function describeLatency(t: TurnLat): string {
  if (t.latencyMs === null) return `턴 ${t.n}: 지연 측정 없음`;
  const parts = [`말 끝→첫 음성 ${t.latencyMs}ms`];
  if (t.upstreamLatencyMs !== null) parts.push(`음성 서비스 ${t.upstreamLatencyMs}ms`);
  if (t.serverOverheadMs !== null) parts.push(`서버 ${t.serverOverheadMs}ms`);
  return `턴 ${t.n}: ${parts.join(' · ')}`;
}

export function summarizeLatency(ts: TurnLat[]): { count: number; avgMs: number | null; maxMs: number | null } {
  const v = ts.map((t) => t.latencyMs).filter((x): x is number => typeof x === 'number');
  return { count: v.length, avgMs: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null, maxMs: v.length ? Math.max(...v) : null };
}
