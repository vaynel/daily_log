import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { resultFileName } from '../records/view.js';

export type BackupKind = 'RECORD' | 'ATTACHMENT' | 'VIDEO';

export interface PlanItem {
  kind: BackupKind;
  key: string;
  /** 대응 버전 정보. 기록: revision 과 요약/계획/결과 버전, 첨부: 내용 해시, 영상: RESULT 버전. */
  label: string;
  sha256: string;
  size: number;
  mime: string;
  driveName: string;
  /** Drive appProperties 에 붙여 응답 유실 후 같은 파일을 찾는 키(소유자·기록·종류·키·해시의 해시). */
  itemKey: string;
  source: { bytes: Buffer } | { file: string; available: boolean };
}
export interface PlanProblem { kind: BackupKind; key: string; code: 'SOURCE_FILE_MISSING' | 'SOURCE_SIZE_UNKNOWN' }
export interface BackupPlan {
  interviewId: string;
  ownerId: string;
  lifeDate: string;
  status: string;
  revision: number;
  items: PlanItem[];
  problems: PlanProblem[];
  fingerprint: string;
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export async function hashFile(file: string): Promise<{ sha256: string; md5: string; size: number }> {
  const s = createHash('sha256');
  const m = createHash('md5');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    s.update(chunk as Buffer);
    m.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: s.digest('hex'), md5: m.digest('hex'), size };
}

const fileSize = (file: string) => stat(file).then((s) => (s.isFile() ? s.size : null), () => null);
const SHA = /^[a-f0-9]{64}$/;

/**
 * 한 기록의 백업 대상 목록. 대상은 (1) 기록 스냅샷(대화 항목·첨부 목록·요약/계획/결과 버전) (2) 첨부 원본 (3) 완성 영상 뿐이다.
 * 음성(audio_segments)은 조회하지도 않으며 스냅샷 형식에도 필드가 없다(AC-2).
 */
