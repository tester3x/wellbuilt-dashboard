/**
 * Dashboard Photo Review V1 — pure evaluator.
 *
 * Company-scoped office review of Dispatch invoice photos. Never mutates
 * the original photo, completed job, invoice, or PDF. Review state lives
 * in a sidecar document; missing sidecar = Unreviewed.
 */

export const PHOTO_REVIEW_STATUSES = ['unreviewed', 'approved', 'rejected', 'addressed'] as const;
export type PhotoReviewStatus = (typeof PHOTO_REVIEW_STATUSES)[number];

export const PHOTO_REVIEW_ACTIONS = ['approve', 'reject', 'address'] as const;
export type PhotoReviewAction = (typeof PHOTO_REVIEW_ACTIONS)[number];

export const PHOTO_REVIEW_VIEW_ROLES = [
  'it', 'admin', 'manager', 'dispatch', 'safety', 'lead', 'viewer',
] as const;
export const PHOTO_REVIEW_MUTATE_ROLES = [
  'it', 'admin', 'manager', 'dispatch', 'safety', 'lead',
] as const;

export type PhotoReviewCaller = {
  uid: string;
  roles: string[];
  companyId?: string | null;
  isPlatformAdmin: boolean;
  email?: string | null;
  displayName?: string | null;
};

export type PhotoReviewRecord = {
  companyId: string;
  invoiceId: string;
  photoId: string;
  status: PhotoReviewStatus;
  rejectReason?: string;
  supervisorNote?: string;
  addressedNote?: string;
  reviewedByUid?: string;
  reviewedByLabel?: string;
  reviewedAtMs?: number;
  addressedByUid?: string;
  addressedByLabel?: string;
  addressedAtMs?: number;
};

export type InvoicePhotoSource = {
  id: string;
  companyId?: unknown;
  driverId?: unknown;
  driverName?: unknown;
  driver?: unknown;
  invoiceNumber?: unknown;
  ticketNumber?: unknown;
  wellName?: unknown;
  pickupName?: unknown;
  disposal?: unknown;
  disposalName?: unknown;
  dropoffName?: unknown;
  createdAtMs?: number | null;
  closedAtMs?: number | null;
  photos?: unknown;
};

