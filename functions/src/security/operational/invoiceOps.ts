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
import { evaluateExistingDispatchDriverUpdate } from './dispatchPacketPin';
import { evaluateSplitLoadBudget } from './splitLoadBudget';
import { mergeInvoicePhotoEvidence } from './invoicePhotoEvidence';

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
    if (!data.invoice || typeof data.invoice !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice required');
    }
    if (JSON.stringify(data.invoice).length > MAX_JSON) {
      throw new httpsV2.HttpsError('invalid-argument', 'invoice too large');
    }

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const inv = { ...data.invoice };
    stripPrivilege(inv);
    inv.driverId = driver.driverId;
    if (driver.companyId) {
      inv.companyId = driver.companyId;
      assertSameCompany(driver.companyId, inv.companyId as string);
    }
    // Keep legacy hash stamp for dual-run report joins
    if (data.driverHash) inv.driverHash = data.driverHash;
    inv.updatedAt = FieldValue.serverTimestamp();
    inv.authSource = driver.authSource;

    let invoiceId = (data.invoiceId || '').trim();
    if (!invoiceId && data.idempotencyKey) {
      invoiceId = `idem_${String(data.idempotencyKey).replace(/\//g, '_').slice(0, 80)}`;
    }

    const col = admin.firestore().collection('invoices');
    const ref = invoiceId ? col.doc(invoiceId) : col.doc();
    invoiceId = ref.id;
    await admin.firestore().runTransaction(async tx => {
      const ex = await tx.get(ref);
      const prev = ex.exists ? ex.data() || {} : {};
      if (prev.dispatchSplitGroupId && prev.dispatchId) {
        if (inv.dispatchId !== undefined && inv.dispatchId !== prev.dispatchId) {
          throw new httpsV2.HttpsError('failed-precondition', 'split_invoice_identity_conflict');
        }
        inv.dispatchId = prev.dispatchId;
        if (inv.status === undefined) inv.status = prev.status;
      }
      if (ex.exists) {
        const owner =
          prev.driverId === driver.driverId ||
          prev.driverHash === data.driverHash ||
          prev.driverHash === driver.driverId;
        if (!owner && prev.driverId) {
          throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
        }
        if (driver.companyId && prev.companyId && prev.companyId !== driver.companyId) {
          throw new httpsV2.HttpsError('permission-denied', 'Cross-company invoice');
        }
        const prevStatus = String(prev.status || '').toLowerCase();
        const nextStatus = String(inv.status || prevStatus).toLowerCase();
        if (TERMINAL_STATUSES.has(prevStatus) && !TERMINAL_STATUSES.has(nextStatus)) {
          throw new httpsV2.HttpsError('failed-precondition', 'Cannot reopen terminal invoice');
        }
      }
      const merged = data.merge === false ? { ...inv } : { ...prev, ...inv };
      if (['closed', 'complete', 'completed'].includes(String(merged.status || '').toLowerCase()) && merged.dispatchId) {
        const dispatch = await tx.get(admin.firestore().collection('dispatches').doc(String(merged.dispatchId)));
        const job = dispatch.data();
        if (job?.splitGroupId) {
          if (job.companyId !== driver.companyId || job.driverId !== driver.driverId) {
            throw new httpsV2.HttpsError('permission-denied', 'Split belongs to another driver or company');
          }
          const group = String(job.splitGroupId);
          const family = await tx.get(admin.firestore().collection('dispatches').where('splitGroupId', '==', group));
          if (family.docs.some(row => row.data().companyId !== driver.companyId || row.data().driverId !== driver.driverId)) {
            throw new httpsV2.HttpsError('failed-precondition', 'split_family_identity_conflict');
          }
          const anchors = family.docs.filter(row => row.data().splitSequence === 1);
          if (anchors.length !== 1) throw new httpsV2.HttpsError('failed-precondition', 'split_anchor_missing');
          const ledgerRef = admin.firestore().collection('split_load_ledgers').doc(group);
          // Shared read/write serializes closes of different invoices too.
          await tx.get(ledgerRef);
          const records = await tx.get(col.where('dispatchSplitGroupId', '==', group));
          if (dispatch.id === anchors[0].id && ['closed', 'complete', 'completed'].includes(String(prev.status)) &&
              Number(merged.totalBBL) !== Number(prev.totalBBL) && records.docs.some(row =>
                row.data().dispatchId !== dispatch.id && ['closed', 'complete', 'completed'].includes(String(row.data().status)))) {
            throw new httpsV2.HttpsError('failed-precondition', 'split_pickup_locked_after_delivery');
          }
          const budget = evaluateSplitLoadBudget(anchors[0].id, [
            ...records.docs.filter(row => row.id !== ref.id).map(row => ({ id: row.id, data: row.data() })),
            { id: ref.id, data: { ...merged, dispatchSplitSequence: job.splitSequence } },
          ]);
          if (!budget.ok) throw new httpsV2.HttpsError('failed-precondition', budget.reason);
          inv.dispatchSplitGroupId = group;
          inv.dispatchSplitSequence = job.splitSequence;
          const originWell = String(anchors[0].data().ndicWellName || anchors[0].data().wellName || '');
          inv.splitLoadOriginWellName = originWell;
          inv.splitPickupDispatchId = anchors[0].id;
          if (Number(job.splitSequence) >= 2 && String(job.destinationType || '').toLowerCase() === 'swd') {
            inv.wellName = originWell;
            inv.pickupWellName = originWell;
          }
          tx.set(ledgerRef, { companyId: driver.companyId, driverId: driver.driverId,
            pickupDispatchId: anchors[0].id, pickupBbls: budget.pickup,
            usedBbls: budget.used, remainingBbls: budget.remaining, updatedAt: FieldValue.serverTimestamp() });
          for (const child of family.docs) {
            if (child.data().parentDispatchId === dispatch.id && child.data().status === 'pending' &&
                typeof child.data().splitParentUsedBbls === 'number') {
              tx.update(child.ref, { bbls: budget.remaining, splitParentUsedBbls: Number(merged.totalBBL),
                updatedAt: FieldValue.serverTimestamp() });
            }
          }
        }
      }
      if (!ex.exists) inv.createdAt = FieldValue.serverTimestamp();
      if (Object.prototype.hasOwnProperty.call(inv, 'photos')) {
        inv.photos = mergeInvoicePhotoEvidence(prev.photos, inv.photos);
      }
      tx.set(ref, inv, { merge: ex.exists && data.merge !== false });
    });

    await writeSecurityAudit({
      action: 'upsertDriverInvoice',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { invoiceId },
    });
    return { ok: true, invoiceId };
  },
);

