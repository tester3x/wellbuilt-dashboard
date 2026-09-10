import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireRegisteredDashboardUser } from '../adminAuth';
import {
  clampListLimit,
  effectiveReviewStatus,
  extractInvoicePhotos,
  photoMatchesFilters,
  photoReviewDocId,
  resolvePhotoReviewCompany,
  type ExtractedInvoicePhoto,
  type InvoicePhotoSource,
  type PhotoReviewRecord,
  type PhotoReviewStatus,
} from './dispatchPhotoReviewCore';

function tsMs(v: unknown): number | null {
  if (!v) return null;
  if (typeof (v as { toMillis?: () => number }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (typeof (v as { seconds?: number }).seconds === 'number') {
    return (v as { seconds: number }).seconds * 1000;
  }
  if (v instanceof Date) return v.getTime();
  const n = typeof v === 'string' ? Date.parse(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const listDispatchPhotoReviews = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const data = (request.data || {}) as Record<string, unknown>;
    const tenancy = resolvePhotoReviewCompany({
      uid: caller.uid,
      roles: caller.roles,
      companyId: caller.companyId,
      isPlatformAdmin: caller.isPlatformAdmin,
    }, data.companyId);
    if (!tenancy.ok) {
      throw new httpsV2.HttpsError(
        tenancy.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
        tenancy.reason,
      );
    }
    const companyId = tenancy.companyId;
    const limit = clampListLimit(data.limit);
    const fs = admin.firestore();

    let q: admin.firestore.Query = fs.collection('invoices').where('companyId', '==', companyId);
    const from = typeof data.dateFromMs === 'number' ? data.dateFromMs : Number(data.dateFromMs);
    const to = typeof data.dateToMs === 'number' ? data.dateToMs : Number(data.dateToMs);
    if (Number.isFinite(from) && from > 0) q = q.where('createdAt', '>=', new Date(from));
    if (Number.isFinite(to) && to > 0) q = q.where('createdAt', '<=', new Date(to));
    q = q.orderBy('createdAt', 'desc').limit(limit);

    const snap = await q.get();
    const extracted: ExtractedInvoicePhoto[] = [];
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const src: InvoicePhotoSource = {
        id: doc.id,
        companyId: d.companyId,
        driverId: d.driverId,
        driverName: d.driverName,
        driver: d.driver,
        invoiceNumber: d.invoiceNumber,
        ticketNumber: d.ticketNumber,
        wellName: d.wellName || d.ndicWellName,
        pickupName: d.pickupName,
        disposal: d.disposal,
        disposalName: d.disposalName,
        dropoffName: d.dropoffName,
        createdAtMs: tsMs(d.createdAt) ?? tsMs(d.closedAt),
        closedAtMs: tsMs(d.closedAt),
        photos: d.photos,
      };
      extracted.push(...extractInvoicePhotos(src, companyId));
    }

    const ids = extracted.map((p) => photoReviewDocId(p.invoiceId, p.photoId));
    const reviews = new Map<string, PhotoReviewRecord>();
    for (let i = 0; i < ids.length; i += 40) {
      const slice = ids.slice(i, i + 40);
      if (!slice.length) continue;
      const refs = slice.map((id) => fs.collection('dispatchPhotoReviews').doc(id));
      const got = await fs.getAll(...refs);
      for (const r of got) {
        if (!r.exists) continue;
        reviews.set(r.id, r.data() as PhotoReviewRecord);
      }
    }

    const items = [];
    for (const photo of extracted) {
      const rec = reviews.get(photoReviewDocId(photo.invoiceId, photo.photoId)) || null;
      const status: PhotoReviewStatus = effectiveReviewStatus(rec);
      if (!photoMatchesFilters(photo, status, data)) continue;
      items.push({
        ...photo,
        reviewStatus: status,
        rejectReason: rec?.rejectReason || null,
        supervisorNote: rec?.supervisorNote || null,
        addressedNote: rec?.addressedNote || null,
        reviewedByLabel: rec?.reviewedByLabel || null,
        reviewedAtMs: rec?.reviewedAtMs || null,
        addressedByLabel: rec?.addressedByLabel || null,
        addressedAtMs: rec?.addressedAtMs || null,
        dispatchHref: `/dispatch/?invoice=${encodeURIComponent(photo.invoiceId)}`,
      });
    }

    return { ok: true as const, companyId, count: items.length, items };
  },
);
