/**
 * Secure invoice/ticket/dispatch mutations for field apps.
 * Prefer these over open Firestore client writes after enforcement.
 * Does not change vc33 close semantics — validates ownership + state machine.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver, assertSameCompany } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import {
  requireVerifiedDriverIdentity,
  rejectSpoofedResourceIdentity,
} from './driverOwnedWrite';

const MAX_JSON = 400_000;

const TERMINAL_STATUSES = new Set([
  'closed',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'void',
]);

function stripPrivilege(obj: Record<string, unknown>) {
  delete obj.isAdmin;
  delete obj.roles;
  delete obj.role;
  delete obj.manageDrivers;
}

const ALLOWED_PHOTO_PATCH_FIELDS = new Set([
  'photos',
  'photoMetadata',
  'photoIds',
  'intent',
]);

const FORBIDDEN_LIFECYCLE_FIELDS = new Set([
  'status',
  'driverState',
  'closedAt',
  'completedAt',
  'closeReason',
  'packetId',
  'canonicalJobId',
  'ticketNumber',
  'ticketId',
  'bbls',
  'bblsTaken',
  'gallons',
  'netBarrels',
  'startBarrels',
  'endBarrels',
  'destination',
  'disposal',
  'haulGroupId',
  'companyId',
  'driverId',
  'authSource',
]);

/**
 * Merge photos monotonically by durable photo ID / path / URL.
 * Preserves existing photos not present in incoming, merges metadata on match,
 * never duplicates by photoId, strips localUri.
 */
export function mergeDurablePhotos(
  existing: unknown[] | null | undefined,
  incoming: unknown[] | null | undefined,
): Array<Record<string, unknown>> {
  const existList = Array.isArray(existing) ? existing : [];
  const inList = Array.isArray(incoming) ? incoming : [];

  const order: string[] = [];
  const byKey = new Map<string, Record<string, unknown>>();

  const keyFor = (p: any, idx: number, prefix: string): string => {
    if (p && typeof p === 'object') {
      if (p.photoId) return `id:${String(p.photoId)}`;
      if (p.storagePath) return `path:${String(p.storagePath)}`;
      if (p.gsUri) return `gs:${String(p.gsUri)}`;
      if (p.remoteUrl) return `url:${String(p.remoteUrl)}`;
      if (p.uri && !String(p.uri).startsWith('file://')) return `uri:${String(p.uri)}`;
    }
    return `${prefix}:anon:${idx}`;
  };

  existList.forEach((p, idx) => {
    if (!p || typeof p !== 'object') return;
    const k = keyFor(p, idx, 'ex');
    if (!byKey.has(k)) order.push(k);
    const copy = { ...(p as Record<string, unknown>) };
    delete copy.localUri;
    byKey.set(k, copy);
  });

  inList.forEach((p, idx) => {
    if (!p || typeof p !== 'object') return;
    const k = keyFor(p, idx, 'in');
    if (byKey.has(k)) {
      const old = byKey.get(k)!;
      const merged = { ...old, ...(p as Record<string, unknown>) };
      delete merged.localUri;
      byKey.set(k, merged);
    } else {
      order.push(k);
      const copy = { ...(p as Record<string, unknown>) };
      delete copy.localUri;
      byKey.set(k, copy);
    }
  });

  return order.map((k) => byKey.get(k)!).filter(Boolean);
}

