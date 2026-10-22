import { createHash } from 'node:crypto';

/** 첨부 검사 기준. docs/records/task-12.md 와 같은 값을 유지한다. */
export const LIMITS = {
  photoBytes: 10 * 1024 * 1024,
  markdownBytes: 1024 * 1024,
  noteBytes: 100 * 1024,
  /** 한 기록에 연결할 수 있는 첨부(중복 제외) 수 */
  perRecord: 30,
} as const;

export type AttachmentKind = 'PHOTO' | 'MARKDOWN' | 'NOTE';
export type AttachmentErrorCode = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'UNREADABLE_FILE' | 'TOO_MANY' | 'EMPTY_FILE';

export class AttachmentError extends Error {
  constructor(public readonly code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface Validated {
  kind: AttachmentKind;
  mime: string;
  ext: string;
  size: number;
  checksum: string;
  capturedAt: Date | null;
  capturedSource: 'EXIF' | 'EXIF_ASSUMED_KST' | null;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const u32 = (b: Buffer, o: number) => b.readUInt32BE(o);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** PNG: 시그니처, 모든 청크 CRC, IHDR 첫 청크, IEND 마지막 청크. */
function checkPng(b: Buffer): boolean {
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let o = 8;
  let first = true;
  let sawData = false;
  while (o + 12 <= b.length) {
    const len = u32(b, o);
    const type = b.toString('latin1', o + 4, o + 8);
    if (o + 12 + len > b.length) return false;
    if (first && type !== 'IHDR') return false;
    first = false;
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== u32(b, o + 8 + len)) return false;
    if (type === 'IDAT') sawData = true;
    o += 12 + len;
    if (type === 'IEND') return sawData && o === b.length;
  }
  return false;
}

/** JPEG: SOI, 세그먼트 구조 순회로 SOF(해상도) 존재, 끝 EOI. 잘린 파일은 거부한다. */
function checkJpeg(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let o = 2;
  let sof = false;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return false;
    const m = b[o + 1]!;
    if (m === 0xff) { o++; continue; }
    // 이후는 압축 데이터. 스캔 데이터의 0xFF 는 0x00 으로 이스케이프되므로 FFD9 는 EOI 뿐이다.
    // 잘린 파일은 EOI 가 없어 거부하고, EOI 뒤 추가 데이터(Motion Photo·MPF)는 허용한다.
    if (m === 0xda) return sof && b.indexOf(Buffer.from([0xff, 0xd9]), o + 2) !== -1;
    if (m === 0xd9) return false;
    const len = b.readUInt16BE(o + 2);
    if (len < 2 || o + 2 + len > b.length) return false;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8 || b.readUInt16BE(o + 5) === 0 || b.readUInt16BE(o + 7) === 0) return false;
      sof = true;
    }
    o += 2 + len;
  }
  return false;
}

function checkGif(b: Buffer): boolean {
  const h = b.toString('latin1', 0, 6);
  return (h === 'GIF87a' || h === 'GIF89a') && b.length > 13 && b[b.length - 1] === 0x3b;
}

