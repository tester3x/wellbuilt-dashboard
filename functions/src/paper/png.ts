import { deflateSync, inflateSync } from 'zlib';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePngRgb(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodePngRgb(buf: Buffer): { width: number; height: number; rgb: Buffer } {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not_png');
  }
  let width = 0;
  let height = 0;
  let colorType = 2;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported_png');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  if (!width || !height) throw new Error('bad_png_header');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = Buffer.alloc(width * height * 3);
  const rowLen = width * bpp + 1;
  const recon = Buffer.alloc(height * width * bpp);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * rowLen];
    for (let i = 0; i < width * bpp; i++) {
      const x = raw[y * rowLen + 1 + i];
      const a = i >= bpp ? recon[y * width * bpp + i - bpp] : 0;
      const b = y > 0 ? recon[(y - 1) * width * bpp + i] : 0;
      const c = y > 0 && i >= bpp ? recon[(y - 1) * width * bpp + i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 255;
      else if (filter === 2) val = (x + b) & 255;
      else if (filter === 3) val = (x + Math.floor((a + b) / 2)) & 255;
      else if (filter === 4) val = (x + paeth(a, b, c)) & 255;
      else if (filter !== 0) throw new Error('unsupported_png_filter');
      recon[y * width * bpp + i] = val;
    }
    for (let x = 0; x < width; x++) {
      const si = y * width * bpp + x * bpp;
      const di = (y * width + x) * 3;
      rgb[di] = recon[si];
      rgb[di + 1] = recon[si + 1];
      rgb[di + 2] = recon[si + 2];
    }
  }
  return { width, height, rgb };
}

export function downscaleRgb(
  width: number,
  height: number,
  rgb: Buffer,
  maxEdge: number,
): { width: number; height: number; rgb: Buffer } {
  const edge = Math.max(width, height);
  const scale = edge <= maxEdge ? 1 : maxEdge / edge;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { width, height, rgb };
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y * height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x * width / w));
      const si = (sy * width + sx) * 3;
      const di = (y * w + x) * 3;
      out[di] = rgb[si];
      out[di + 1] = rgb[si + 1];
      out[di + 2] = rgb[si + 2];
    }
  }
  return { width: w, height: h, rgb: out };
}

export function detectMagicMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'application/pdf' | 'unknown' {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return 'unknown';
}
