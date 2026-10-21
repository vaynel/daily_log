import { crc32 } from 'node:zlib';
import { deflateSync } from 'node:zlib';

/** EXIF(APP1) 바이트. dto 가 없으면 날짜 태그 없이 만든다. */
function exifSegment(dto: string | null, offset?: string): Buffer {
  const entries: { tag: number; type: number; count: number; data: Buffer }[] = [];
  if (dto !== null) entries.push({ tag: 0x9003, type: 2, count: dto.length + 1, data: Buffer.from(`${dto}\0`, 'latin1') });
  if (offset) entries.push({ tag: 0x9011, type: 2, count: offset.length + 1, data: Buffer.from(`${offset}\0`, 'latin1') });
  const ifd0Len = 2 + 12 + 4;
  const exifIfdOff = 8 + ifd0Len;
  const exifIfdLen = 2 + entries.length * 12 + 4;
  let dataOff = exifIfdOff + exifIfdLen;
  const tiff = Buffer.alloc(dataOff);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(exifIfdOff, 18);
  tiff.writeUInt32BE(0, 22);
  tiff.writeUInt16BE(entries.length, exifIfdOff);
  const blobs: Buffer[] = [];
  entries.forEach((e, i) => {
    const o = exifIfdOff + 2 + i * 12;
    tiff.writeUInt16BE(e.tag, o);
    tiff.writeUInt16BE(e.type, o + 2);
    tiff.writeUInt32BE(e.count, o + 4);
    tiff.writeUInt32BE(dataOff, o + 8);
    blobs.push(e.data);
    dataOff += e.data.length;
  });
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, ...blobs]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** 읽을 수 있는 최소 JPEG. exif: undefined=EXIF 없음, null=EXIF 있으나 촬영 시각 없음. salt 로 내용을 달리한다. */
export function makeJpeg(opts: { exif?: string | null; offset?: string; salt?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (opts.exif !== undefined) parts.push(exifSegment(opts.exif, opts.offset));
  parts.push(Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 4, 0, 4, 1, 1, 0x11, 0]));
  parts.push(Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, opts.salt ?? 0, 0x55, 0xaa, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

export function makePng(salt = 0): Buffer {
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, salt & 255, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
