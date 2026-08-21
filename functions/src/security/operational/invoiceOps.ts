/**
 * Secure invoice/dispatch/chat mutations. Identity comes only from Auth.
 * Existing unscoped or ownerless documents are rejected, never adopted.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver, isManagerCapability } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit } from '../rateLimit';
import { decideResourceOwnership, decideThreadMembership } from './resourceOwnership';

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
  delete obj.driverHash;
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
    };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    if (!data.invoice || typeof data.invoice !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice required');
    }
    if (Object.prototype.hasOwnProperty.call(data.invoice, 'photos')) {
      throw new httpsV2.HttpsError('permission-denied', 'photos_not_client_writable');
    }
    if (JSON.stringify(data.invoice).length > MAX_JSON) {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice too large');
    }

    const driver = await requireSecureDriver(request);
    const allowedRate = await checkRateLimit({
      bucket: 'invoice',
      key: driver.driverId,
      limit: 40,
      windowMs: 10 * 60 * 1000,
    });
    if (!allowedRate) throw new httpsV2.HttpsError('resource-exhausted', 'rate_limited');
    const manager = isManagerCapability(driver);
    const allowed = [
      'status', 'wellName', 'tankLevelFeet', 'bblsTaken', 'dateTimeUTC', 'dateTime',
      'ticketIds', 'notes', 'jobType', 'jobOrigin', 'invoicingMode', 'timezone',
    ];
    const inv: Record<string, unknown> = {};
    for (const k of allowed) {
      if (data.invoice[k] !== undefined) inv[k] = data.invoice[k];
    }
    stripPrivilege(inv);
    inv.driverId = driver.driverId;
    inv.companyId = driver.companyId;
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
        const own = decideResourceOwnership({
          callerDriverId: driver.driverId,
          callerCompanyId: driver.companyId,
          resourceDriverId: prev.driverId,
          resourceCompanyId: prev.companyId,
          isManager: manager,
        });
        if (!own.ok) throw new httpsV2.HttpsError('permission-denied', own.reason);
        const prevStatus = String(prev.status || '').toLowerCase();
        const nextStatus = String(inv.status || prevStatus).toLowerCase();
        if (TERMINAL_STATUSES.has(prevStatus) && !TERMINAL_STATUSES.has(nextStatus)) {
          throw new httpsV2.HttpsError('failed-precondition', 'Cannot reopen terminal invoice');
        }
        inv.driverId = prev.driverId;
        inv.companyId = prev.companyId;
        await ref.set(inv, { merge: data.merge !== false });
      } else {
        inv.createdAt = FieldValue.serverTimestamp();
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

export const upsertDriverDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      dispatchId?: string;
      dispatch?: Record<string, unknown>;
      driverHash?: string;
    };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    if (!data.dispatch || typeof data.dispatch !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatch required');
    }
    const driver = await requireSecureDriver(request);
    const manager = isManagerCapability(driver);
    const allowed = ['status', 'wellName', 'notes', 'assignedDriverId', 'tankLevelFeet', 'bblsTaken'];
    const d: Record<string, unknown> = {};
    for (const k of allowed) {
      if (data.dispatch[k] !== undefined) d[k] = data.dispatch[k];
    }
    if (!manager) d.driverId = driver.driverId;
    d.companyId = driver.companyId;
    d.updatedAt = FieldValue.serverTimestamp();

    const dispatchId = (data.dispatchId || '').trim();
    if (!dispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');
    }
    const ref = admin.firestore().collection('dispatches').doc(dispatchId);
    const ex = await ref.get();
    if (ex.exists) {
      const prev = ex.data() || {};
      const own = decideResourceOwnership({
        callerDriverId: driver.driverId,
        callerCompanyId: driver.companyId,
        resourceDriverId: prev.driverId || prev.assignedDriverId,
        resourceCompanyId: prev.companyId,
        isManager: manager,
      });
      if (!own.ok) throw new httpsV2.HttpsError('permission-denied', own.reason);
      d.companyId = prev.companyId;
      if (manager) {
        d.driverId = prev.driverId || prev.assignedDriverId || d.driverId;
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
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    const threadId = (data.threadId || '').trim();
    const text = (data.text || '').trim();
    if (!threadId || !text) {
      throw new httpsV2.HttpsError('invalid-argument', 'threadId and text required');
    }
    if (text.length > 4000) {
      throw new httpsV2.HttpsError('invalid-argument', 'message too long');
    }
    const driver = await requireSecureDriver(request);
    const manager = isManagerCapability(driver);

    const threadRef = admin.firestore().collection('chat_threads').doc(threadId);
    const thread = await threadRef.get();
    if (!thread.exists) {
      throw new httpsV2.HttpsError('not-found', 'thread not found');
    }
    const t = thread.data() || {};
    const participants: unknown = Array.isArray(t.participantIds)
      ? t.participantIds
      : Array.isArray(t.participants)
        ? t.participants
        : [];
    const member = decideThreadMembership({
      callerDriverId: driver.driverId,
      callerCompanyId: driver.companyId,
      threadCompanyId: t.companyId,
      participantIds: participants,
      isManager: manager,
    });
    if (!member.ok) throw new httpsV2.HttpsError('permission-denied', member.reason);

    const msgId = data.clientId
      ? `c_${String(data.clientId).replace(/\//g, '_').slice(0, 64)}`
      : undefined;
    const msg = {
      text,
      senderId: driver.driverId,
      senderName: driver.displayName || 'Driver',
      companyId: driver.companyId,
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
    } else {
      const created = await threadRef.collection('messages').add(msg);
      await threadRef.set(
        { lastMessageAt: FieldValue.serverTimestamp(), lastMessageText: text },
        { merge: true },
      );
      return { ok: true, messageId: created.id, duplicate: false };
    }
    await threadRef.set(
      { lastMessageAt: FieldValue.serverTimestamp(), lastMessageText: text },
      { merge: true },
    );
    return { ok: true, messageId: msgId, duplicate: false };
  },
);
