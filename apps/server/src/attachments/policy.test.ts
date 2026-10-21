import { describe, expect, it } from 'vitest';
import { makeJpeg, makePng } from './fixtures.testutil.js';
import { AttachmentError, LIMITS, validateUpload } from './policy.js';

const now = new Date('2026-10-21T10:00:00+09:00');
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return (e as AttachmentError).code; }
  return null;
};

describe('사진 검사 (D12-02, AC-2)', () => {
  it('정상 JPEG·PNG 허용', () => {
    expect(validateUpload('PHOTO', 'a.jpg', makeJpeg(), now).mime).toBe('image/jpeg');
    expect(validateUpload('PHOTO', 'a.png', makePng(), now).mime).toBe('image/png');
  });
  it('손상 파일은 거부: 잘린 JPEG·PNG, 헤더만 있는 파일, CRC 깨진 PNG', () => {
    const j = makeJpeg();
    expect(code(() => validateUpload('PHOTO', 'a.jpg', j.subarray(0, j.length - 6), now))).toBe('UNREADABLE_FILE');
    expect(code(() => validateUpload('PHOTO', 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), now))).toBe('UNREADABLE_FILE');
    const p = makePng();
    expect(code(() => validateUpload('PHOTO', 'a.png', p.subarray(0, p.length - 5), now))).toBe('UNREADABLE_FILE');
    const bad = Buffer.from(p);
    bad.writeUInt8(bad.readUInt8(bad.length - 20) ^ 0xff, bad.length - 20);
    expect(code(() => validateUpload('PHOTO', 'a.png', bad, now))).toBe('UNREADABLE_FILE');
    expect(code(() => validateUpload('PHOTO', 'a.webp', Buffer.from('RIFF\x10\0\0\0WEBPVP8 junkjunkjunk', 'latin1'), now))).toBe('UNREADABLE_FILE');
  });
  it('형식·크기·빈 파일 제한', () => {
    expect(code(() => validateUpload('PHOTO', 'a.jpg', Buffer.from('not an image at all'), now))).toBe('UNSUPPORTED_TYPE');
    expect(code(() => validateUpload('PHOTO', 'a.jpg', Buffer.alloc(0), now))).toBe('EMPTY_FILE');
    expect(code(() => validateUpload('PHOTO', 'a.jpg', Buffer.concat([makeJpeg(), Buffer.alloc(LIMITS.photoBytes)]), now))).toBe('TOO_LARGE');
  });
});

describe('촬영 시각 (AC-4 메타데이터 경계)', () => {
  it('EXIF 가 없으면 촬영 시각은 null (업로드 시각으로 채우지 않음)', () => {
    for (const buf of [makeJpeg(), makeJpeg({ exif: null }), makePng()]) {
      const v = validateUpload('PHOTO', 'x', buf, now);
      expect(v.capturedAt).toBeNull();
      expect(v.capturedSource).toBeNull();
    }
  });
  it('EXIF 촬영 시각 + OffsetTime 이 있으면 그 값을 사용', () => {
    const v = validateUpload('PHOTO', 'x.jpg', makeJpeg({ exif: '2026:10:20:18:30:00'.replace(/:(\d\d):(\d\d:\d\d)$/, ' $1:$2'), offset: '+09:00' }), now);
    expect(v.capturedAt?.toISOString()).toBe('2026-10-20T09:30:00.000Z');
    expect(v.capturedSource).toBe('EXIF');
  });
  it('OffsetTime 이 없으면 한국 시간 가정으로 출처를 구분해 표시', () => {
    const v = validateUpload('PHOTO', 'x.jpg', makeJpeg({ exif: '2026:10:20 18:30:00' }), now);
    expect(v.capturedAt?.toISOString()).toBe('2026-10-20T09:30:00.000Z');
    expect(v.capturedSource).toBe('EXIF_ASSUMED_KST');
  });
  it('잘못된 값(0000, 존재하지 않는 날짜, 미래, 형식 오류)은 촬영 시각 없음', () => {
    for (const s of ['0000:00:00 00:00:00', '2026:02:30 10:00:00', '2026:13:01 10:00:00', '2027:10:20 10:00:00', 'yesterday noon', '2026:10:20 25:00:00']) {
      expect(validateUpload('PHOTO', 'x.jpg', makeJpeg({ exif: s }), now).capturedAt, s).toBeNull();
    }
  });
});

describe('Markdown·메모 검사', () => {
  it('UTF-8 .md 허용, 확장자·인코딩·NUL·빈 내용 거부', () => {
    expect(validateUpload('MARKDOWN', 'a.md', Buffer.from('# 오늘 배운 것\n- TLS'), now).mime).toBe('text/markdown');
    expect(code(() => validateUpload('MARKDOWN', 'a.exe', Buffer.from('# x'), now))).toBe('UNSUPPORTED_TYPE');
    expect(code(() => validateUpload('MARKDOWN', 'a.md', Buffer.from([0xff, 0xfe, 0x41, 0x80]), now))).toBe('UNREADABLE_FILE');
    expect(code(() => validateUpload('MARKDOWN', 'a.md', Buffer.from('a\0b'), now))).toBe('UNREADABLE_FILE');
    expect(code(() => validateUpload('MARKDOWN', 'a.md', Buffer.from('  \n'), now))).toBe('EMPTY_FILE');
    expect(code(() => validateUpload('NOTE', 'n', Buffer.alloc(LIMITS.noteBytes + 1, 97), now))).toBe('TOO_LARGE');
  });
});
