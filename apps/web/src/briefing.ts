/** 통합 브리핑 화면의 순수 로직(API 호출·문구). 브라우저 렌더링은 BriefingPanel 에 둔다. */

export interface BriefingData {
  id: string; version: number; confirmed: boolean;
  summary: { id: string; text: string }[];
  video: { id: string; text: string }[];
  excluded: { id: string; text: string; reason: string; label: string }[];
  speech: string;
}
export interface CorrectionData extends BriefingData { changed: { id: string; text: string }; correctionSpeech: string; repeatsFullBriefing: false }
export interface ConfirmData { confirmed: true; jobId: string; duplicate: boolean; lines: string[] }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

const FALLBACK: Record<string, string> = {
  NOT_FINISHED: '대화를 끝낸 뒤에 브리핑을 볼 수 있습니다.',
  NO_CONTENT: '아직 정리할 대화가 없습니다.',
  PRO_WAITING: '정리를 지금 끝내지 못했습니다. 대화 내용은 저장되어 있으니 잠시 뒤 다시 시도하세요.',
  PRO_UNAVAILABLE: '브리핑 정리가 아직 설정되지 않았습니다. 대화 내용은 저장되어 있고, 영상은 만들어지지 않았습니다.',
  BAD_OUTPUT: '정리 결과를 읽지 못했습니다. 잠시 뒤 다시 시도하세요. 영상은 만들어지지 않았습니다.',
  STALE_BRIEFING: '화면의 브리핑이 최신이 아닙니다. 새로 불러온 뒤 다시 확인하세요.',
  CONFIRMED_LOCKED: '이미 확인한 브리핑입니다.',
  NOTHING_TO_PRODUCE: '영상에 담을 내용이 없어 제작하지 않았습니다.',
};

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const r = await fetch(url, init);
    const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    if (r.ok) return { ok: true, data: j as T };
    const code = j.error ?? String(r.status);
    return { ok: false, code, message: j.message ?? FALLBACK[code] ?? '처리하지 못했습니다. 다시 시도해 주세요.' };
  } catch {
    return { ok: false, code: 'NETWORK', message: '연결을 확인한 뒤 다시 시도해 주세요. 확인 전에는 영상이 만들어지지 않습니다.' };
  }
}
const post = (url: string, body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const startBriefing = (id: string) => call<BriefingData>(`/api/briefing/${id}/start`, post('', { finish: true }));
export const loadBriefing = (id: string) => call<BriefingData>(`/api/briefing/${id}`);
export const correctBriefing = (id: string, version: number, itemId: string, action: 'EXCLUDE' | 'REPLACE' | 'INCLUDE', text?: string) =>
  call<CorrectionData>(`/api/briefing/${id}/correct`, post('', { version, itemId, action, text }));
export const confirmBriefing = (id: string, version: number) => call<ConfirmData>(`/api/briefing/${id}/confirm`, post('', { version }));

/** 정정 뒤 화면 상태: 새 버전의 데이터를 쓰되 전체를 다시 읽어 주지 않고 바뀐 부분 안내만 읽는다. */
export function afterCorrection(c: CorrectionData): { data: BriefingData; speak: string } {
  const { changed: _c, correctionSpeech, repeatsFullBriefing: _r, ...data } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { data, speak: correctionSpeech };
}
