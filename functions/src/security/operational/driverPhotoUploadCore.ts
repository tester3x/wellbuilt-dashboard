/**
 * Governed driver photo upload authorization — Dashboard copy of the WB-T
 * pure core. Server selects the Storage path. Same photoId maps to the
 * same object (retry without duplication).
 */

export const DRIVER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
export const DRIVER_PHOTO_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export type PhotoUploadCaller = {
  uid: string;
  driverId: string | null;
  companyId: string | null;
  isPlatformAdmin: boolean;
};

export type PhotoUploadRequest = {
  photoId?: unknown;
  invoiceDocId?: unknown;
  contentType?: unknown;
  byteSize?: unknown;
  companyId?: unknown;
  contentMd5?: unknown;
};

export type InvoicePhotoOwnerRecord = {
  companyId?: string | null;
  driverId?: string | null;
  driverHash?: string | null;
  ownerDriverId?: string | null;
};

export type TicketPhotoOwnerRecord = {
  companyId?: string | null;
  ownerDriverId?: string | null;
  invoiceDocId?: string | null;
};

export type PhotoUploadDecision =
  | {
      ok: true;
      storagePath: string;
      contentType: string;
      byteSize: number;
      photoId: string;
      invoiceDocId: string;
      companyId: string;
    }
  | { ok: false; error: string };

export function exactId(raw: unknown, min = 3): string | null {
  const s = String(raw || '').trim();
  if (!new RegExp(`^[A-Za-z0-9._-]{${min},80}$`).test(s)) return null;
  return s;
}

function sanitizeSegment(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);
}

function driverOwnsRecord(
  caller: PhotoUploadCaller,
  rec: { companyId?: string | null; driverId?: string | null; driverHash?: string | null; ownerDriverId?: string | null },
): boolean {
  if (!caller.companyId || rec.companyId !== caller.companyId) return false;
  if (caller.isPlatformAdmin) return true;
  const owner = String(rec.ownerDriverId || rec.driverId || rec.driverHash || '').trim();
  return !!caller.driverId && owner === caller.driverId;
}

export function authorizePhotoTargetOwner(input: {
  caller: PhotoUploadCaller;
  invoiceDocId: string;
  invoice: InvoicePhotoOwnerRecord | null;
  tickets: TicketPhotoOwnerRecord[];
}): { ok: true } | { ok: false; error: string } {
  const { caller, invoiceDocId, invoice, tickets } = input;
  if (invoice) {
    if (!driverOwnsRecord(caller, invoice)) return { ok: false, error: 'invoice_not_owned' };
    return { ok: true };
  }
  const ownedTicket = tickets.some(
    (t) =>
      String(t.invoiceDocId || '') === invoiceDocId &&
      driverOwnsRecord(caller, t),
  );
  if (ownedTicket) return { ok: true };
  return { ok: false, error: 'invoice_not_owned' };
}

export function stableGovernedPhotoPath(
  companyId: string,
  invoiceDocId: string,
  photoId: string,
): string {
  return `photos/${sanitizeSegment(companyId)}/${sanitizeSegment(invoiceDocId)}/${sanitizeSegment(photoId)}.jpg`;
}

export function normalizePhotoContentType(raw: unknown): string | null {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!t || t === 'application/octet-stream') return 'image/jpeg';
  if (t === 'image/jpg') return 'image/jpeg';
  return DRIVER_PHOTO_ALLOWED_MIME.has(t) ? t : null;
}

export function authorizeDriverPhotoUpload(input: {
  caller: PhotoUploadCaller;
  request: PhotoUploadRequest;
}): PhotoUploadDecision {
  const { caller, request } = input;
  if (!caller.uid) return { ok: false, error: 'unauthenticated' };
  if (!caller.isPlatformAdmin && !caller.driverId) return { ok: false, error: 'driver_auth_required' };

  const companyId = String(caller.companyId || '').trim();
  if (!companyId) return { ok: false, error: 'company_required' };
  const claimedCompany = typeof request.companyId === 'string' ? request.companyId.trim() : '';
  if (claimedCompany && claimedCompany !== companyId && !caller.isPlatformAdmin) {
    return { ok: false, error: 'company_mismatch' };
  }

  const photoId = exactId(request.photoId, 3);
  if (!photoId) return { ok: false, error: 'photoId_required' };

  const invoiceDocId = exactId(request.invoiceDocId, 8);
  if (!invoiceDocId) return { ok: false, error: 'invoiceDocId_required' };

  const contentType = normalizePhotoContentType(request.contentType);
  if (!contentType) return { ok: false, error: 'mime_not_allowed' };

  const byteSize = typeof request.byteSize === 'number' ? request.byteSize : Number(request.byteSize);
  if (!Number.isFinite(byteSize) || byteSize <= 0) return { ok: false, error: 'byteSize_required' };
  if (byteSize > DRIVER_PHOTO_MAX_BYTES) return { ok: false, error: 'byteSize_exceeds_limit' };

  return {
    ok: true,
    storagePath: stableGovernedPhotoPath(companyId, invoiceDocId, photoId),
    contentType,
    byteSize,
    photoId,
    invoiceDocId,
    companyId,
  };
}

export function uploadedObjectWithinLimit(actualBytes: number, maxBytes: number = DRIVER_PHOTO_MAX_BYTES): boolean {
  return Number.isFinite(actualBytes) && actualBytes > 0 && actualBytes <= maxBytes;
}

export function decidePhotoUploadIdempotency(input: {
  objectExists: boolean;
  existingSize?: number | null;
  existingMd5?: string | null;
  requestedSize: number;
  requestedMd5?: string | null;
}): 'reuse' | 'issue-upload' | 'conflict' {
  if (!input.objectExists) return 'issue-upload';
  const existingMd5 = input.existingMd5 ? String(input.existingMd5) : '';
  const requestedMd5 = input.requestedMd5 ? String(input.requestedMd5) : '';
  if (existingMd5 && requestedMd5 && existingMd5 !== requestedMd5) return 'conflict';
  if (
    typeof input.existingSize === 'number' &&
    Number.isFinite(input.existingSize) &&
    input.existingSize !== input.requestedSize
  ) {
    return 'conflict';
  }
  return 'reuse';
}

export function durablePhotoReference(input: {
  bucket: string;
  storagePath: string;
}): { storagePath: string; gsUri: string } {
  return {
    storagePath: input.storagePath,
    gsUri: `gs://${input.bucket}/${input.storagePath}`,
  };
}
