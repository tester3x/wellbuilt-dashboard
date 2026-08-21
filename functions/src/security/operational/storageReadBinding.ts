/**
 * Server-owned binding between a Storage object and its resource.
 *
 * Callers may name an invoice/photo/grant. They may not supply a free-form
 * path that is then signed after an unrelated invoice authorization.
 */
export const PHOTO_OBJECT_PREFIXES = ['photos/'] as const;

export interface BoundPhotoObject {
  bucket: string;
  path: string;
  generation?: string | number | null;
  companyId: string;
  driverId: string;
  invoiceId: string | null;
  photoId: string | null;
  grantId: string | null;
  kind: string;
}

export interface InvoicePhotoRecord {
  photoId?: unknown;
  bucket?: unknown;
  path?: unknown;
  storagePath?: unknown;
  storageBucket?: unknown;
  generation?: unknown;
  storageGeneration?: unknown;
  uri?: unknown;
}

export interface InvoiceRecord {
  companyId?: unknown;
  driverId?: unknown;
  photos?: unknown;
}

export interface StorageGrantRecord {
  path?: unknown;
  bucket?: unknown;
  companyId?: unknown;
  driverId?: unknown;
  kind?: unknown;
  storedGeneration?: unknown;
  used?: unknown;
}

export function isAllowedPhotoPath(path: string): boolean {
  const p = path.replace(/^\/+/, '');
  if (!p || p.includes('..') || p.includes('\\')) return false;
  return PHOTO_OBJECT_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function photosFromInvoice(invoice: InvoiceRecord | null | undefined): InvoicePhotoRecord[] {
  const raw = invoice?.photos;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is InvoicePhotoRecord => !!p && typeof p === 'object');
}

export function photoObjectPath(photo: InvoicePhotoRecord): string {
  const path = typeof photo.path === 'string' && photo.path
    ? photo.path
    : typeof photo.storagePath === 'string' ? photo.storagePath : '';
  return path.replace(/^\/+/, '');
}

export function photoObjectBucket(photo: InvoicePhotoRecord): string {
  if (typeof photo.bucket === 'string' && photo.bucket) return photo.bucket;
  if (typeof photo.storageBucket === 'string') return photo.storageBucket;
  return '';
}

export function findBoundInvoicePhoto(input: {
  invoice: InvoiceRecord;
  invoiceId: string;
  liveBucket: string;
  photoId?: string | null;
  claimedPath?: string | null;
}): { ok: true; bound: BoundPhotoObject } | { ok: false; reason: string } {
  const companyId = typeof input.invoice.companyId === 'string' ? input.invoice.companyId.trim() : '';
  const driverId = typeof input.invoice.driverId === 'string' ? input.invoice.driverId.trim() : '';
  if (!companyId || !driverId) return { ok: false, reason: 'invoice_unbound' };
  const photos = photosFromInvoice(input.invoice);
  let match: InvoicePhotoRecord | undefined;
  if (input.photoId) {
    match = photos.find((p) => typeof p.photoId === 'string' && p.photoId === input.photoId);
  } else if (input.claimedPath) {
    const claimed = input.claimedPath.replace(/^\/+/, '');
    match = photos.find((p) => photoObjectPath(p) === claimed);
  }
  if (!match) return { ok: false, reason: 'photo_not_bound_to_invoice' };
  const path = photoObjectPath(match);
  if (!isAllowedPhotoPath(path)) return { ok: false, reason: 'non_photo_prefix' };
  const bucket = photoObjectBucket(match) || input.liveBucket;
  if (bucket !== input.liveBucket) return { ok: false, reason: 'bucket_mismatch' };
  if (input.claimedPath && input.claimedPath.replace(/^\/+/, '') !== path) {
    return { ok: false, reason: 'path_not_bound' };
  }
  const generation = match.generation ?? match.storageGeneration ?? null;
  return {
    ok: true,
    bound: {
      bucket,
      path,
      generation: generation as string | number | null,
      companyId,
      driverId,
      invoiceId: input.invoiceId,
      photoId: typeof match.photoId === 'string' ? match.photoId : null,
      grantId: null,
      kind: 'ticket_photo',
    },
  };
}

export function bindGrantToObject(input: {
  grant: StorageGrantRecord;
  grantId: string;
  liveBucket: string;
  claimedPath?: string | null;
}): { ok: true; bound: BoundPhotoObject } | { ok: false; reason: string } {
  const path = typeof input.grant.path === 'string' ? input.grant.path.replace(/^\/+/, '') : '';
  if (!isAllowedPhotoPath(path)) return { ok: false, reason: 'non_photo_prefix' };
  const bucket = typeof input.grant.bucket === 'string' && input.grant.bucket
    ? input.grant.bucket
    : input.liveBucket;
  if (bucket !== input.liveBucket) return { ok: false, reason: 'bucket_mismatch' };
  if (input.claimedPath && input.claimedPath.replace(/^\/+/, '') !== path) {
    return { ok: false, reason: 'path_not_bound' };
  }
  const companyId = typeof input.grant.companyId === 'string' ? input.grant.companyId.trim() : '';
  const driverId = typeof input.grant.driverId === 'string' ? input.grant.driverId.trim() : '';
  if (!companyId || !driverId) return { ok: false, reason: 'grant_unbound' };
  const kind = typeof input.grant.kind === 'string' ? input.grant.kind : 'ticket_photo';
  if (kind !== 'ticket_photo') return { ok: false, reason: 'non_photo_kind' };
  return {
    ok: true,
    bound: {
      bucket,
      path,
      generation: (input.grant.storedGeneration as string | number | null) ?? null,
      companyId,
      driverId,
      invoiceId: null,
      photoId: null,
      grantId: input.grantId,
      kind,
    },
  };
}

