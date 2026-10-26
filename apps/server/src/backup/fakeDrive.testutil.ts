// 시험 전용 가짜 Google Drive v3 서버. 실제 Drive 호출 없이 GoogleDriveClient 의 요청 형식을 그대로 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; bytes: Buffer; trashed: boolean; md5Override?: string }

export async function startFakeDrive() {
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, { meta: Record<string, unknown> }>();
  const log: { method: string; path: string }[] = [];
  const st = {
    /** null 이면 무제한 계정(limit 없음) */
    limit: null as number | null,
    usage: 0,
    /** 다음 N 번의 파일 업로드(PUT)를 503 으로 실패시킴 */
    failUploads: 0,
    /** 다음 업로드는 파일을 저장하되 응답을 유실(500)시킴 */
    loseUploadResponse: false,
    /** 다음 업로드의 MD5 를 틀리게 저장 */
    corruptNextUpload: false,
    /** 모든 요청을 401 로 거절 */
    unauthorized: false,
    /** 업로드를 용량 초과(403 storageQuotaExceeded)로 거절 */
    rejectQuota: false,
    uploads: 0,
  };
  let base = '';
  const md5 = (f: FakeFile) => f.md5Override ?? createHash('md5').update(f.bytes).digest('hex');
  const view = (f: FakeFile) => ({ id: f.id, name: f.name, size: String(f.bytes.length), md5Checksum: f.mimeType.includes('folder') ? undefined : md5(f), trashed: f.trashed, appProperties: f.appProperties, parents: f.parents });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    log.push({ method: req.method ?? '', path: url.pathname });
    const json = (o: unknown, code = 200, headers: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
    const err = (code: number, reason: string) => json({ error: { code, errors: [{ reason }] } }, code);
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (st.unauthorized || !(req.headers.authorization ?? '').startsWith('Bearer mock-access')) return err(401, 'authError');
      if (url.pathname === '/drive/v3/about') {
        return json({ storageQuota: { ...(st.limit !== null ? { limit: String(st.limit) } : {}), usage: String(st.usage + [...files.values()].reduce((n, f) => n + f.bytes.length, 0)) } });
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        let hits = [...files.values()].filter((f) => !f.trashed);
        const key = /dlItemKey' and value='([^']+)'/.exec(q)?.[1];
        const name = /name='([^']+)'/.exec(q)?.[1];
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        if (key) hits = hits.filter((f) => f.appProperties.dlItemKey === key);
        else if (name) hits = hits.filter((f) => f.mimeType.includes('folder') && f.name === name && (parent === 'root' ? f.parents.length === 0 : f.parents.includes(parent ?? '')));
        return json({ files: hits.map(view) });
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
        const m = JSON.parse(body.toString()) as { name: string; mimeType: string; parents?: string[] };
        const f: FakeFile = { id: randomUUID(), name: m.name, mimeType: m.mimeType, parents: m.parents ?? [], appProperties: {}, bytes: Buffer.alloc(0), trashed: false };
        files.set(f.id, f);
        return json(view(f));
      }
      if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        if (url.searchParams.get('uploadType') !== 'resumable') return err(400, 'badRequest');
        if (st.rejectQuota) return err(403, 'storageQuotaExceeded');
        const id = randomUUID();
        sessions.set(id, { meta: JSON.parse(body.toString()) });
        return json({}, 200, { location: `${base}/upload/session/${id}` });
      }
      const sess = /^\/upload\/session\/(.+)$/.exec(url.pathname);
      if (sess && req.method === 'PUT') {
        const s = sessions.get(sess[1]!);
        if (!s) return err(404, 'notFound');
        if (st.failUploads > 0) { st.failUploads--; return err(503, 'backendError'); }
        if (st.rejectQuota) return err(403, 'storageQuotaExceeded');
        st.uploads++;
        const m = s.meta as { name: string; parents: string[]; appProperties: Record<string, string> };
        const f: FakeFile = { id: randomUUID(), name: m.name, mimeType: String(req.headers['content-type']), parents: m.parents, appProperties: m.appProperties ?? {}, bytes: body, trashed: false };
        if (st.corruptNextUpload) { st.corruptNextUpload = false; f.md5Override = '0'.repeat(32); }
        files.set(f.id, f);
        sessions.delete(sess[1]!);
        if (st.loseUploadResponse) { st.loseUploadResponse = false; res.destroy(); return; }
        return json(view(f));
      }
      const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (one && req.method === 'GET') {
        const f = files.get(decodeURIComponent(one[1]!));
        return f ? json(view(f)) : err(404, 'notFound');
      }
      return err(404, 'notFound');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, apiBase: `${base}/drive/v3`, uploadBase: `${base}/upload/drive/v3`, files, log, state: st,
    uploaded: () => [...files.values()].filter((f) => !f.mimeType.includes('folder')),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
