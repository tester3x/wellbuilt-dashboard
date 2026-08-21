/**
 * Server-owned invoice photo attachment after finalize.
 * Built only from grant + Storage metadata. Never trusts client paths.
 */
export const PHOTO_ID_RE = /^ph_[A-Za-z0-9_-]{6,80}$/;

export function decidePhotoId(clientPhotoId?: string | null):
  | { ok: true; photoId: string; minted: boolean }
  | { ok: false; reason: string } {
  const raw = (clientPhotoId || '').trim();
  if (!raw) return { ok: true, photoId: '', minted: true };
  if (!PHOTO_ID_RE.test(raw)) return { ok: false, reason: 'invalid_photo_id' };
  return { ok: true, photoId: raw, minted: false };
}

export interface CanonicalInvoicePhoto {
  photoId: string;
  bucket: string;
  path: string;
  generation: string | number | null;
  companyId: string;
  driverId: string;
  invoiceId: string;
  kind: string;
  contentType?: string | null;
  size?: string | number | null;
}

export function buildCanonicalInvoicePhoto(input: {
  photoId: string;
  bucket: string;
  path: string;
  generation?: string | number | null;
  companyId: string;
  driverId: string;
  invoiceId: string;
  kind?: string;
  contentType?: string | null;
  size?: string | number | null;
}): CanonicalInvoicePhoto {
  return {
    photoId: input.photoId,
    bucket: input.bucket,
    path: input.path,
    generation: input.generation ?? null,
    companyId: input.companyId,
    driverId: input.driverId,
    invoiceId: input.invoiceId,
    kind: input.kind || 'ticket_photo',
    contentType: input.contentType ?? null,
    size: input.size ?? null,
  };
}

export function attachPhotoToInvoicePhotos(
  existing: unknown,
  photo: CanonicalInvoicePhoto,
): { photos: CanonicalInvoicePhoto[]; duplicate: boolean } {
  const list = Array.isArray(existing) ? [...existing] : [];
  const idx = list.findIndex((p) => p && typeof p === 'object' && (p as { photoId?: string }).photoId === photo.photoId);
  if (idx >= 0) {
    const prev = list[idx] as Record<string, unknown>;
    if (prev.path === photo.path && prev.bucket === photo.bucket) {
      list[idx] = { ...prev, ...photo };
      return { photos: list as CanonicalInvoicePhoto[], duplicate: true };
    }
    list[idx] = { ...prev, ...photo };
    return { photos: list as CanonicalInvoicePhoto[], duplicate: true };
  }
  list.push(photo);
  return { photos: list as CanonicalInvoicePhoto[], duplicate: false };
}

export function decideInvoicePhotoAllowlist(input: {
  clientPhotos?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  if (input.clientPhotos !== undefined) {
    return { ok: false, reason: 'photos_not_client_writable' };
  }
  return { ok: true };
}
