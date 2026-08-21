/**
 * Short-lived one-object upload grants.
 *
 * Returns a v4 signed PUT URL for exactly one object, method, content
 * type, and size bound. Grants are single-use. Overwrite/delete is refused.
 * No production bucket access is required for decision tests.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver, assertSameCompany } from '../requireDriverAuth';
import { requireAdminAuthority } from '../adminAuth';
import { staffHasCapability } from '../canonicalAdminAuthority';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit } from '../rateLimit';
import { decideResourceOwnership, decideThreadMembership } from './resourceOwnership';
import { randomUUID } from 'crypto';

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const GRANT_TTL_MS = 10 * 60 * 1000;

export type StorageUploadKind = 'ticket_photo' | 'chat_photo' | 'jsa_pdf' | 'ewallet_doc' | 'photo_requirement_sample';

export function decideUploadGrant(input: {
  kind: StorageUploadKind;
  driverId: string;
  companyId: string;
  invoiceCompanyId?: string | null;
  invoiceDriverId?: string | null;
  threadCompanyId?: string | null;
  threadParticipants?: string[];
  jsaCompanyId?: string | null;
  contentType: string;
  byteSize: number;
  objectExists?: boolean;
}): { ok: true; method: 'PUT' } | { ok: false; reason: string } {
  if (input.objectExists) return { ok: false, reason: 'overwrite_refused' };
  if (input.byteSize <= 0 || input.byteSize > MAX_PHOTO_BYTES) {
    return { ok: false, reason: 'size_bound' };
  }
  if (input.kind === 'jsa_pdf') {
    if (input.contentType !== 'application/pdf') return { ok: false, reason: 'content_type' };
    if (input.jsaCompanyId && input.jsaCompanyId !== input.companyId) {
      return { ok: false, reason: 'cross_company' };
    }
    return { ok: true, method: 'PUT' };
  }
  if (!input.contentType.startsWith('image/')) return { ok: false, reason: 'content_type' };
  if (input.kind === 'ticket_photo') {
    const own = decideResourceOwnership({
      callerDriverId: input.driverId,
      callerCompanyId: input.companyId,
      resourceDriverId: input.invoiceDriverId,
      resourceCompanyId: input.invoiceCompanyId,
    });
    if (!own.ok) return { ok: false, reason: own.reason };
    return { ok: true, method: 'PUT' };
  }
  if (input.kind === 'chat_photo') {
    const mem = decideThreadMembership({
      callerDriverId: input.driverId,
      callerCompanyId: input.companyId,
      threadCompanyId: input.threadCompanyId,
      participantIds: input.threadParticipants,
    });
    if (!mem.ok) return { ok: false, reason: mem.reason };
    return { ok: true, method: 'PUT' };
  }
  if (input.kind === 'ewallet_doc') return { ok: true, method: 'PUT' };
  if (input.kind === 'photo_requirement_sample') {
    if (input.invoiceCompanyId && input.invoiceCompanyId !== input.companyId) {
      return { ok: false, reason: 'cross_company' };
    }
    return { ok: true, method: 'PUT' };
  }
  return { ok: false, reason: 'unknown_kind' };
}

export interface CanonicalObjectRef {
  bucket: string;
  path: string;
}

/** Durable reference only — never a tokenless download URL. */
export function canonicalObjectRef(bucket: string, path: string): CanonicalObjectRef {
  return { bucket, path };
}

/** @deprecated Tokenless media URLs are not displayable under auth-required rules. */
export function canonicalObjectReadUrl(bucket: string, path: string): string {
  return `canonical://${bucket}/${path}`;
}