export async function buildBackupPlan(pool: pg.Pool, fileStorageDir: string, interviewId: string): Promise<BackupPlan | null> {
  const iv = (await pool.query(
    `SELECT id, owner_id, to_char(life_date,'YYYY-MM-DD') AS life_date, status, revision, deleted_at, server_cleaned_at FROM interviews WHERE id=$1`, [interviewId])).rows[0];
  if (!iv) return null;
  // 휴지통·서버 사본 정리(TASK-29) 후의 기록은 백업 대상이 아니다: 비어 있거나 지워진 내용을 새 버전으로 올리지 않는다(Drive 의 기존 백업은 그대로).
  if (iv.deleted_at || iv.server_cleaned_at) return null;
  const [items, atts, vers] = await Promise.all([
    pool.query('SELECT id, seq, kind, body FROM conversation_items WHERE interview_id=$1 AND deleted_at IS NULL ORDER BY seq', [interviewId]),
    pool.query(`SELECT id, item_id, storage_key, checksum, kind, original_name, mime_type, size_bytes FROM attachment_refs WHERE interview_id=$1 AND deleted_at IS NULL ORDER BY saved_at, id`, [interviewId]),
    pool.query('SELECT kind, version, content FROM record_versions WHERE interview_id=$1 ORDER BY kind, version', [interviewId]),
  ]);
  const lifeDate = iv.life_date as string;
  const maxOf = (k: string) => Math.max(0, ...vers.rows.filter((v) => v.kind === k).map((v) => Number(v.version)));
  const out: PlanItem[] = [];
  const problems: PlanProblem[] = [];
  const mk = (kind: BackupKind, key: string, label: string, sha: string, size: number, mime: string, source: PlanItem['source']): PlanItem => ({
    kind, key, label, sha256: sha, size, mime, source,
    driveName: `${lifeDate}_${kind.toLowerCase()}_${sha.slice(0, 8)}_${key}`,
    itemKey: sha256Hex(`${iv.owner_id}|${interviewId}|${kind}|${key}|${sha}`),
  });

  // 1) 기록 스냅샷. 시각처럼 실행마다 달라지는 값은 넣지 않아 내용이 같으면 해시도 같다(중복 업로드 방지).
  const snapshot = {
    schema: 1,
    interviewId, lifeDate, status: iv.status, revision: Number(iv.revision),
    items: items.rows.map((x) => ({ seq: x.seq, kind: x.kind, body: x.body })),
    attachments: atts.rows.map((x) => ({ storageKey: x.storage_key, checksum: x.checksum, kind: x.kind, name: x.original_name, mime: x.mime_type, size: x.size_bytes === null ? null : Number(x.size_bytes), itemId: x.item_id })),
    versions: vers.rows.map((x) => ({ kind: x.kind, version: x.version, content: x.content })),
  };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
  out.push(mk('RECORD', 'record.json', `rev${snapshot.revision}.s${maxOf('SUMMARY')}.p${maxOf('PRODUCTION_PLAN')}.r${maxOf('RESULT')}`, sha256Hex(bytes), bytes.length, 'application/json', { bytes }));

  // 2) 첨부 원본(내용 해시 이름으로 한 번만 저장된 파일). 같은 파일을 여러 참조가 가리켜도 한 건.
  const seen = new Set<string>();
  for (const a of atts.rows) {
    const key = a.storage_key as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = path.join(fileStorageDir, 'attachments', key);
    const size = a.size_bytes === null ? await fileSize(file) : Number(a.size_bytes);
    const available = (await fileSize(file)) !== null;
    if (size === null) { problems.push({ kind: 'ATTACHMENT', key, code: 'SOURCE_FILE_MISSING' }); continue; }
    out.push(mk('ATTACHMENT', key, `sha${(a.checksum as string).slice(0, 12)}`, a.checksum as string, size, (a.mime_type as string | null) ?? 'application/octet-stream', { file, available }));
  }

  // 3) 완성 영상: 최신 RESULT 버전이 가리키는 파일.
  const latest = vers.rows.filter((v) => v.kind === 'RESULT').at(-1);
  const name = latest ? resultFileName(latest.content) : null;
  if (latest && name) {
    const file = path.join(fileStorageDir, 'videos', name);
    const c = latest.content as { sha256?: unknown; bytes?: unknown };
    let sha = typeof c.sha256 === 'string' && SHA.test(c.sha256) ? c.sha256 : null;
    let size = typeof c.bytes === 'number' ? c.bytes : await fileSize(file);
    const available = (await fileSize(file)) !== null;
    if (available && (!sha || size === null)) { const h = await hashFile(file); sha ??= h.sha256; size ??= h.size; }
    if (!sha || size === null) {
      // 서버 영상이 이미 없어도 같은 파일의 검증된 백업이 있으면 그 해시·크기를 사용한다(다시 올릴 필요 없음).
      const prev = (await pool.query(`SELECT content_sha256, size_bytes FROM backup_items WHERE interview_id=$1 AND item_kind='VIDEO' AND item_key=$2 AND status='VERIFIED' ORDER BY verified_at DESC LIMIT 1`, [interviewId, name])).rows[0];
      if (prev && !available) { sha = prev.content_sha256 as string; size = Number(prev.size_bytes); }
    }
    if (!sha) problems.push({ kind: 'VIDEO', key: name, code: 'SOURCE_FILE_MISSING' });
    else if (size === null) problems.push({ kind: 'VIDEO', key: name, code: 'SOURCE_SIZE_UNKNOWN' });
    else out.push(mk('VIDEO', name, `result.v${latest.version}`, sha, size, 'video/mp4', { file, available }));
  }

  const fingerprint = sha256Hex(out.map((i) => `${i.kind}|${i.key}|${i.sha256}`).sort().join('\n') + '\n' + problems.map((p) => `${p.kind}|${p.key}|${p.code}`).sort().join('\n'));
  return { interviewId, ownerId: iv.owner_id as string, lifeDate, status: iv.status as string, revision: Number(iv.revision), items: out, problems, fingerprint };
}