const DRIVER_DISPATCH_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  accepted: ['in_progress', 'paused', 'completed'],
  in_progress: ['paused', 'completed', 'pending'],
  paused: ['in_progress', 'completed'],
};

export const upsertDriverDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      dispatchId?: string;
      dispatch?: Record<string, unknown>;
      driverHash?: string;
    };
    if (!data.dispatch || typeof data.dispatch !== 'object' || Array.isArray(data.dispatch)) {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatch required');
    }
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: false,
    });
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    }
    const dispatchId = (data.dispatchId || '').trim();
    if (!dispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');
    }
    const firestore = admin.firestore();
    const ref = firestore.collection('dispatches').doc(dispatchId);
    const ex = await ref.get();
    const prev = ex.exists ? (ex.data() || {}) : null;
    const decided = evaluateExistingDispatchDriverUpdate({
      existing: prev,
      caller: { driverId: driver.driverId, companyId: driver.companyId },
      patch: data.dispatch,
    });
    if (!decided.ok) {
      const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
      if (decided.reason === 'cannot_create') throw new httpsV2.HttpsError('not-found', msg);
      if (decided.reason === 'wrong_company' || decided.reason === 'other_driver') {
        throw new httpsV2.HttpsError('permission-denied', msg);
      }
      throw new httpsV2.HttpsError('failed-precondition', msg);
    }
    const prevStatus = String((prev || {}).status || '').toLowerCase();
    if (TERMINAL_STATUSES.has(prevStatus)) {
      throw new httpsV2.HttpsError('failed-precondition', 'Cannot reopen terminal dispatch');
    }
    if (data.dispatch.status === 'pending') {
      const invoiceDocId = String(data.dispatch.invoiceDocId || '').trim();
      const closedInvoice = await firestore.collection('invoices').doc(invoiceDocId).get();
      const invoice = closedInvoice.data();
      if (!closedInvoice.exists || invoice?.companyId !== driver.companyId
        || invoice?.dispatchId !== dispatchId || invoice?.status !== 'closed') {
        throw new httpsV2.HttpsError('failed-precondition', 'multi_load_cycle_requires_closed_invoice');
      }
    }
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (typeof data.dispatch.notes === 'string') patch.notes = data.dispatch.notes;
    if (typeof data.dispatch.loadsCompleted === 'number' && Number.isFinite(data.dispatch.loadsCompleted)) {
      patch.loadsCompleted = Math.max(0, Math.trunc(data.dispatch.loadsCompleted));
    }
    if (typeof data.dispatch.invoiceDocId === 'string') patch.invoiceDocId = data.dispatch.invoiceDocId.trim();
    if (typeof data.dispatch.invoiceNumber === 'string') patch.invoiceNumber = data.dispatch.invoiceNumber.trim();
    if (typeof data.dispatch.driverStage === 'string') patch.driverStage = data.dispatch.driverStage;
    if (typeof data.dispatch.driverDest === 'string') patch.driverDest = data.dispatch.driverDest;
    if (typeof data.dispatch.stageUpdatedAt === 'number') patch.stageUpdatedAt = data.dispatch.stageUpdatedAt;
    if (typeof data.dispatch.driverLat === 'number' && typeof data.dispatch.driverLng === 'number' &&
      (data.dispatch.driverLat !== 0 || data.dispatch.driverLng !== 0)) {
      patch.driverLat = data.dispatch.driverLat;
      patch.driverLng = data.dispatch.driverLng;
      if (typeof data.dispatch.driverGpsAt === 'string') patch.driverGpsAt = data.dispatch.driverGpsAt;
    }
    if (typeof data.dispatch.hauledTo === 'string') patch.hauledTo = data.dispatch.hauledTo;
    if (data.dispatch.status === 'completed') {
      if (typeof data.dispatch.completedAt === 'number') patch.completedAt = data.dispatch.completedAt;
      if (typeof data.dispatch.totalBBL === 'number') patch.totalBBL = data.dispatch.totalBBL;
      if (typeof data.dispatch.ticketNumber === 'string' || typeof data.dispatch.ticketNumber === 'number') {
        patch.ticketNumber = String(data.dispatch.ticketNumber);
      }
    }
    if (typeof data.dispatch.status === 'string') {
      const next = data.dispatch.status.trim().toLowerCase();
      const allowed = DRIVER_DISPATCH_STATUS_TRANSITIONS[prevStatus] || [];
      if (next !== prevStatus && !allowed.includes(next)) {
        throw new httpsV2.HttpsError('failed-precondition', `invalid_transition:${prevStatus}->${next}`);
      }
      patch.status = next;
      if (next === 'pending') {
        // The finished leg owns its invoice and location history. The shared
        // dispatch card is now the next, unstarted load.
        patch.driverStage = FieldValue.delete();
        patch.driverDest = FieldValue.delete();
        patch.stageUpdatedAt = FieldValue.delete();
        patch.driverLat = FieldValue.delete();
        patch.driverLng = FieldValue.delete();
        patch.driverGpsAt = FieldValue.delete();
      }
    }
    delete patch.packageId;
    delete patch.packetRevision;
    delete patch.contentHash;
    delete patch.policyHash;
    delete patch.companyId;
    delete patch.driverId;
    await ref.update(patch);
    await writeSecurityAudit({
      action: 'upsertDriverDispatch',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { dispatchId, mode: 'update_only' },
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
