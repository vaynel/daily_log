export type AttachKind = 'PHOTO' | 'MARKDOWN' | 'NOTE';

/** 서버 정책(docs/records/task-12.md)과 같은 값. 서버 검사가 최종이며 여기서는 빠른 안내용으로만 쓴다. */
export const CLIENT_LIMITS = { PHOTO: 10 * 1024 * 1024, MARKDOWN: 1024 * 1024, NOTE: 100 * 1024 } as const;

export type UploadStatus = 'uploading' | 'done' | 'failed' | 'canceled';

export interface UploadItem {
  id: string;
  kind: AttachKind;
  name: string;
  /** 같은 항목을 재시도해도 서버가 중복으로 처리하도록 항목마다 고정되는 키 */
  key: string;
  status: UploadStatus;
  /** 사용자에게 보여줄 한국어 사유 (실패·취소 시) */
  message?: string;
  retryable?: boolean;
  duplicate?: boolean;
  capturedAt?: string | null;
  capturedSource?: string | null;
}

export interface Uploadable {
  name: string;
  size: number;
  type?: string;
}

const MESSAGES: Record<string, { text: string; retryable: boolean }> = {
  UNREADABLE_FILE: { text: '파일을 읽을 수 없어 첨부하지 않았습니다. 손상되었을 수 있습니다. 다른 파일을 선택해 주세요.', retryable: false },
  EMPTY_FILE: { text: '내용이 비어 있어 첨부하지 않았습니다.', retryable: false },
  UNSUPPORTED_TYPE: { text: '지원하지 않는 형식입니다. 사진은 JPEG·PNG·GIF·WebP, 자료는 Markdown(.md)만 가능합니다.', retryable: false },
  TOO_LARGE: { text: '파일이 너무 큽니다. 사진 10MB, Markdown 1MB, 메모 100KB까지 가능합니다.', retryable: false },
  TOO_MANY_ATTACHMENTS: { text: '이 기록에 붙일 수 있는 자료 수(30개)를 넘었습니다.', retryable: false },
  CONFIRMED_LOCKED: { text: '이미 확정된 기록에는 자료를 추가할 수 없습니다.', retryable: false },
  NOT_FOUND: { text: '기록을 찾을 수 없습니다. 화면을 새로고침해 주세요.', retryable: false },
  IDEMPOTENCY_CONFLICT: { text: '같은 요청이 다른 내용으로 이미 처리되었습니다. 파일을 다시 선택해 주세요.', retryable: false },
};
const NETWORK = { text: '연결이 끊겨 첨부하지 못했습니다. 다시 시도할 수 있습니다.', retryable: true };
const UNKNOWN = { text: '첨부에 실패했습니다. 잠시 후 다시 시도해 주세요.', retryable: true };

/** 서버를 부르기 전 빠른 점검. 통과해도 서버가 다시 검사한다. */
export function precheck(kind: AttachKind, f: Uploadable): string | null {
  if (f.size === 0) return MESSAGES.EMPTY_FILE!.text;
  if (f.size > CLIENT_LIMITS[kind]) return MESSAGES.TOO_LARGE!.text;
  if (kind === 'PHOTO' && f.type && !/^image\/(jpeg|png|gif|webp)$/.test(f.type)) return MESSAGES.UNSUPPORTED_TYPE!.text;
  if (kind === 'MARKDOWN' && !/\.(md|markdown)$/i.test(f.name)) return MESSAGES.UNSUPPORTED_TYPE!.text;
  return null;
}

export interface UploadResult {
  ok: boolean;
  status: Extract<UploadStatus, 'done' | 'failed' | 'canceled'>;
  message?: string;
  retryable?: boolean;
  duplicate?: boolean;
  capturedAt?: string | null;
  capturedSource?: string | null;
}

/**
 * 파일 한 개를 기록에 올린다. 서버가 201/200 으로 응답한 경우에만 done 이다
 * (네트워크 오류·중단·4xx/5xx 는 모두 done 이 아니다).
 */
export async function uploadAttachment(
  o: { recordId: string; kind: AttachKind; key: string; name: string; body: Blob | string; signal?: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  const bad = o.body instanceof Blob ? precheck(o.kind, { name: o.name, size: o.body.size, type: o.body.type }) : precheck(o.kind, { name: o.name, size: new TextEncoder().encode(o.body).length });
  if (bad) return { ok: false, status: 'failed', message: bad, retryable: false };
  let res: Response;
  try {
    res = await fetchImpl(`/api/records/${encodeURIComponent(o.recordId)}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-idempotency-key': o.key,
        'x-attachment-kind': o.kind,
        'x-file-name': encodeURIComponent(o.name),
      },
      body: o.body,
      signal: o.signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return { ok: false, status: 'canceled', message: '첨부를 중단했습니다. 다시 시도할 수 있습니다.', retryable: true };
    return { ok: false, status: 'failed', message: NETWORK.text, retryable: true };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 'failed', message: '로그인이 만료되었습니다. 다시 로그인해 주세요.', retryable: false };
  if (res.ok) {
    const j = (await res.json().catch(() => null)) as { duplicate?: boolean; capturedAt?: string | null; capturedSource?: string | null } | null;
    if (!j) return { ok: false, status: 'failed', message: UNKNOWN.text, retryable: true };
    return { ok: true, status: 'done', duplicate: j.duplicate === true, capturedAt: j.capturedAt ?? null, capturedSource: j.capturedSource ?? null };
  }
  const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '';
  const m = MESSAGES[code] ?? (res.status >= 500 ? NETWORK : UNKNOWN);
  return { ok: false, status: 'failed', message: m.text, retryable: m.retryable };
}

const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

/** 촬영 시각 표시. 없으면 업로드 시각으로 대신하지 않고 '알 수 없음'이라고 쓴다. */
export function describeCapture(capturedAt: string | null | undefined, source?: string | null): string {
  if (!capturedAt) return '촬영 시각 알 수 없음';
  return `촬영 ${KST.format(new Date(capturedAt))}${source === 'EXIF_ASSUMED_KST' ? ' (시간대 정보가 없어 한국 시간으로 추정)' : ''}`;
}
