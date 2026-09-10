import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireRegisteredDashboardUser } from '../adminAuth';
import {
  evaluateReviewDispatchPhoto,
  extractInvoicePhotos,
  photoReviewDocId,
  reviewerLabel,
  type PhotoReviewRecord,
} from './dispatchPhotoReviewCore';

const ALLOWED_KEYS = new Set([
  'companyId',
  'invoiceId',
  'photoId',
  'action',
  'rejectReason',
  'supervisorNote',
  'addressedNote',
]);

export const reviewDispatchPhoto = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const rawCaller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const caller = {
      uid: rawCaller.uid,
      roles: rawCaller.roles,
      companyId: rawCaller.companyId,
      isPlatformAdmin: rawCaller.isPlatformAdmin,
      email: typeof request.auth?.token?.email === 'string' ? request.auth.token.email : null,
      displayName: typeof request.auth?.token?.name === 'string' ? request.auth.token.name : null,
    };

    const fs = admin.firestore();
    const invoiceId = typeof raw.invoiceId === 'string' ? raw.invoiceId.trim() : '';
    const photoId = typeof raw.photoId === 'string' ? raw.photoId.trim() : '';
    const invoiceSnap = invoiceId ? await fs.collection('invoices').doc(invoiceId).get() : null;
    const invoice = invoiceSnap?.exists ? (invoiceSnap.data() as Record<string, unknown>) : null;
    const companyId = (rawCaller.companyId || (typeof raw.companyId === 'string' ? raw.companyId : '')).trim();
    const photos = invoice
      ? extractInvoicePhotos({ id: invoiceId, ...invoice, photos: invoice.photos }, companyId)
      : [];
    const belongs = photos.some((p) => p.photoId === photoId);

    const reviewRef = fs.collection('dispatchPhotoReviews').doc(photoReviewDocId(invoiceId, photoId));
    const existingSnap = await reviewRef.get();
    const existing = existingSnap.exists ? (existingSnap.data() as PhotoReviewRecord) : null;

    const decided = evaluateReviewDispatchPhoto({
      caller,
      companyId: raw.companyId || rawCaller.companyId,
      invoiceId,
      photoId,
      action: raw.action,
      rejectReason: raw.rejectReason,
      supervisorNote: raw.supervisorNote,
      addressedNote: raw.addressedNote,
      existing,
      photoBelongsToCompany: belongs,
    });
    if (!decided.ok) {
      const code = decided.reason === 'unauthenticated' ? 'unauthenticated'
        : decided.reason === 'unknown_action' || decided.reason === 'invoiceId_required'
          || decided.reason === 'photoId_required' || decided.reason === 'reject_reason_required'
          ? 'invalid-argument'
          : 'permission-denied';
      throw new httpsV2.HttpsError(code, decided.reason);
    }

    const now = Date.now();
    const label = decided.reviewerLabel || reviewerLabel(caller);
    const patch: Record<string, unknown> = {
      companyId,
      invoiceId,
      photoId,
      status: decided.nextStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (decided.action === 'approve' || decided.action === 'reject') {
      patch.reviewedByUid = caller.uid;
      patch.reviewedByLabel = label;
      patch.reviewedAt = FieldValue.serverTimestamp();
      patch.reviewedAtMs = now;
      if (decided.rejectReason) patch.rejectReason = decided.rejectReason;
      if (decided.supervisorNote) patch.supervisorNote = decided.supervisorNote;
    }
    if (decided.action === 'address') {
      patch.addressedByUid = caller.uid;
      patch.addressedByLabel = label;
      patch.addressedAt = FieldValue.serverTimestamp();
      patch.addressedAtMs = now;
      if (decided.addressedNote) patch.addressedNote = decided.addressedNote;
    }

    const eventRef = fs.collection('dispatchPhotoReviewEvents').doc();
    await fs.runTransaction(async (tx) => {
      tx.set(reviewRef, patch, { merge: true });
      tx.set(eventRef, {
        companyId,
        invoiceId,
        photoId,
        action: decided.action,
        nextStatus: decided.nextStatus,
        actorUid: caller.uid,
        actorLabel: label,
        rejectReason: decided.rejectReason || null,
        supervisorNote: decided.supervisorNote || null,
        addressedNote: decided.addressedNote || null,
        at: FieldValue.serverTimestamp(),
        atMs: now,
      });
    });

    return {
      ok: true as const,
      invoiceId,
      photoId,
      status: decided.nextStatus,
      reviewedAtMs: decided.action === 'address' ? existing?.reviewedAtMs || null : now,
      addressedAtMs: decided.action === 'address' ? now : existing?.addressedAtMs || null,
    };
  },
);
