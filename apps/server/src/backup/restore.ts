/** Explicit synthetic restore drill. Never registered in the app/worker or connected to real Drive. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resultFileName } from '../records/view.js';
import type { BackupKind } from './plan.js';

export interface RestoreManifest {
  ownerId: string;
  interviewId: string;
  items: { kind: BackupKind; key: string; version: string; sha256: string; md5: string; size: number; fileId: string }[];
}
export class RestoreError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new RestoreError(code); };
const hash = (b: Buffer, algorithm: string) => createHash(algorithm).update(b).digest('hex');
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const sha = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const object = (s: unknown): s is Record<string, unknown> => typeof s === 'object' && s !== null && !Array.isArray(s);
const integer = (s: unknown): s is number => Number.isSafeInteger(s) && Number(s) > 0;
const date = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));
const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

interface Snapshot {
  schema: number; interviewId: string; lifeDate: string; status: string; revision: number; startedAt: string; createdAt: string;
  pipeline: { production: string; review: string };
  items: { id: string; seq: number; kind: string; body: string }[];
  attachments: { storageKey: string; checksum: string; kind: string; name: string | null; mime: string | null; size: number; itemId: string | null }[];
  versions: { kind: string; version: number; content: unknown }[];
  resultMarks: { version: number; was_passed: boolean; superseded_at: string; superseded_by_revision: number }[];
}
function snapshotFrom(bytes: Buffer, manifest: RestoreManifest): Snapshot {
  let v: unknown;
  try { v = JSON.parse(bytes.toString('utf8')); } catch { return fail('INVALID_SNAPSHOT'); }
  if (!object(v)) return fail('INVALID_SNAPSHOT');
  // v1 omitted item IDs and review state; never guess a relationship or promote an unreviewed video.
  if (v.schema !== 2) return fail('UNSUPPORTED_SNAPSHOT');
  if (v.interviewId !== manifest.interviewId || !date(v.startedAt) || !date(v.createdAt) ||
      typeof v.lifeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.lifeDate) ||
      !['IN_PROGRESS', 'CONFIRMED'].includes(String(v.status)) || !integer(v.revision) ||
      !object(v.pipeline) || !['NONE', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'WAITING_BUDGET'].includes(String(v.pipeline.production)) ||
      !['NONE', 'PENDING', 'PASSED', 'REJECTED'].includes(String(v.pipeline.review)) ||
      !Array.isArray(v.items) || !Array.isArray(v.attachments) || !Array.isArray(v.versions) || !Array.isArray(v.resultMarks)) return fail('INVALID_SNAPSHOT');
  const ids = new Set<string>(); const seqs = new Set<number>();
  for (const i of v.items) {
    if (!object(i) || !uuid(i.id) || ids.has(i.id) || !integer(i.seq) || seqs.has(i.seq) || !['QUESTION', 'ANSWER'].includes(String(i.kind)) || typeof i.body !== 'string') return fail('INVALID_SNAPSHOT');
    ids.add(i.id); seqs.add(i.seq);
  }
  const required = new Set(['RECORD:record.json']);
  for (const a of v.attachments) {
    if (!object(a) || typeof a.storageKey !== 'string' || !/^[a-f0-9]{64}\.\w{1,8}$/.test(a.storageKey) || !sha(a.checksum) || !integer(a.size) ||
        !['PHOTO', 'MARKDOWN', 'NOTE'].includes(String(a.kind)) || !(a.itemId === null || (typeof a.itemId === 'string' && ids.has(a.itemId))) ||
        !(a.name === null || typeof a.name === 'string') || !(a.mime === null || typeof a.mime === 'string')) return fail('INVALID_SNAPSHOT');
    const m = manifest.items.find(i => i.kind === 'ATTACHMENT' && i.key === a.storageKey);
    if (!m || m.sha256 !== a.checksum || m.size !== a.size) return fail('MANIFEST_INCOMPLETE');
    required.add(`ATTACHMENT:${a.storageKey}`);
  }
  const versions = new Set<string>(); let latestResult: { version: number; content: unknown } | undefined;
  for (const r of v.versions) {
    if (!object(r) || !['SUMMARY', 'PRODUCTION_PLAN', 'RESULT'].includes(String(r.kind)) || !integer(r.version) || !object(r.content) || versions.has(`${r.kind}:${r.version}`)) return fail('INVALID_SNAPSHOT');
    versions.add(`${r.kind}:${r.version}`);
    if (r.kind === 'RESULT' && (!latestResult || r.version > latestResult.version)) latestResult = { version: r.version, content: r.content };
  }
  if (latestResult) {
    const name = resultFileName(latestResult.content);
    const m = manifest.items.find(i => i.kind === 'VIDEO' && i.key === name && i.version === `result.v${latestResult.version}`);
    if (!name || !m) return fail('MANIFEST_INCOMPLETE');
    const c = latestResult.content as { sha256?: unknown; bytes?: unknown };
    if ((c.sha256 !== undefined && c.sha256 !== m.sha256) || (c.bytes !== undefined && c.bytes !== m.size)) return fail('MANIFEST_INCOMPLETE');
    required.add(`VIDEO:${name}`);
  }
  for (const r of v.resultMarks) {
    if (!object(r) || !integer(r.version) || !versions.has(`RESULT:${r.version}`) || typeof r.was_passed !== 'boolean' || !date(r.superseded_at) || !integer(r.superseded_by_revision)) return fail('INVALID_SNAPSHOT');
  }
  if (manifest.items.some(i => !required.has(`${i.kind}:${i.key}`))) return fail('INVALID_MANIFEST');
  return v as unknown as Snapshot;
}

/** The caller supplies an isolated test DATABASE_URL and a trusted inventory of one backup version.
 * Creates only a random new schema and directory; no target schema/path can be supplied for overwrite.
 * All remote data is checked before any database/file mutation. Only loopback fake Drive is supported.
 */