async function handlePhotoPatchCore(
  driver: { uid: string; driverId: string; companyId: string; authSource: string },
  data: {
    invoiceId?: string;
    invoice: Record<string, unknown>;
    driverHash?: string;
    idempotencyKey?: string;
  },
) {
  // Fail closed: reject forbidden lifecycle or operational fields
  for (const key of Object.keys(data.invoice)) {
    if (FORBIDDEN_LIFECYCLE_FIELDS.has(key)) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        `Lifecycle or operational field '${key}' is forbidden in photo_patch`,
      );
    }
    if (!ALLOWED_PHOTO_PATCH_FIELDS.has(key)) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        `Field '${key}' is not permitted in photo_patch`,
      );
    }
  }

  const invoiceId = (data.invoiceId || '').trim();
  if (!invoiceId) {
    throw new httpsV2.HttpsError('invalid-argument', 'invoiceId required for photo_patch');
  }

  const col = admin.firestore().collection('invoices');
  const ref = col.doc(invoiceId);
  const ex = await ref.get();
  if (!ex.exists) {
    throw new httpsV2.HttpsError('not-found', 'Invoice not found');
  }

  const prev = ex.data() || {};
  const owner =
    Boolean(prev.driverId && prev.driverId === driver.driverId) ||
    Boolean(prev.driverHash && data.driverHash && prev.driverHash === data.driverHash) ||
    Boolean(prev.driverHash && prev.driverHash === driver.driverId) ||
    Boolean(prev.assignedDriverId && prev.assignedDriverId === driver.driverId);
  if (driver.companyId && prev.companyId && prev.companyId !== driver.companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Cross-company invoice');
  }
  if (!owner && prev.driverId) {
    throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
  }

  const incomingPhotos = Array.isArray(data.invoice.photos)
    ? (data.invoice.photos as unknown[])
    : [];
  const mergedPhotos = mergeDurablePhotos(prev.photos, incomingPhotos);

  const patchDoc: Record<string, unknown> = {
    photos: mergedPhotos,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (data.invoice.photoMetadata && typeof data.invoice.photoMetadata === 'object') {
    patchDoc.photoMetadata = {
      ...(prev.photoMetadata || {}),
      ...(data.invoice.photoMetadata as Record<string, unknown>),
    };
  }
  if (Array.isArray(data.invoice.photoIds)) {
    patchDoc.photoIds = Array.from(
      new Set([...(prev.photoIds || []), ...(data.invoice.photoIds as string[])]),
    );
  }

  await ref.set(patchDoc, { merge: true });

  await writeSecurityAudit({
    action: 'patchDriverInvoicePhotos',
    actorUid: driver.uid,
    driverId: driver.driverId,
    detail: {
      invoiceId,
      photoCount: mergedPhotos.length,
      idempotencyKey: data.idempotencyKey || null,
    },
  });

  return { ok: true, invoiceId, photoCount: mergedPhotos.length };
}

