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
import { decideInvoiceWrite, type InvoiceUpsertMode } from './invoiceUpsertCore';

const MAX_JSON = 400_000;

function stripPrivilege(obj: Record<string, unknown>) {
  delete obj.isAdmin;
  delete obj.roles;
  delete obj.role;
  delete obj.manageDrivers;
}

export const upsertDriverInvoice = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      invoiceId?: string;
      invoice?: Record<string, unknown>;
      merge?: boolean;
      mode?: InvoiceUpsertMode;
      driverHash?: string;
      idempotencyKey?: string;
    };

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    if (!data.invoice || typeof data.invoice !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice required');
    }
    if (JSON.stringify(data.invoice).length > MAX_JSON) {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice too large');
    }

    const invoiceId = (data.invoiceId || '').trim();
    if (!invoiceId) {
      throw new httpsV2.HttpsError('invalid-argument', 'invoiceId required');
    }

    const inv = { ...data.invoice };
    stripPrivilege(inv);
    inv.driverId = driver.driverId;
    if (driver.companyId) {
      inv.companyId = driver.companyId;
      assertSameCompany(driver.companyId, inv.companyId as string);
    }
    if (data.driverHash) inv.driverHash = data.driverHash;
    inv.updatedAt = FieldValue.serverTimestamp();
    inv.authSource = driver.authSource;

    const col = admin.firestore().collection('invoices');
    const ref = col.doc(invoiceId);
    const ex = await ref.get();
    const existing = ex.exists ? (ex.data() || {}) : null;
    const mode: InvoiceUpsertMode = data.mode === 'upsert' ? 'upsert' : 'create';
    const decided = decideInvoiceWrite({
      invoiceId,
      mode,
      existing,
      driverId: driver.driverId,
      companyId: driver.companyId,
      nextStatus: typeof inv.status === 'string' ? inv.status : undefined,
      phoneSplitOperationId:
        typeof inv.phoneSplitOperationId === 'string' ? inv.phoneSplitOperationId : undefined,
    });

    if (decided.result === 'invalid') {
      throw new httpsV2.HttpsError('invalid-argument', 'invoiceId required');
    }
    if (decided.result === 'unauthorized') {
      throw new httpsV2.HttpsError('permission-denied', 'unauthorized');
    }
    if (decided.result === 'conflict') {
      throw new httpsV2.HttpsError('failed-precondition', 'conflict');
    }

    if (decided.write) {
      if (!existing) inv.createdAt = FieldValue.serverTimestamp();
      await ref.set(inv, { merge: decided.merge });
    }

    await writeSecurityAudit({
      action: 'upsertDriverInvoice',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { invoiceId, result: decided.result },
    });
    return { ok: true, invoiceId, result: decided.result };
  },
);

/** Owner-scoped invoice existence for photo recovery. Never a client getDoc. */
export const getDriverInvoice = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { invoiceId?: string; driverHash?: string };
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });
    const invoiceId = (data.invoiceId || '').trim();
    if (!invoiceId) throw new httpsV2.HttpsError('invalid-argument', 'invoiceId required');
    const snap = await admin.firestore().collection('invoices').doc(invoiceId).get();
    if (!snap.exists) return { ok: true, exists: false, invoiceId };
    const prev = snap.data() || {};
    const owner =
      prev.driverId === driver.driverId ||
      prev.driverHash === driver.driverId;
    if (!owner && prev.driverId) {
      throw new httpsV2.HttpsError('permission-denied', 'unauthorized');
    }
    if (driver.companyId && prev.companyId && prev.companyId !== driver.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'unauthorized');
    }
    const photos = Array.isArray(prev.photos) ? prev.photos : [];
    const photoIds = photos
      .map((p: any) => (p && typeof p.photoId === 'string' ? p.photoId : null))
      .filter(Boolean);
    return {
      ok: true,
      exists: true,
      invoiceId,
      companyId: prev.companyId || driver.companyId || null,
      status: prev.status || null,
      photoIds,
    };
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