export async function restoreDrill(o: {
  databaseUrl: string; targetParent: string; sourceFileStorageDir: string; manifest: RestoreManifest; driveApiBase: string;
}): Promise<{ schema: string; fileStorageDir: string; interviewId: string }> {
  let base: URL;
  try { base = new URL(o.driveApiBase); } catch { return fail('LOCAL_DRIVE_REQUIRED'); }
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/drive/v3' || base.username || base.password || base.search || base.hash) return fail('LOCAL_DRIVE_REQUIRED');
  const parent = await realpath(o.targetParent); const source = await realpath(o.sourceFileStorageDir);
  if (contains(source, parent) || contains(parent, source)) return fail('UNSAFE_TARGET');
  const m = o.manifest;
  if (!m || typeof m.ownerId !== 'string' || !m.ownerId.trim() || !uuid(m.interviewId) || !Array.isArray(m.items) || m.items.length === 0 || m.items.length > 1000) return fail('INVALID_MANIFEST');
  const keys = new Set<string>(); const fileIds = new Set<string>();
  for (const i of m.items) {
    if (!i || !['RECORD', 'ATTACHMENT', 'VIDEO'].includes(i.kind) || typeof i.key !== 'string' ||
        (i.kind === 'RECORD' ? i.key !== 'record.json' : i.kind === 'ATTACHMENT' ? !/^[a-f0-9]{64}\.\w{1,8}$/.test(i.key) : resultFileName({ file: i.key }) === null) ||
        !sha(i.sha256) || !/^[a-f0-9]{32}$/.test(i.md5) || !integer(i.size) || i.size > 256 * 1024 * 1024 ||
        typeof i.version !== 'string' || !i.version || typeof i.fileId !== 'string' || !/^[\w-]+$/.test(i.fileId) || keys.has(`${i.kind}:${i.key}`) || fileIds.has(i.fileId)) return fail('INVALID_MANIFEST');
    keys.add(`${i.kind}:${i.key}`); fileIds.add(i.fileId);
  }
  if (m.items.filter(i => i.kind === 'RECORD').length !== 1) return fail('INVALID_MANIFEST');
  const get = async (suffix: string) => {
    let r: Response;
    try { r = await fetch(`${base.href}/files/${suffix}`, { headers: { authorization: 'Bearer mock-access-restore-drill' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { return fail('DRIVE_UNAVAILABLE'); }
    if (r.status === 404) return fail('BACKUP_MISSING');
    if (!r.ok) return fail('DRIVE_UNAVAILABLE');
    return r;
  };
  const contents = new Map<string, Buffer>();
  for (const i of m.items) {
    const meta: unknown = await (await get(i.fileId)).json().catch(() => fail('INVALID_METADATA'));
    if (!object(meta) || meta.trashed === true) return fail('BACKUP_MISSING');
    if (meta.id !== i.fileId) return fail('INVALID_METADATA');
    if (Number(meta.size) !== i.size) return fail('SIZE_MISMATCH');
    if (meta.md5Checksum !== i.md5) return fail('MD5_MISMATCH');
    const props = meta.appProperties;
    if (!object(props) || props.dlInterview !== m.interviewId || props.dlKind !== i.kind || props.dlVersion !== i.version || props.dlSha256 !== i.sha256) return fail('SHA256_MISMATCH');
    const response = await get(`${i.fileId}?alt=media`);
    const chunks: Buffer[] = []; let length = 0;
    if (!response.body) return fail('BACKUP_MISSING');
    try {
      for await (const part of response.body) {
        length += part.length;
        if (length > i.size) return fail('SIZE_MISMATCH');
        chunks.push(Buffer.from(part));
      }
    } catch (e) { if (e instanceof RestoreError) throw e; return fail('DRIVE_UNAVAILABLE'); }
    const bytes = Buffer.concat(chunks);
    if (length !== i.size) return fail('SIZE_MISMATCH');
    if (hash(bytes, 'md5') !== i.md5) return fail('MD5_MISMATCH');
    if (hash(bytes, 'sha256') !== i.sha256) return fail('SHA256_MISMATCH');
    contents.set(`${i.kind}:${i.key}`, bytes);
  }
  const snapshotBytes = contents.get('RECORD:record.json')!;
  const s = snapshotFrom(snapshotBytes, m);
  const schema = `restore_drill_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: o.databaseUrl, max: 1 });
  let target: string | undefined;
  const c = await admin.connect().catch(async () => { await admin.end(); return fail('DATABASE_UNAVAILABLE'); });
  try {
    await c.query('BEGIN');
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    const migrations = fileURLToPath(new URL('../db/migrations/', import.meta.url));
    for (const f of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await c.query(await readFile(path.join(migrations, f), 'utf8'));
    target = await mkdtemp(path.join(parent, 'restore-drill-'));
    await mkdir(path.join(target, 'attachments')); await mkdir(path.join(target, 'videos'));
    for (const i of m.items) {
      const dest = i.kind === 'RECORD' ? path.join(target, 'record.json') : path.join(target, i.kind === 'ATTACHMENT' ? 'attachments' : 'videos', i.key);
      await writeFile(dest, contents.get(`${i.kind}:${i.key}`)!, { flag: 'wx', mode: 0o600 });
    }
    await c.query(`INSERT INTO interviews (id, owner_id, life_date, started_at, status, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [s.interviewId, m.ownerId, s.lifeDate, s.startedAt, s.status, s.revision, s.createdAt]);
    for (const i of s.items) await c.query(`INSERT INTO conversation_items (id,interview_id,seq,idempotency_key,kind,body,saved_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [i.id,s.interviewId,i.seq,`restore:${i.seq}`,i.kind,i.body,s.createdAt]);
    for (const [idx,a] of s.attachments.entries()) await c.query(`INSERT INTO attachment_refs (id,interview_id,item_id,idempotency_key,storage_key,checksum,saved_at,kind,original_name,mime_type,size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(),s.interviewId,a.itemId,`restore:${idx}`,a.storageKey,a.checksum,s.createdAt,a.kind,a.name,a.mime,a.size]);
    for (const v of s.versions) await c.query(`INSERT INTO record_versions (id,interview_id,kind,version,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(),s.interviewId,v.kind,v.version,JSON.stringify(v.content),s.createdAt]);
    await c.query(`INSERT INTO pipeline_states (interview_id,production,review,backup,updated_at) VALUES ($1,$2,$3,'NONE',$4)`, [s.interviewId,s.pipeline.production,s.pipeline.review,s.createdAt]);
    for (const mark of s.resultMarks) await c.query(`INSERT INTO result_version_marks (interview_id,version,was_passed,superseded_at,superseded_by_revision) VALUES ($1,$2,$3,$4,$5)`, [s.interviewId,mark.version,mark.was_passed,mark.superseded_at,mark.superseded_by_revision]);
    await writeFile(path.join(target, 'restore-manifest.json'), JSON.stringify(m, null, 2), { flag: 'wx', mode: 0o600 });
    await c.query('COMMIT');
    return { schema, fileStorageDir: target, interviewId: s.interviewId };
  } catch (e) {
    await c.query('ROLLBACK');
    if (target) await rm(target, { recursive: true, force: true });
    if (e instanceof RestoreError) throw e;
    return fail('RESTORE_WRITE_FAILED');
  } finally { c.release(); await admin.end(); }
}