export const upsertDriverInvoice = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      invoiceId?: string;
      invoice?: Record<string, unknown>;
      merge?: boolean;
      driverHash?: string;
      idempotencyKey?: string;
      intent?: string;
    };
    const driverRaw = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });
    const identity = requireVerifiedDriverIdentity(driverRaw);
    if (!identity.ok) {
      throw new httpsV2.HttpsError(
        identity.error === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
        identity.error,
      );
    }
    if (!data.invoice || typeof data.invoice !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice required');
    }
    if (JSON.stringify(data.invoice).length > MAX_JSON) {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice too large');
    }
    const spoof = rejectSpoofedResourceIdentity(identity.driver, data.invoice);
    if (!spoof.ok) {
      throw new httpsV2.HttpsError('permission-denied', spoof.error);
    }
    const driver = identity.driver;

    const intent = String(data.intent || (data.invoice as any)?.intent || '').toLowerCase().trim();
    if (intent === 'photo_patch') {
      return handlePhotoPatchCore(driver, {
        invoiceId: data.invoiceId,
        invoice: data.invoice,
        driverHash: data.driverHash,
        idempotencyKey: data.idempotencyKey,
      });
    }

    const inv = { ...data.invoice };
    stripPrivilege(inv);
    inv.driverId = driver.driverId;
    inv.companyId = driver.companyId;
    assertSameCompany(driver.companyId, inv.companyId as string);
    // Keep legacy hash stamp for dual-run report joins
    if (data.driverHash) inv.driverHash = data.driverHash;
    inv.updatedAt = FieldValue.serverTimestamp();
    inv.authSource = driver.authSource;

    let invoiceId = (data.invoiceId || '').trim();
    if (!invoiceId && data.idempotencyKey) {
      invoiceId = `idem_${String(data.idempotencyKey).replace(/\//g, '_').slice(0, 80)}`;
    }

    const col = admin.firestore().collection('invoices');
    if (invoiceId) {
      const ref = col.doc(invoiceId);
      const ex = await ref.get();
      if (ex.exists) {
        const prev = ex.data() || {};
        const owner =
          Boolean(prev.driverId && prev.driverId === driver.driverId) ||
          Boolean(prev.driverHash && data.driverHash && prev.driverHash === data.driverHash) ||
          Boolean(prev.driverHash && prev.driverHash === driver.driverId);
        if (!owner && prev.driverId) {
          throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
        }
        if (driver.companyId && prev.companyId && prev.companyId !== driver.companyId) {
          throw new httpsV2.HttpsError('permission-denied', 'Cross-company invoice');
        }
        const prevStatus = String(prev.status || '').toLowerCase();
        const hasCallerStatus = 'status' in data.invoice && typeof data.invoice.status === 'string';
        const callerStatus = hasCallerStatus ? String(data.invoice.status).toLowerCase().trim() : undefined;
        const nextStatus = callerStatus || prevStatus;
        if (TERMINAL_STATUSES.has(prevStatus) && !TERMINAL_STATUSES.has(nextStatus)) {
          throw new httpsV2.HttpsError('failed-precondition', 'Cannot reopen terminal invoice');
        }
        if (hasCallerStatus && TERMINAL_STATUSES.has(nextStatus) && !TERMINAL_STATUSES.has(prevStatus)) {
          inv.closedAt = FieldValue.serverTimestamp();
        } else {
          delete inv.closedAt;
        }
        if (!hasCallerStatus) {
          delete inv.status;
        }
        if (prev.packetId) delete inv.packetId;
        if (prev.canonicalJobId) delete inv.canonicalJobId;

        // If photos provided in standard invoice mutation, merge with existing
        if (Array.isArray(inv.photos)) {
          inv.photos = mergeDurablePhotos(prev.photos, inv.photos as unknown[]);
        }

        await ref.set(inv, { merge: data.merge !== false });
      } else {
        inv.createdAt = FieldValue.serverTimestamp();
        const hasCallerStatus = 'status' in data.invoice && typeof data.invoice.status === 'string';
        const callerStatus = hasCallerStatus ? String(data.invoice.status).toLowerCase().trim() : undefined;
        if (hasCallerStatus && TERMINAL_STATUSES.has(callerStatus!)) {
          inv.closedAt = FieldValue.serverTimestamp();
        } else {
          delete inv.closedAt;
        }
        await ref.set(inv);
      }
    } else {
      inv.createdAt = FieldValue.serverTimestamp();
      const created = await col.add(inv);
      invoiceId = created.id;
    }

    await writeSecurityAudit({
      action: 'upsertDriverInvoice',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { invoiceId },
    });
    return { ok: true, invoiceId };
  },
);

export const patchDriverInvoicePhotos = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      invoiceId?: string;
      invoice?: Record<string, unknown>;
      photos?: unknown[];
      photoMetadata?: Record<string, unknown>;
      photoIds?: string[];
      driverHash?: string;
      idempotencyKey?: string;
    };
    const driverRaw = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });
    const identity = requireVerifiedDriverIdentity(driverRaw);
    if (!identity.ok) {
      throw new httpsV2.HttpsError(
        identity.error === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
        identity.error,
      );
    }
    const invoicePayload = data.invoice && typeof data.invoice === 'object'
      ? { ...data.invoice }
      : {
          photos: data.photos,
          photoMetadata: data.photoMetadata,
          photoIds: data.photoIds,
        };
    return handlePhotoPatchCore(identity.driver, {
      invoiceId: data.invoiceId,
      invoice: invoicePayload,
      driverHash: data.driverHash,
      idempotencyKey: data.idempotencyKey,
    });
  },
);

