import { OidcClient, OidcError } from '../auth/oidc.js';
import type { PgDriveConnections } from './connections.js';

/** 인증 문제(미연결·만료·철회·권한 부족): 재시도 대신 권한 대기. */
export class DriveAuthError extends Error {
  constructor(readonly code: 'DRIVE_NOT_CONNECTED' | 'DRIVE_AUTH_EXPIRED' | 'DRIVE_PERMISSION_DENIED') { super(code); }
}
/** Drive 용량 부족: 재시도해도 같다. 기존 백업은 지우지 않고 실패로 남긴다. */
export class DriveQuotaError extends Error {
  constructor(readonly code = 'DRIVE_QUOTA_INSUFFICIENT') { super(code); }
}
/** 일시 오류(네트워크·5xx·429): 작업 큐의 자동 재시도 1회 대상. */
export class DriveTransientError extends Error {
  constructor(readonly detail = 'DRIVE_TRANSIENT') { super(detail); }
}
/** 요청 자체가 거절됨(400 등): 재시도해도 같다. */
export class DriveRequestError extends Error {
  constructor(readonly code = 'DRIVE_REQUEST_REJECTED') { super(code); }
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  md5: string | null;
  trashed: boolean;
  appProperties: Record<string, string>;
  parents: string[];
}

/**
 * 백업이 쓰는 Drive 기능. 삭제·휴지통·덮어쓰기(update) 메서드는 의도적으로 없다:
 * 백업 파일은 한 번 올리면 이 코드로는 지워지거나 바뀌지 않는다(서버 삭제 비전파, 용량 부족 시 자동 삭제 금지).
 */
export interface DriveApi {
  quota(): Promise<{ limit: number | null; usage: number }>;
  /** 같은 이름·부모의 폴더가 있으면 재사용, 없으면 만든다(응답 유실 후 재실행에도 중복 폴더를 만들지 않음). */
  ensureFolder(name: string, parentId: string | null): Promise<string>;
  /** 우리 앱이 붙인 항목 키로 이미 올린 파일을 찾는다(응답 유실 후 중복 업로드 방지). */
  findByItemKey(itemKey: string): Promise<DriveFile | null>;
  upload(p: { name: string; parentId: string; mime: string; bytes: Buffer; appProperties: Record<string, string> }): Promise<DriveFile>;
  get(fileId: string): Promise<DriveFile | null>;
}

const FIELDS = 'id,name,size,md5Checksum,trashed,appProperties,parents';
const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export interface GoogleDriveOptions {
  accessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  uploadBase?: string;
}

