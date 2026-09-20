import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from './requireDriverAuth';
import { ACCEPT_REQUEST_KEYS, evaluateAcceptDriverDispatch } from './operational/acceptDriverDispatch';
import { DISPATCH_BINDING_KEYS } from './operational/dispatchPacketPin';

function throwFail(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  const code = decided.reason === 'not_found' ? 'not-found'
    : decided.reason === 'other_driver' || decided.reason === 'wrong_company' ? 'permission-denied'
      : decided.reason === 'unauthenticated_driver' ? 'unauthenticated'
        : 'failed-precondition';
  throw new httpsV2.HttpsError(code, msg);
}

export const acceptDriverDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!(ACCEPT_REQUEST_KEYS as readonly string[]).includes(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const fs = admin.firestore();
    const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
    const outcome = await fs.runTransaction(async (tx) => {
      const ref = fs.collection('dispatches').doc(dispatchId);
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const decided = evaluateAcceptDriverDispatch({
        dispatchId,
        caller: { driverId: driver.driverId, companyId: driver.companyId as string },
        existing,
        invoiceDocId: raw.invoiceDocId,
        invoiceNumber: raw.invoiceNumber,
        targetStatus: raw.targetStatus,
      });
      if (!decided.ok) throwFail(decided);
      if (decided.result === 'already_accepted') {
        return { result: 'already_accepted' as const, status: decided.status, dispatchId };
      }
      const patch: Record<string, unknown> = {
        status: decided.status,
        loadsCompleted: decided.loadsCompleted,
      };
      if (decided.stampAcceptedAt) patch.acceptedAt = FieldValue.serverTimestamp();
      if (decided.stampStartedAt) patch.startedAt = FieldValue.serverTimestamp();
      if (decided.invoiceDocId) patch.invoiceDocId = decided.invoiceDocId;
      if (decided.invoiceNumber) patch.invoiceNumber = decided.invoiceNumber;
      for (const key of DISPATCH_BINDING_KEYS) {
        if (key in patch) delete patch[key];
      }
      tx.update(ref, patch);
      return { result: 'accepted' as const, status: decided.status, dispatchId };
    });
    return { ok: true as const, ...outcome };
  },
);