export const upsertDriverDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      dispatchId?: string;
      dispatch?: Record<string, unknown>;
      driverHash?: string;
    };
    if (!data.dispatch || typeof data.dispatch !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatch required');
    }
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });
    const d = { ...data.dispatch };
    stripPrivilege(d);
    d.driverId = driver.driverId;
    if (data.driverHash) d.driverHash = data.driverHash;
    if (driver.companyId) d.companyId = driver.companyId;
    d.updatedAt = FieldValue.serverTimestamp();

    const dispatchId = (data.dispatchId || '').trim();
    if (!dispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');
    }
    const ref = admin.firestore().collection('dispatches').doc(dispatchId);
    const ex = await ref.get();
    if (ex.exists) {
      const prev = ex.data() || {};
      const assigned =
        prev.driverId === driver.driverId ||
        prev.driverHash === data.driverHash ||
        prev.assignedDriverId === driver.driverId ||
        prev.assignedDriverHash === data.driverHash;
      // Allow create-path assignment updates only if already assigned to self or unassigned
      if (prev.driverId && !assigned && prev.driverHash && prev.driverHash !== data.driverHash) {
        throw new httpsV2.HttpsError('permission-denied', 'Dispatch assigned to another driver');
      }
    }
    await ref.set(d, { merge: true });
    await writeSecurityAudit({
      action: 'upsertDriverDispatch',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { dispatchId },
    });
    return { ok: true, dispatchId };
  },
);

export const sendChatMessage = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      threadId?: string;
      text?: string;
      senderName?: string;
      clientId?: string;
      driverHash?: string;
      companyId?: string;
    };
    const threadId = (data.threadId || '').trim();
    const text = (data.text || '').trim();
    if (!threadId || !text) {
      throw new httpsV2.HttpsError('invalid-argument', 'threadId and text required');
    }
    if (text.length > 4000) {
      throw new httpsV2.HttpsError('invalid-argument', 'message too long');
    }
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const threadRef = admin.firestore().collection('chat_threads').doc(threadId);
    const thread = await threadRef.get();
    if (!thread.exists) {
      throw new httpsV2.HttpsError('not-found', 'thread not found');
    }
    const t = thread.data() || {};
    const participants: string[] = Array.isArray(t.participantIds)
      ? t.participantIds
      : Array.isArray(t.participants)
        ? t.participants
        : [];
    const member =
      participants.includes(driver.driverId) ||
      participants.includes(data.driverHash || '') ||
      t.companyId === driver.companyId;
    if (!member && t.companyId && driver.companyId && t.companyId !== driver.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Not a thread member / wrong company');
    }

    const msgId = data.clientId
      ? `c_${String(data.clientId).replace(/\//g, '_').slice(0, 64)}`
      : undefined;
    const msg = {
      text,
      senderId: driver.driverId,
      senderName: data.senderName || driver.displayName || 'Driver',
      createdAt: FieldValue.serverTimestamp(),
      clientId: data.clientId || null,
      authSource: driver.authSource,
    };
    if (msgId) {
      const mref = threadRef.collection('messages').doc(msgId);
      const ex = await mref.get();
      if (ex.exists) {
        return { ok: true, messageId: msgId, duplicate: true };
      }
      await mref.set(msg);
      await threadRef.set(
        { lastMessageAt: FieldValue.serverTimestamp(), lastMessageText: text },
        { merge: true },
      );
      return { ok: true, messageId: msgId, duplicate: false };
    }
    const created = await threadRef.collection('messages').add(msg);
    await threadRef.set(
      { lastMessageAt: FieldValue.serverTimestamp(), lastMessageText: text },
      { merge: true },
    );
    return { ok: true, messageId: created.id, duplicate: false };
  },
);