export class GoogleDriveClient implements DriveApi {
  private readonly f: typeof fetch;
  private readonly api: string;
  private readonly up: string;
  constructor(private readonly o: GoogleDriveOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.api = o.apiBase ?? 'https://www.googleapis.com/drive/v3';
    this.up = o.uploadBase ?? 'https://www.googleapis.com/upload/drive/v3';
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await this.o.accessToken()}` } });
    } catch (e) {
      if (e instanceof DriveAuthError) throw e;
      throw new DriveTransientError('DRIVE_NETWORK');
    }
    if (res.ok) return res;
    const reason = await errorReason(res);
    if (res.status === 401) throw new DriveAuthError('DRIVE_AUTH_EXPIRED');
    if (res.status === 403) {
      if (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded') throw new DriveQuotaError();
      if (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded' || reason === 'backendError') throw new DriveTransientError('DRIVE_RATE_LIMIT');
      throw new DriveAuthError('DRIVE_PERMISSION_DENIED');
    }
    if (res.status === 429 || res.status >= 500) throw new DriveTransientError(`DRIVE_HTTP_${res.status}`);
    if (res.status === 404) throw new DriveRequestError('DRIVE_NOT_FOUND');
    throw new DriveRequestError('DRIVE_REQUEST_REJECTED');
  }

  async quota() {
    const r = await this.call(`${this.api}/about?fields=storageQuota`);
    const sq = ((await r.json()) as { storageQuota?: { limit?: string; usage?: string } }).storageQuota ?? {};
    return { limit: sq.limit !== undefined ? Number(sq.limit) : null, usage: Number(sq.usage ?? 0) };
  }

  async ensureFolder(name: string, parentId: string | null): Promise<string> {
    const parent = parentId ? ` and '${q(parentId)}' in parents` : ` and 'root' in parents`;
    const found = await this.list(`mimeType='application/vnd.google-apps.folder' and name='${q(name)}' and trashed=false${parent}`);
    if (found[0]) return found[0].id;
    const r = await this.call(`${this.api}/files?fields=id`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
    });
    return ((await r.json()) as { id: string }).id;
  }

  async findByItemKey(itemKey: string): Promise<DriveFile | null> {
    return (await this.list(`appProperties has { key='dlItemKey' and value='${q(itemKey)}' } and trashed=false`))[0] ?? null;
  }

  private async list(query: string): Promise<DriveFile[]> {
    const r = await this.call(`${this.api}/files?${new URLSearchParams({ q: query, fields: `files(${FIELDS})`, pageSize: '10', spaces: 'drive' })}`);
    return ((await r.json()) as { files?: RawFile[] }).files?.map(toFile) ?? [];
  }

  async upload(p: { name: string; parentId: string; mime: string; bytes: Buffer; appProperties: Record<string, string> }): Promise<DriveFile> {
    // 재개 가능 업로드: 메타데이터로 세션을 연 뒤 본문을 한 번에 보낸다. 새 파일만 만들고 기존 파일은 갱신하지 않는다.
    const init = await this.call(`${this.up}/files?${new URLSearchParams({ uploadType: 'resumable', fields: FIELDS })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': p.mime, 'x-upload-content-length': String(p.bytes.length) },
      body: JSON.stringify({ name: p.name, parents: [p.parentId], appProperties: p.appProperties }),
    });
    const loc = init.headers.get('location');
    if (!loc) throw new DriveRequestError('DRIVE_NO_UPLOAD_SESSION');
    const done = await this.call(loc, { method: 'PUT', headers: { 'content-type': p.mime, 'content-length': String(p.bytes.length) }, body: new Uint8Array(p.bytes) });
    return toFile((await done.json()) as RawFile);
  }

  async get(fileId: string): Promise<DriveFile | null> {
    try {
      const r = await this.call(`${this.api}/files/${encodeURIComponent(fileId)}?fields=${FIELDS}`);
      return toFile((await r.json()) as RawFile);
    } catch (e) {
      if (e instanceof DriveRequestError && e.code === 'DRIVE_NOT_FOUND') return null;
      throw e;
    }
  }
}

interface RawFile { id: string; name?: string; size?: string; md5Checksum?: string; trashed?: boolean; appProperties?: Record<string, string>; parents?: string[] }
const toFile = (r: RawFile): DriveFile => ({
  id: r.id, name: r.name ?? '', size: Number(r.size ?? 0), md5: r.md5Checksum ?? null, trashed: r.trashed === true, appProperties: r.appProperties ?? {}, parents: r.parents ?? [],
});

async function errorReason(res: Response): Promise<string | null> {
  try {
    const j = (await res.json()) as { error?: { errors?: { reason?: string }[] } };
    return j.error?.errors?.[0]?.reason ?? null;
  } catch {
    return null;
  }
}

/** 소유자별 접근 토큰을 갱신 토큰에서 얻는다. 인증 거절(철회·만료)이면 연결 상태를 AUTH_EXPIRED 로 바꾼다. */
export function createDriveFactory(deps: { connections: PgDriveConnections; oidc: OidcClient | null; fetchImpl?: typeof fetch; apiBase?: string; uploadBase?: string; now?: () => number }) {
  const cache = new Map<string, { token: string; until: number }>();
  const now = deps.now ?? Date.now;
  return async function forOwner(ownerId: string): Promise<DriveApi> {
    const rt = await deps.connections.refreshToken(ownerId);
    if ('problem' in rt) throw new DriveAuthError(rt.problem === 'NOT_CONNECTED' ? 'DRIVE_NOT_CONNECTED' : 'DRIVE_AUTH_EXPIRED');
    if (!deps.oidc) throw new DriveAuthError('DRIVE_NOT_CONNECTED');
    const oidc = deps.oidc;
    return new GoogleDriveClient({
      fetchImpl: deps.fetchImpl, apiBase: deps.apiBase, uploadBase: deps.uploadBase,
      accessToken: async () => {
        const c = cache.get(ownerId);
        if (c && c.until > now() + 60_000) return c.token;
        try {
          const t = await oidc.refresh(rt.token);
          cache.set(ownerId, { token: t.accessToken, until: now() + t.expiresInSeconds * 1000 });
          return t.accessToken;
        } catch (e) {
          if (e instanceof OidcError && e.code === 'invalid_grant') {
            cache.delete(ownerId);
            await deps.connections.markExpired(ownerId, 'INVALID_GRANT');
            throw new DriveAuthError('DRIVE_AUTH_EXPIRED');
          }
          throw new DriveTransientError('DRIVE_TOKEN_REFRESH');
        }
      },
    });
  };
}
