import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from './requireDriverAuth';
import { ACCEPT_REQUEST_KEYS, runAcceptDriverDispatch } from './operational/acceptDriverDispatch';
import { DISPATCH_BINDING_KEYS } from './operational/dispatchPacketPin';
import { REVISION_COLLECTION } from './operational/jobPacketRevisionStore';

function throwFail(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  const code = decided.reason === 'not_found' || decided.reason === 'revision_not_found' ? 'not-found'
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
    const outcome = await fs.runTransaction(async (tx) => {
      const decided = await runAcceptDriverDispatch({
        dispatchId: raw.dispatchId,
        caller: { driverId: driver.driverId, companyId: driver.companyId as string },
        invoiceDocId: raw.invoiceDocId,
        invoiceNumber: raw.invoiceNumber,
        targetStatus: raw.targetStatus,
        getDispatch: async (id) => {
          const snap = await tx.get(fs.collection('dispatches').doc(id));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        getRevision: async (id) => {
          const snap = await tx.get(fs.collection(REVISION_COLLECTION).doc(id));
          return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
        },
        applyUpdate: (id, patch) => {
          const mapped: Record<string, unknown> = { ...patch };
          if (mapped.acceptedAt === true) mapped.acceptedAt = FieldValue.serverTimestamp();
          if (mapped.startedAt === true) mapped.startedAt = FieldValue.serverTimestamp();
          for (const key of DISPATCH_BINDING_KEYS) {
            delete mapped[key];
          }
          delete mapped.companyId;
          delete mapped.driverId;
          delete mapped.jobType;
          delete mapped.wellName;
          delete mapped.ndicWellName;
          tx.update(fs.collection('dispatches').doc(id), mapped);
        },
      });
      if (!decided.ok) throwFail(decided);
      return {
        result: decided.result,
        status: decided.status,
        dispatchId: decided.dispatchId,
      };
    });
    return { ok: true as const, ...outcome };
  },
);