export function decideBoundPhotoRead(input: {
  bound: BoundPhotoObject;
  liveBucket: string;
  claimedBucket?: string | null;
  claimedPath?: string | null;
  claimedGeneration?: string | number | null;
  callerClass: 'driver' | 'staff' | 'platform' | 'other';
  callerDriverId?: string | null;
  callerCompanyId?: string | null;
  staffHasViewTickets?: boolean;
  platformDualGated?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.bound.bucket !== input.liveBucket) return { ok: false, reason: 'bucket_mismatch' };
  if (input.claimedBucket && input.claimedBucket !== input.bound.bucket) {
    return { ok: false, reason: 'bucket_mismatch' };
  }
  if (input.claimedPath && input.claimedPath.replace(/^\/+/, '') !== input.bound.path) {
    return { ok: false, reason: 'path_not_bound' };
  }
  if (
    input.claimedGeneration != null
    && input.bound.generation != null
    && String(input.claimedGeneration) !== String(input.bound.generation)
  ) {
    return { ok: false, reason: 'generation_mismatch' };
  }
  if (!isAllowedPhotoPath(input.bound.path)) return { ok: false, reason: 'non_photo_prefix' };
  if (input.callerClass === 'platform') {
    return input.platformDualGated ? { ok: true } : { ok: false, reason: 'platform_dual_gate' };
  }
  if (input.callerClass === 'driver') {
    if (input.callerDriverId && input.callerDriverId === input.bound.driverId
      && input.callerCompanyId && input.callerCompanyId === input.bound.companyId) {
      return { ok: true };
    }
    return { ok: false, reason: 'not_owner' };
  }
  if (input.callerClass === 'staff') {
    if (!input.staffHasViewTickets) return { ok: false, reason: 'missing_viewTickets' };
    if (!input.callerCompanyId || input.callerCompanyId !== input.bound.companyId) {
      return { ok: false, reason: 'cross_company' };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'not_authorized' };
}

export interface IssueReadDeps {
  liveBucket(): string;
  getInvoice(id: string): Promise<InvoiceRecord | null>;
  getGrant(id: string): Promise<StorageGrantRecord | null>;
  signRead(path: string, expiresAt: number): Promise<string>;
}

export async function runIssueStorageReadUrl(
  data: {
    invoiceId?: string;
    photoId?: string;
    grantId?: string;
    path?: string;
    bucket?: string;
    generation?: string | number | null;
  },
  caller: {
    class: 'driver' | 'staff' | 'platform';
    driverId?: string | null;
    companyId?: string | null;
    staffHasViewTickets?: boolean;
    platformDualGated?: boolean;
  },
  deps: IssueReadDeps,
): Promise<
  | { ok: true; bucket: string; path: string; generation: string | number | null; expiresAt: number; readUrl: string }
  | { ok: false; reason: string; http: 'invalid-argument' | 'not-found' | 'permission-denied' | 'failed-precondition' }
> {
  const liveBucket = deps.liveBucket();
  const claimedPath = data.path ? String(data.path).replace(/^\/+/, '') : null;
  let bound: BoundPhotoObject | null = null;

  if (data.grantId) {
    const grant = await deps.getGrant(String(data.grantId));
    if (!grant) return { ok: false, reason: 'grant', http: 'not-found' };
    const g = bindGrantToObject({
      grant,
      grantId: String(data.grantId),
      liveBucket,
      claimedPath,
    });
    if (!g.ok) return { ok: false, reason: g.reason, http: 'permission-denied' };
    bound = g.bound;
  }

  if (data.invoiceId) {
    const invoice = await deps.getInvoice(String(data.invoiceId));
    if (!invoice) return { ok: false, reason: 'invoice', http: 'not-found' };
    const i = findBoundInvoicePhoto({
      invoice,
      invoiceId: String(data.invoiceId),
      liveBucket,
      photoId: data.photoId || null,
      claimedPath,
    });
    if (!i.ok) return { ok: false, reason: i.reason, http: 'permission-denied' };
    if (bound && bound.path !== i.bound.path) {
      return { ok: false, reason: 'binding_conflict', http: 'permission-denied' };
    }
    bound = i.bound;
  }

  if (!bound) {
    return { ok: false, reason: 'binding_required', http: 'invalid-argument' };
  }

  const access = decideBoundPhotoRead({
    bound,
    liveBucket,
    claimedBucket: data.bucket || null,
    claimedPath,
    claimedGeneration: data.generation ?? null,
    callerClass: caller.class,
    callerDriverId: caller.driverId,
    callerCompanyId: caller.companyId,
    staffHasViewTickets: caller.staffHasViewTickets,
    platformDualGated: caller.platformDualGated,
  });
  if (!access.ok) return { ok: false, reason: access.reason, http: 'permission-denied' };

  const expiresAt = Date.now() + 5 * 60 * 1000;
  try {
    const readUrl = await deps.signRead(bound.path, expiresAt);
    return {
      ok: true,
      bucket: bound.bucket,
      path: bound.path,
      generation: bound.generation ?? null,
      expiresAt,
      readUrl,
    };
  } catch {
    return { ok: false, reason: 'signed_url_unavailable_nonprod_or_emulator', http: 'failed-precondition' };
  }
}
