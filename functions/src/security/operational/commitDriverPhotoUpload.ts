/**
 * Admin-SDK byte commit for driver job photos.
 *
 * issueDriverPhotoUpload mints a signed PUT and currently 500s because the
 * runtime SA lacks iam.serviceAccounts.signBlob. This callable writes the
 * same governed path with file.save() — no signed URL — and treats an
 * existing same-identity object as alreadyUploaded.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  authorizeDriverPhotoUpload,
  authorizePhotoTargetOwner,
  decidePhotoUploadIdempotency,
  durablePhotoReference,
  uploadedObjectWithinLimit,
} from './driverPhotoUploadCore';

const ALLOWED_KEYS = new Set([
  'photoId', 'invoiceDocId', 'companyId', 'contentType', 'byteSize', 'bytesBase64', 'contentMd5',
]);

export const commitDriverPhotoUpload = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.driverId || !driver.companyId) {
      throw new httpsV2.HttpsError('unauthenticated', 'Driver authentication required');
    }
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const decision = authorizeDriverPhotoUpload({
      caller: {
        uid: driver.uid,
        driverId: driver.driverId,
        companyId: driver.companyId,
        isPlatformAdmin: false,
      },
      request: raw,
    });
    if (!decision.ok) {
      throw new httpsV2.HttpsError('permission-denied', decision.error);
    }

    const fs = admin.firestore();
    const invSnap = await fs.collection('invoices').doc(decision.invoiceDocId).get();
    let tickets: Array<{ companyId?: string | null; ownerDriverId?: string | null; invoiceDocId?: string | null }> = [];
    if (!invSnap.exists) {
      const tSnap = await fs.collection('tickets')
        .where('invoiceDocId', '==', decision.invoiceDocId)
        .limit(8)
        .get();
      tickets = tSnap.docs.map((d) => {
        const x = d.data() || {};
        return {
          companyId: (x.companyId as string) || null,
          ownerDriverId: (x.ownerDriverId as string) || null,
          invoiceDocId: (x.invoiceDocId as string) || null,
        };
      });
    }
    const owned = authorizePhotoTargetOwner({
      caller: {
        uid: driver.uid,
        driverId: driver.driverId,
        companyId: driver.companyId,
        isPlatformAdmin: false,
      },
      invoiceDocId: decision.invoiceDocId,
      invoice: invSnap.exists ? (invSnap.data() as any) : null,
      tickets,
    });
    if (!owned.ok) {
      throw new httpsV2.HttpsError('permission-denied', owned.error);
    }

    const b64 = typeof raw.bytesBase64 === 'string' ? raw.bytesBase64 : '';
    const bucket = admin.storage().bucket();
    const file = bucket.file(decision.storagePath);
    const durable = durablePhotoReference({ bucket: bucket.name, storagePath: decision.storagePath });
    const [exists] = await file.exists();
    let existingSize: number | null = null;
    let existingMd5: string | null = null;
    if (exists) {
      const [meta] = await file.getMetadata();
      existingSize = typeof meta.size === 'number' ? meta.size : Number(meta.size);
      existingMd5 = typeof meta.md5Hash === 'string' ? meta.md5Hash : null;
      if (!uploadedObjectWithinLimit(existingSize)) {
        throw new httpsV2.HttpsError('invalid-argument', 'uploaded_object_exceeds_limit');
      }
    }
    const action = decidePhotoUploadIdempotency({
      objectExists: exists,
      existingSize,
      existingMd5,
      requestedSize: decision.byteSize,
      requestedMd5: typeof raw.contentMd5 === 'string' ? raw.contentMd5 : null,
    });
    if (action === 'conflict') {
      throw new httpsV2.HttpsError('already-exists', 'photoId_bytes_conflict');
    }
    if (action === 'reuse') {
      return { ok: true as const, alreadyUploaded: true, ...durable, contentType: decision.contentType };
    }
    if (!b64) {
      throw new httpsV2.HttpsError('invalid-argument', 'bytesBase64_required');
    }
    const buf = Buffer.from(b64, 'base64');
    if (!uploadedObjectWithinLimit(buf.length)) {
      throw new httpsV2.HttpsError('invalid-argument', 'uploaded_object_exceeds_limit');
    }
    await file.save(buf, {
      resumable: false,
      public: false,
      metadata: { contentType: decision.contentType, cacheControl: 'private, max-age=3600' },
    });
    return { ok: true as const, alreadyUploaded: false, ...durable, contentType: decision.contentType, size: buf.length };
  },
);
