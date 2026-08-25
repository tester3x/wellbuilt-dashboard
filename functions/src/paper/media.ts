import { hashExactBytes } from './hash';
import { decodePngRgb, detectMagicMime, downscaleRgb, encodePngRgb } from './png';
import type { LivePhotoRef, PaperPhotoMeta } from './types';

export const MAX_PAPER_PHOTOS = 8;
export const MAX_SOURCE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_THUMB_EDGE = 480;
export const MAX_THUMB_BYTES = 48 * 1024;
export const MAX_CANONICAL_HTML_BYTES = 512 * 1024;

export function assertSourceSize(bytes: Buffer): { ok: true } | { ok: false; reason: string; message: string } {
  if (bytes.length > MAX_SOURCE_ASSET_BYTES) {
    return { ok: false, reason: 'asset_too_large', message: 'Source asset exceeds 8MB.' };
  }
  return { ok: true };
}

export function createBoundedThumbnail(source: Buffer): {
  thumb: Buffer;
  mimeType: string;
  width: number;
  height: number;
} {
  const mime = detectMagicMime(source);
  let width: number;
  let height: number;
  let rgb: Buffer;
  if (mime === 'image/png') {
    const decoded = decodePngRgb(source);
    width = decoded.width;
    height = decoded.height;
    rgb = decoded.rgb;
  } else if (mime === 'image/jpeg') {
    // jpeg-js is optional at compile time; loaded only for JPEG sources.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jpeg = require('jpeg-js') as { decode: (b: Buffer, o?: object) => { width: number; height: number; data: Buffer } };
    const decoded = jpeg.decode(source, { maxMemoryUsageInMB: 64 });
    width = decoded.width;
    height = decoded.height;
    rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
      rgb[i * 3] = decoded.data[p];
      rgb[i * 3 + 1] = decoded.data[p + 1];
      rgb[i * 3 + 2] = decoded.data[p + 2];
    }
  } else {
    throw new Error('unsupported_image');
  }
  const scaled = downscaleRgb(width, height, rgb, MAX_THUMB_EDGE);
  let qualityEdge = MAX_THUMB_EDGE;
  let thumb = encodePngRgb(scaled.width, scaled.height, scaled.rgb);
  while (thumb.length > MAX_THUMB_BYTES && qualityEdge > 96) {
    qualityEdge = Math.floor(qualityEdge * 0.75);
    const again = downscaleRgb(width, height, rgb, qualityEdge);
    thumb = encodePngRgb(again.width, again.height, again.rgb);
  }
  if (thumb.length > MAX_THUMB_BYTES) throw new Error('thumbnail_too_large');
  const final = decodePngRgb(thumb);
  return { thumb, mimeType: 'image/png', width: final.width, height: final.height };
}

export function snapshotPhotoForPaper(
  original: Buffer,
  meta: LivePhotoRef,
  paths: { originalPath: string; thumbPath: string },
): { meta: PaperPhotoMeta; thumb: Buffer; original: Buffer } {
  const sized = assertSourceSize(original);
  if (!sized.ok) throw new Error(sized.reason);
  const sourceMime = detectMagicMime(original);
  if (sourceMime === 'unknown') throw new Error('unsupported_image');
  const thumb = createBoundedThumbnail(original);
  return {
    original,
    thumb: thumb.thumb,
    meta: {
      contentHash: hashExactBytes(original),
      thumbHash: hashExactBytes(thumb.thumb),
      originalPath: paths.originalPath,
      thumbPath: paths.thumbPath,
      mimeType: sourceMime,
      thumbMimeType: thumb.mimeType,
      width: thumb.width,
      height: thumb.height,
      location: meta.location,
      type: meta.type,
      takenAt: meta.takenAt,
    },
  };
}

export function thumbDataUri(thumb: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${thumb.toString('base64')}`;
}

/** Deterministic large-ish PNG (gradient + sparse noise) for fixture tests. */
export function makeLargePhonePhotoFixture(seed: number, width = 1600, height = 1200): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const n = ((x * 73 + y * 149 + seed * 19) % 251);
      rgb[i] = (x * 255 / width + (n % 17)) & 255;
      rgb[i + 1] = (y * 255 / height) & 255;
      rgb[i + 2] = ((x + y + seed) * 13) & 255;
    }
  }
  return encodePngRgb(width, height, rgb);
}
