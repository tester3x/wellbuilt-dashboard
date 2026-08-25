import { asTrimmedString } from './format';
import { hashExactBytes } from './hash';
import type { LivePhotoRef, PaperPhoto } from './types';

const TYPE_RANK: Record<string, number> = {
  pickup: 0,
  dropoff: 1,
  jsa: 9,
};

export function splitLivePhotos(raw: unknown): { photos: LivePhotoRef[]; jsaUri: string } {
  const list = Array.isArray(raw) ? raw : [];
  const photos: LivePhotoRef[] = [];
  let jsaUri = '';
  for (const item of list) {
    if (typeof item === 'string') {
      const uri = item.trim();
      if (uri) photos.push({ uri, location: '', type: '', takenAt: '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const uri = asTrimmedString(rec.uri);
    const type = asTrimmedString(rec.type).toLowerCase();
    if (type === 'jsa') {
      if (uri && !jsaUri) jsaUri = uri;
      continue;
    }
    if (!uri) continue;
    photos.push({
      uri,
      location: asTrimmedString(rec.location),
      type,
      takenAt: asTrimmedString(rec.takenAt),
    });
  }
  photos.sort((a, b) => {
    const ta = a.takenAt || '';
    const tb = b.takenAt || '';
    if (ta !== tb) return ta.localeCompare(tb);
    const ra = TYPE_RANK[a.type] ?? 5;
    const rb = TYPE_RANK[b.type] ?? 5;
    if (ra !== rb) return ra - rb;
    return a.uri.localeCompare(b.uri);
  });
  return { photos, jsaUri };
}

export function snapshotPhotoBytes(bytes: Buffer, meta: LivePhotoRef): PaperPhoto {
  const contentHash = hashExactBytes(bytes);
  const mime = meta.uri.toLowerCase().endsWith('.png') ? 'image/png'
    : meta.uri.toLowerCase().endsWith('.webp') ? 'image/webp'
      : 'image/jpeg';
  return {
    contentHash,
    dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
    location: meta.location,
    type: meta.type,
    takenAt: meta.takenAt,
  };
}