export type ReviewListFilters = {
  companyId?: unknown;
  dateFromMs?: unknown;
  dateToMs?: unknown;
  driver?: unknown;
  ticketOrJob?: unknown;
  pickup?: unknown;
  dropoff?: unknown;
  photoType?: unknown;
  reviewStatus?: unknown;
  limit?: unknown;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function rolesOf(caller: PhotoReviewCaller | null | undefined): string[] {
  return Array.isArray(caller?.roles)
    ? caller!.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
}

export function callerCanViewPhotoReview(caller: PhotoReviewCaller | null | undefined): boolean {
  if (!caller?.uid) return false;
  return rolesOf(caller).some((r) => (PHOTO_REVIEW_VIEW_ROLES as readonly string[]).includes(r));
}

export function callerCanMutatePhotoReview(caller: PhotoReviewCaller | null | undefined): boolean {
  if (!caller?.uid) return false;
  return rolesOf(caller).some((r) => (PHOTO_REVIEW_MUTATE_ROLES as readonly string[]).includes(r));
}

/**
 * Company tenancy: the requested companyId must match the caller's company.
 * Platform admins still must name a company — no cross-company listing.
 */
export function resolvePhotoReviewCompany(
  caller: PhotoReviewCaller | null | undefined,
  requestedCompanyId: unknown,
): { ok: true; companyId: string } | { ok: false; reason: string } {
  if (!caller?.uid) return { ok: false, reason: 'unauthenticated' };
  if (!callerCanViewPhotoReview(caller)) return { ok: false, reason: 'role_denied' };
  const requested = str(requestedCompanyId);
  const bound = str(caller.companyId);
  if (bound) {
    if (requested && requested !== bound) return { ok: false, reason: 'wrong_company' };
    return { ok: true, companyId: bound };
  }
  if (caller.isPlatformAdmin) {
    if (!requested) return { ok: false, reason: 'companyId_required' };
    return { ok: true, companyId: requested };
  }
  return { ok: false, reason: 'missing_company' };
}

export function photoReviewDocId(invoiceId: string, photoId: string): string {
  return `${invoiceId}_${photoId}`.slice(0, 700);
}

export function isRemotePhotoUri(raw: unknown): boolean {
  const u = str(raw);
  if (!u) return false;
  if (/^file:/i.test(u) || /^content:/i.test(u) || /^ph:\/\//i.test(u)) return false;
  return /^https?:\/\//i.test(u) || /^gs:\/\//i.test(u);
}

/** Same rewrite Dispatch invoices use — never a signed GET. */
export function displayUrlForInvoicePhoto(raw: unknown, bucketFallback = 'wellbuilt-sync.appspot.com'): string | null {
  let url = str(raw);
  if (!url) return null;
  if (/X-Goog-Algorithm=GOOG4-RSA-SHA256|X-Goog-Signature=/i.test(url)) {
    const pathOnly = url.split('?')[0];
    url = pathOnly || url;
  }
  if (url.includes('firebasestorage.googleapis.com')) {
    const m = url.match(/\/o\/(.+?)(\?|$)/);
    const bucketM = url.match(/\/b\/([^/]+)\//);
    if (m && bucketM) {
      try {
        url = `https://storage.googleapis.com/${bucketM[1]}/${decodeURIComponent(m[1])}`;
      } catch {
        return null;
      }
    }
  }
  if (url.startsWith('gs://')) {
    const rest = url.slice('gs://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    url = `https://storage.googleapis.com/${rest.slice(0, slash)}/${rest.slice(slash + 1)}`;
  }
  if (url.startsWith('photos/') && !url.includes('://')) {
    url = `https://storage.googleapis.com/${bucketFallback}/${url}`;
  }
  return /^https?:\/\//i.test(url) ? url : null;
}

export type ExtractedInvoicePhoto = {
  invoiceId: string;
  photoId: string;
  companyId: string;
  driverId: string;
  driverName: string;
  invoiceNumber: string;
  ticketNumber: string;
  pickup: string;
  dropoff: string;
  photoType: string;
  location: string;
  takenAt: string | null;
  createdAtMs: number | null;
  displayUrl: string | null;
  storagePath: string | null;
  deliveryPending: boolean;
};

function photoIdOf(p: unknown): string {
  if (p && typeof p === 'object' && typeof (p as { photoId?: unknown }).photoId === 'string') {
    return str((p as { photoId: string }).photoId);
  }
  return '';
}

export function extractInvoicePhotos(invoice: InvoicePhotoSource, companyId: string): ExtractedInvoicePhoto[] {
  const invCompany = str(invoice.companyId);
  if (invCompany && invCompany !== companyId) return [];
  const raw = invoice.photos;
  if (!Array.isArray(raw)) return [];
  const out: ExtractedInvoicePhoto[] = [];
  for (const p of raw) {
    if (typeof p === 'string') {
      const url = displayUrlForInvoicePhoto(p);
      if (!url) continue;
      out.push({
        invoiceId: invoice.id,
        photoId: `legacy_${invoice.id}_${out.length}`,
        companyId,
        driverId: str(invoice.driverId),
        driverName: str(invoice.driverName) || str(invoice.driver),
        invoiceNumber: str(invoice.invoiceNumber),
        ticketNumber: str(invoice.ticketNumber) || str(invoice.invoiceNumber),
        pickup: str(invoice.wellName) || str(invoice.pickupName),
        dropoff: str(invoice.disposalName) || str(invoice.disposal) || str(invoice.dropoffName),
        photoType: '',
        location: '',
        takenAt: null,
        createdAtMs: invoice.createdAtMs ?? invoice.closedAtMs ?? null,
        displayUrl: url,
        storagePath: null,
        deliveryPending: false,
      });
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    if (str(rec.type) === 'jsa') continue;
    const photoId = photoIdOf(rec);
    if (!photoId) continue;
    const displayUrl = displayUrlForInvoicePhoto(rec.uri || rec.remoteUrl || rec.gsUri || rec.storagePath);
    out.push({
      invoiceId: invoice.id,
      photoId,
      companyId,
      driverId: str(invoice.driverId),
      driverName: str(invoice.driverName) || str(invoice.driver),
      invoiceNumber: str(invoice.invoiceNumber),
      ticketNumber: str(invoice.ticketNumber) || str(invoice.invoiceNumber),
      pickup: str(invoice.wellName) || str(invoice.pickupName),
      dropoff: str(invoice.disposalName) || str(invoice.disposal) || str(invoice.dropoffName),
      photoType: str(rec.type),
      location: str(rec.location),
      takenAt: str(rec.takenAt) || null,
      createdAtMs: invoice.createdAtMs ?? invoice.closedAtMs ?? null,
      displayUrl,
      storagePath: str(rec.storagePath) || null,
      deliveryPending: rec.deliveryPending === true || !displayUrl,
    });
  }
  return out;
}

export function effectiveReviewStatus(existing: PhotoReviewRecord | null | undefined): PhotoReviewStatus {
  const s = existing?.status;
  if (s && (PHOTO_REVIEW_STATUSES as readonly string[]).includes(s)) return s;
  return 'unreviewed';
}

export function photoMatchesFilters(
  photo: ExtractedInvoicePhoto,
  status: PhotoReviewStatus,
  filters: ReviewListFilters,
): boolean {
  const driver = str(filters.driver).toLowerCase();
  if (driver) {
    const hay = `${photo.driverName} ${photo.driverId}`.toLowerCase();
    if (!hay.includes(driver)) return false;
  }
  const ticket = str(filters.ticketOrJob).toLowerCase();
  if (ticket) {
    const hay = `${photo.invoiceNumber} ${photo.ticketNumber} ${photo.invoiceId}`.toLowerCase();
    if (!hay.includes(ticket)) return false;
  }
  const pickup = str(filters.pickup).toLowerCase();
  if (pickup && !photo.pickup.toLowerCase().includes(pickup)) return false;
  const dropoff = str(filters.dropoff).toLowerCase();
  if (dropoff && !photo.dropoff.toLowerCase().includes(dropoff)) return false;
  const photoType = str(filters.photoType).toLowerCase();
  if (photoType && photo.photoType.toLowerCase() !== photoType) return false;
  const reviewStatus = str(filters.reviewStatus).toLowerCase();
  if (reviewStatus && reviewStatus !== 'all' && status !== reviewStatus) return false;
  const from = typeof filters.dateFromMs === 'number' ? filters.dateFromMs : Number(filters.dateFromMs);
  if (Number.isFinite(from) && from > 0 && (photo.createdAtMs || 0) < from) return false;
  const to = typeof filters.dateToMs === 'number' ? filters.dateToMs : Number(filters.dateToMs);
  if (Number.isFinite(to) && to > 0 && (photo.createdAtMs || 0) > to) return false;
  return true;
}

export type ReviewDecision =
  | {
      ok: true;
      action: PhotoReviewAction;
      nextStatus: PhotoReviewStatus;
      rejectReason?: string;
      supervisorNote?: string;
      addressedNote?: string;
      reviewerLabel: string;
    }
  | { ok: false; reason: string };

const ALLOWED: Record<PhotoReviewStatus, Partial<Record<PhotoReviewAction, PhotoReviewStatus>>> = {
  unreviewed: { approve: 'approved', reject: 'rejected' },
  approved: { approve: 'approved', reject: 'rejected' },
  rejected: { approve: 'approved', reject: 'rejected', address: 'addressed' },
  addressed: { address: 'addressed' },
};

export function reviewerLabel(caller: PhotoReviewCaller): string {
  return str(caller.displayName) || str(caller.email) || caller.uid;
}

export function evaluateReviewDispatchPhoto(input: {
  caller: PhotoReviewCaller | null | undefined;
  companyId: unknown;
  invoiceId: unknown;
  photoId: unknown;
  action: unknown;
  rejectReason?: unknown;
  supervisorNote?: unknown;
  addressedNote?: unknown;
  existing: PhotoReviewRecord | null;
  photoBelongsToCompany: boolean;
}): ReviewDecision {
  if (!input.caller?.uid) return { ok: false, reason: 'unauthenticated' };
  const tenancy = resolvePhotoReviewCompany(input.caller, input.companyId);
  if (!tenancy.ok) return { ok: false, reason: tenancy.reason };
  if (!callerCanMutatePhotoReview(input.caller)) return { ok: false, reason: 'role_denied' };
  const invoiceId = str(input.invoiceId);
  const photoId = str(input.photoId);
  if (!invoiceId) return { ok: false, reason: 'invoiceId_required' };
  if (!photoId) return { ok: false, reason: 'photoId_required' };
  if (!input.photoBelongsToCompany) return { ok: false, reason: 'photo_not_owned' };

  const action = str(input.action) as PhotoReviewAction;
  if (!(PHOTO_REVIEW_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, reason: 'unknown_action' };
  }
  const current = effectiveReviewStatus(input.existing);
  const next = ALLOWED[current]?.[action];
  if (!next) return { ok: false, reason: 'illegal_transition' };

  const rejectReason = str(input.rejectReason);
  const supervisorNote = str(input.supervisorNote);
  const addressedNote = str(input.addressedNote);
  if (action === 'reject' && !rejectReason) return { ok: false, reason: 'reject_reason_required' };

  return {
    ok: true,
    action,
    nextStatus: next,
    rejectReason: action === 'reject' ? rejectReason : input.existing?.rejectReason,
    supervisorNote: supervisorNote || input.existing?.supervisorNote,
    addressedNote: action === 'address' ? addressedNote : input.existing?.addressedNote,
    reviewerLabel: reviewerLabel(input.caller),
  };
}

export function clampListLimit(raw: unknown, fallback = 200, max = 400): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