function checkWebp(b: Buffer): boolean {
  return b.length > 20 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * JPEG EXIF 의 촬영 시각(DateTimeOriginal → DateTimeDigitized). 없거나 형식·값이 올바르지 않으면 null.
 * 업로드 시각이나 파일 수정 시각으로 대체하지 않는다. OffsetTime 이 없으면 한국 시간으로 가정하되 출처에 표시한다.
 */
export function extractCaptureTime(b: Buffer, now: Date): { at: Date; source: 'EXIF' | 'EXIF_ASSUMED_KST' } | null {
  try {
    let o = 2;
    while (o + 4 <= b.length && b[o] === 0xff) {
      const m = b[o + 1]!;
      if (m === 0xda) return null;
      const len = b.readUInt16BE(o + 2);
      if (m === 0xe1 && b.toString('latin1', o + 4, o + 10) === 'Exif\0\0') return fromTiff(b.subarray(o + 10, o + 2 + len), now);
      o += 2 + len;
    }
  } catch {
    /* 손상된 EXIF 는 촬영 시각 없음으로 처리 */
  }
  return null;
}

function fromTiff(t: Buffer, now: Date): { at: Date; source: 'EXIF' | 'EXIF_ASSUMED_KST' } | null {
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32v = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const readIfd = (off: number) => {
    const out = new Map<number, { type: number; count: number; at: number }>();
    if (off + 2 > t.length) return out;
    const n = u16(off);
    for (let i = 0; i < n && off + 2 + i * 12 + 12 <= t.length; i++) {
      const e = off + 2 + i * 12;
      out.set(u16(e), { type: u16(e + 2), count: u32v(e + 4), at: e + 8 });
    }
    return out;
  };
  const str = (e: { type: number; count: number; at: number }) => {
    if (e.type !== 2 || e.count < 1) return null;
    const start = e.count <= 4 ? e.at : u32v(e.at);
    if (start + e.count > t.length) return null;
    return t.toString('latin1', start, start + e.count).replace(/\0.*$/s, '');
  };
  const ifd0 = readIfd(u32v(4));
  const ptr = ifd0.get(0x8769);
  if (!ptr) return null;
  const exif = readIfd(u32v(ptr.at));
  const raw = [0x9003, 0x9004].map((tag) => exif.get(tag)).map((e) => (e ? str(e) : null)).find((s) => s);
  const m = raw ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const offTag = exif.get(0x9011) ?? exif.get(0x9012);
  const offRaw = offTag ? str(offTag) : null;
  const om = offRaw ? /^([+-])(\d{2}):(\d{2})$/.exec(offRaw) : null;
  const offset = om ? `${om[1]}${om[2]}:${om[3]}` : '+09:00';
  const at = new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${offset}`);
  if (Number.isNaN(at.getTime())) return null;
  // 달력에 없는 날짜(2월 30일 등)는 거부한다.
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  if (at.getTime() > now.getTime() + 24 * 3600 * 1000) return null;
  return { at, source: om ? 'EXIF' : 'EXIF_ASSUMED_KST' };
}

function utf8Text(b: Buffer): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(b);
    return s.includes('\0') ? null : s;
  } catch {
    return null;
  }
}

/** 종류별 크기·형식·내용을 검사한다. 읽을 수 없는 파일은 AttachmentError 로 거부(저장 전). */
export function validateUpload(kind: AttachmentKind, name: string, bytes: Buffer, now: Date): Validated {
  if (bytes.length === 0) throw new AttachmentError('EMPTY_FILE', '빈 파일');
  const limit = kind === 'PHOTO' ? LIMITS.photoBytes : kind === 'MARKDOWN' ? LIMITS.markdownBytes : LIMITS.noteBytes;
  if (bytes.length > limit) throw new AttachmentError('TOO_LARGE', `크기 제한 ${limit} 바이트 초과`);
  const base = { size: bytes.length, checksum: sha256(bytes), capturedAt: null, capturedSource: null };
  if (kind === 'PHOTO') {
    const unreadable = () => new AttachmentError('UNREADABLE_FILE', '읽을 수 없는 사진');
    const sig = [
      { ok: bytes[0] === 0xff && bytes[1] === 0xd8, mime: 'image/jpeg', ext: 'jpg', check: checkJpeg },
      { ok: bytes[0] === 0x89 && bytes[1] === 0x50, mime: 'image/png', ext: 'png', check: checkPng },
      { ok: bytes.toString('latin1', 0, 3) === 'GIF', mime: 'image/gif', ext: 'gif', check: checkGif },
      { ok: bytes.toString('latin1', 0, 4) === 'RIFF', mime: 'image/webp', ext: 'webp', check: checkWebp },
    ].find((s) => s.ok);
    if (!sig) throw new AttachmentError('UNSUPPORTED_TYPE', '지원하지 않는 사진 형식 (JPEG·PNG·GIF·WebP)');
    if (!sig.check(bytes)) throw unreadable();
    const cap = sig.ext === 'jpg' ? extractCaptureTime(bytes, now) : null;
    return { ...base, kind, mime: sig.mime, ext: sig.ext, capturedAt: cap?.at ?? null, capturedSource: cap?.source ?? null };
  }
  if (kind === 'MARKDOWN' && !/\.(md|markdown)$/i.test(name)) throw new AttachmentError('UNSUPPORTED_TYPE', 'Markdown(.md/.markdown) 파일만 가능');
  const text = utf8Text(bytes);
  if (text === null) throw new AttachmentError('UNREADABLE_FILE', 'UTF-8 텍스트가 아님');
  if (text.trim() === '') throw new AttachmentError('EMPTY_FILE', '내용이 없음');
  return { ...base, kind, mime: 'text/markdown', ext: 'md' };
}