export function decidePhotoReadAccess(input: {
  callerClass: 'driver' | 'staff' | 'other';
  callerDriverId?: string | null;
  callerCompanyId?: string | null;
  photoDriverId?: string | null;
  photoCompanyId?: string | null;
  staffAuthorized?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const photoCompany = (input.photoCompanyId || '').trim();
  const callerCompany = (input.callerCompanyId || '').trim();
  if (!photoCompany || !callerCompany || photoCompany !== callerCompany) {
    return { ok: false, reason: 'cross_company' };
  }
  if (input.callerClass === 'driver') {
    if (input.callerDriverId && input.photoDriverId && input.callerDriverId === input.photoDriverId) {
      return { ok: true };
    }
    return { ok: false, reason: 'not_owner' };
  }
  if (input.callerClass === 'staff' && input.staffAuthorized) return { ok: true };
  return { ok: false, reason: 'not_authorized' };
}

export function decideSignedReadReuse(input: {
  expiresAt: number;
  nowMs: number;
}): { ok: true } | { ok: false; reason: 'expired' } {
  if (typeof input.expiresAt !== 'number' || input.expiresAt <= input.nowMs) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

export function decideConsumeGrant(input: {
  used?: boolean;
  expiresAt?: number;
  nowMs: number;
  pathMatches: boolean;
  objectExists?: boolean;
  storedBytes?: number;
  declaredBytes?: number;
  storedContentType?: string;
  declaredContentType?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.used) return { ok: false, reason: 'replay' };
  if (typeof input.expiresAt !== 'number' || input.expiresAt <= input.nowMs) {
    return { ok: false, reason: 'expired' };
  }
  if (!input.pathMatches) return { ok: false, reason: 'path_mismatch' };
  if (input.objectExists === false) return { ok: false, reason: 'object_missing' };
  if (
    typeof input.declaredBytes === 'number' &&
    typeof input.storedBytes === 'number' &&
    input.storedBytes !== input.declaredBytes
  ) {
    return { ok: false, reason: 'size_mismatch' };
  }
  if (
    input.declaredContentType &&
    input.storedContentType &&
    input.storedContentType !== input.declaredContentType
  ) {
    return { ok: false, reason: 'type_mismatch' };
  }
  return { ok: true };
}

export const requestStorageUploadPath = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      kind?: StorageUploadKind;
      companyId?: string;
      invoiceId?: string;
      photoId?: string;
      threadId?: string;
      docId?: string;
      contentType?: string;
      byteSize?: number;
      driverHash?: string;
    };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }

    const driver = await requireSecureDriver(request);
    const allowedRate = await checkRateLimit({
      bucket: 'storage_grant',
      key: driver.driverId,
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!allowedRate) throw new httpsV2.HttpsError('resource-exhausted', 'rate_limited');

    const kind = data.kind || 'ticket_photo';
    const contentType = (data.contentType || '').toLowerCase();
    const byteSize = typeof data.byteSize === 'number' ? data.byteSize : 0;
    const companyId = data.companyId || driver.companyId;
    if (companyId) assertSameCompany(driver.companyId, companyId);

    let invoiceCompanyId: string | null = null;
    let invoiceDriverId: string | null = null;
    let threadCompanyId: string | null = null;
    let threadParticipants: string[] = [];
    let jsaCompanyId: string | null = null;
    let path: string;

    switch (kind) {
      case 'ticket_photo': {
        if (!companyId || !data.invoiceId) {
          throw new httpsV2.HttpsError('invalid-argument', 'companyId and invoiceId required');
        }
        const inv = await admin.firestore().collection('invoices').doc(data.invoiceId).get();
        if (!inv.exists) throw new httpsV2.HttpsError('not-found', 'invoice');
        invoiceCompanyId = typeof inv.get('companyId') === 'string' ? inv.get('companyId') : null;
        invoiceDriverId = typeof inv.get('driverId') === 'string' ? inv.get('driverId') : null;
        const { decidePhotoId } = await import('./invoicePhotoAttach');
        const idDec = decidePhotoId(data.photoId);
        if (!idDec.ok) throw new httpsV2.HttpsError('invalid-argument', idDec.reason);
        const photoId = idDec.photoId || `ph_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        path = `photos/${companyId}/${driver.driverId}/${data.invoiceId}/${photoId}.jpg`;
        (data as { resolvedPhotoId?: string }).resolvedPhotoId = photoId;
        break;
      }
      case 'chat_photo': {
        if (!data.threadId || !companyId) {
          throw new httpsV2.HttpsError('invalid-argument', 'threadId and companyId required');
        }
        const th = await admin.firestore().collection('chat_threads').doc(data.threadId).get();
        if (!th.exists) throw new httpsV2.HttpsError('not-found', 'thread');
        threadCompanyId = typeof th.get('companyId') === 'string' ? th.get('companyId') : null;
        const parts = th.get('participantIds');
        threadParticipants = Array.isArray(parts) ? parts.map(String) : [];
        path = `chat_photos/${companyId}/${driver.driverId}/${data.threadId}/${Date.now()}_${driver.driverId.slice(0, 8)}.jpg`;
        break;
      }
      case 'jsa_pdf': {
        if (!companyId) throw new httpsV2.HttpsError('invalid-argument', 'companyId required');
        jsaCompanyId = companyId;
        const day = new Date().toISOString().slice(0, 10);
        path = `jsa/${companyId}/${driver.driverId}/${day}_${Date.now()}.pdf`;
        break;
      }
      case 'ewallet_doc': {
        path = `ewallet/${driver.driverId}/${data.docId || Date.now()}.jpg`;
        break;
      }
      default:
        throw new httpsV2.HttpsError('invalid-argument', 'unknown kind');
    }

    let objectExists = false;
    try {
      const [exists] = await admin.storage().bucket().file(path).exists();
      objectExists = exists === true;
    } catch (err) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        'storage_exists_unreadable',
      );
    }

    const decided = decideUploadGrant({
      kind,
      driverId: driver.driverId,
      companyId: companyId || driver.companyId,
      invoiceCompanyId,
      invoiceDriverId,
      threadCompanyId,
      threadParticipants,
      jsaCompanyId,
      contentType,
      byteSize,
      objectExists,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError('permission-denied', decided.reason);
    }

    const grantId = randomUUID();
    const expiresAt = Date.now() + GRANT_TTL_MS;
    const resolvedPhotoId = (data as { resolvedPhotoId?: string }).resolvedPhotoId || null;
    await admin.firestore().collection('storage_grants').doc(grantId).set({
      path,
      bucket: admin.storage().bucket().name,
      driverId: driver.driverId,
      companyId: companyId || driver.companyId || null,
      invoiceId: kind === 'ticket_photo' ? String(data.invoiceId) : null,
      photoId: resolvedPhotoId,
      kind,
      contentType,
      byteSize,
      method: 'PUT',
      expiresAt,
      used: false,
    });

    let uploadUrl: string | null = null;
    let signError: string | null = null;
    try {
      const [url] = await admin.storage().bucket().file(path).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: expiresAt,
        contentType: contentType || undefined,
        extensionHeaders: {
          'x-goog-if-generation-match': '0',
        },
      });
      uploadUrl = url;
    } catch (err) {
      signError = (err as Error).message || 'sign_failed';
    }

    await writeSecurityAudit({
      action: 'requestStorageUploadPath',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { kind, path, grantId, signed: !!uploadUrl, signError: signError ? 'present' : null },
    });

    if (!uploadUrl) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        'signed_url_unavailable_nonprod_or_emulator',
      );
    }

    return {
      path,
      grantId,
      expiresAt,
      method: 'PUT',
      contentType,
      maxBytes: MAX_PHOTO_BYTES,
      requiredHeaders: {
        'Content-Type': contentType,
        'x-goog-if-generation-match': '0',
      },
      uploadUrl,
      // URL is reusable until expiry; create-only generation + grant consume
      // are the overwrite/replay controls. Not a cryptographic single-use URL.
      reuseUntilExpiry: true,
      driverId: driver.driverId,
      companyId: companyId || null,
      invoiceId: kind === 'ticket_photo' ? String(data.invoiceId) : null,
      photoId: resolvedPhotoId,
    };
  },
);

export const finalizeStorageUpload = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { grantId?: string; path?: string; driverHash?: string };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    const driver = await requireSecureDriver(request);
    const grantId = String(data.grantId || '');
    if (!grantId) throw new httpsV2.HttpsError('invalid-argument', 'grantId required');
    const ref = admin.firestore().collection('storage_grants').doc(grantId);
    const grantSnap = await ref.get();
    if (!grantSnap.exists) throw new httpsV2.HttpsError('not-found', 'grant');
    const grant = grantSnap.data() || {};
    const objectPath = String(grant.path || '');
    let meta: { size?: string | number; contentType?: string; generation?: string | number } = {};
    let objectExists = false;
    try {
      const file = admin.storage().bucket().file(objectPath);
      const [exists] = await file.exists();
      objectExists = exists === true;
      if (exists) {
        const [got] = await file.getMetadata();
        meta = got || {};
      }
    } catch {
      throw new httpsV2.HttpsError('failed-precondition', 'storage_metadata_unreadable');
    }
    const result = await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new httpsV2.HttpsError('not-found', 'grant');
      const g = snap.data() || {};
      if (g.driverId !== driver.driverId) {
        throw new httpsV2.HttpsError('permission-denied', 'not_owner');
      }
      const already = g.used === true;
      if (!already) {
        const dec = decideConsumeGrant({
          used: false,
          expiresAt: typeof g.expiresAt === 'number' ? g.expiresAt : 0,
          nowMs: Date.now(),
          pathMatches: !data.path || data.path === g.path,
          objectExists,
          storedBytes: typeof meta.size === 'string' ? Number(meta.size) : Number(meta.size || 0),
          declaredBytes: typeof g.byteSize === 'number' ? g.byteSize : undefined,
          storedContentType: typeof meta.contentType === 'string' ? meta.contentType : undefined,
          declaredContentType: typeof g.contentType === 'string' ? g.contentType : undefined,
        });
        if (!dec.ok) throw new httpsV2.HttpsError('failed-precondition', dec.reason);
        tx.update(ref, {
          used: true,
          usedAt: Date.now(),
          finalizedBy: driver.uid,
          storedGeneration: meta.generation || null,
          storedBytes: meta.size || null,
        });
      }
      const bucket = typeof g.bucket === 'string' && g.bucket
        ? g.bucket
        : admin.storage().bucket().name;
      if (bucket !== admin.storage().bucket().name) {
        throw new httpsV2.HttpsError('permission-denied', 'bucket_mismatch');
      }
      const refObj = canonicalObjectRef(bucket, String(g.path));
      let attached: { photoId: string; duplicate: boolean } | null = null;
      if (g.kind === 'ticket_photo' && g.invoiceId && g.photoId) {
        const { attachPhotoToInvoicePhotos, buildCanonicalInvoicePhoto } = await import('./invoicePhotoAttach');
        const invRef = admin.firestore().collection('invoices').doc(String(g.invoiceId));
        const invSnap = await tx.get(invRef);
        if (!invSnap.exists) throw new httpsV2.HttpsError('not-found', 'invoice');
        const inv = invSnap.data() || {};
        if (inv.driverId !== driver.driverId || inv.companyId !== g.companyId) {
          throw new httpsV2.HttpsError('permission-denied', 'invoice_not_owner');
        }
        const photo = buildCanonicalInvoicePhoto({
          photoId: String(g.photoId),
          bucket: refObj.bucket,
          path: refObj.path,
          generation: meta.generation ?? g.storedGeneration ?? null,
          companyId: String(g.companyId),
          driverId: String(g.driverId),
          invoiceId: String(g.invoiceId),
          kind: 'ticket_photo',
          contentType: (meta.contentType ?? g.contentType ?? null) as string | null,
          size: (meta.size ?? g.storedBytes ?? null) as string | number | null,
        });
        const next = attachPhotoToInvoicePhotos(inv.photos, photo);
        tx.set(invRef, { photos: next.photos, updatedAt: Date.now() }, { merge: true });
        attached = { photoId: photo.photoId, duplicate: next.duplicate || already };
      }
      return {
        path: refObj.path,
        kind: g.kind,
        bucket: refObj.bucket,
        generation: meta.generation ?? g.storedGeneration ?? null,
        size: meta.size ?? g.storedBytes ?? null,
        contentType: meta.contentType ?? g.contentType ?? null,
        photoId: g.photoId || null,
        invoiceId: g.invoiceId || null,
        attached,
      };
    });
    await writeSecurityAudit({
      action: 'finalizeStorageUpload',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { path: result.path, bucket: result.bucket },
    });
    return { ok: true, ...result };
  },
);

/**
 * Authorize the caller, then issue a short-lived signed GET URL.
 * The URL is not stored as invoice metadata.
 */
export const issueStorageReadUrl = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const { runIssueStorageReadUrl } = await import('./storageReadBinding');
    const data = (request.data || {}) as {
      bucket?: string;
      path?: string;
      invoiceId?: string;
      photoId?: string;
      grantId?: string;
      generation?: string | number | null;
    };

    let caller: {
      class: 'driver' | 'staff' | 'platform';
      driverId?: string | null;
      companyId?: string | null;
      staffHasViewTickets?: boolean;
      platformDualGated?: boolean;
      uid: string;
    };
    try {
      const driver = await requireSecureDriver(request);
      caller = {
        class: 'driver',
        driverId: driver.driverId,
        companyId: driver.companyId,
        uid: driver.uid,
      };
    } catch {
      const staff = await requireAdminAuthority(
        request.auth?.uid,
        request.auth?.token as Record<string, unknown> | undefined,
      );
      caller = {
        class: staff.class === 'platform' ? 'platform' : 'staff',
        companyId: staff.companyId,
        staffHasViewTickets: staff.class === 'platform' || staffHasCapability(staff, 'viewTickets'),
        platformDualGated: staff.class === 'platform',
        uid: staff.uid,
      };
    }

    const live = admin.storage().bucket();
    const result = await runIssueStorageReadUrl(data, caller, {
      liveBucket: () => live.name,
      async getInvoice(id) {
        const snap = await admin.firestore().collection('invoices').doc(id).get();
        return snap.exists ? (snap.data() as Record<string, unknown>) : null;
      },
      async getGrant(id) {
        const snap = await admin.firestore().collection('storage_grants').doc(id).get();
        return snap.exists ? (snap.data() as Record<string, unknown>) : null;
      },
      async signRead(path, expiresAt) {
        const [url] = await live.file(path).getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: expiresAt,
        });
        return url;
      },
    });
    if (!result.ok) {
      throw new httpsV2.HttpsError(result.http, result.reason);
    }
    await writeSecurityAudit({
      action: 'issueStorageReadUrl',
      actorUid: caller.uid,
      detail: { path: result.path, bucket: result.bucket, invoiceId: data.invoiceId || null, photoId: data.photoId || null, grantId: data.grantId || null },
    });
    return result;
  },
);
