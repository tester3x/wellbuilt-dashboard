/**
 * Invoice photo display. Durable metadata is bucket/path.
 * Signed read URLs are short-lived and must keep their query string.
 * Never rewrite Firebase URLs in a way that strips authorization.
 */
export interface PhotoRef {
  bucket?: string | null;
  path?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  url?: string | null;
  uri?: string | null;
  remoteUrl?: string | null;
}

export function preserveAuthorizedPhotoUrl(url: string): string {
  if (!url) return url;
  // Keep signed/token query strings intact. Do not rewrite
  // firebasestorage.googleapis.com → storage.googleapis.com.
  return url;
}

export function photoDisplayRef(photo: PhotoRef | string | null | undefined): {
  kind: 'signed_or_absolute';
  url: string;
} | {
  kind: 'canonical';
  bucket: string;
  path: string;
} | {
  kind: 'none';
} {
  if (!photo) return { kind: 'none' };
  if (typeof photo === 'string') {
    const url = preserveAuthorizedPhotoUrl(photo);
    return url ? { kind: 'signed_or_absolute', url } : { kind: 'none' };
  }
  const bucket = photo.bucket || photo.storageBucket;
  const path = photo.path || photo.storagePath;
  if (bucket && path) {
    return { kind: 'canonical', bucket, path };
  }
  const raw = photo.url || photo.remoteUrl || photo.uri || '';
  const url = preserveAuthorizedPhotoUrl(raw);
  if (!url) return { kind: 'none' };
  return { kind: 'signed_or_absolute', url };
}
