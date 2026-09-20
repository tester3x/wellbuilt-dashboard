import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from './requireDriverAuth';
import {
  ADD_SPLIT_LEG_REQUEST_KEYS,
  CHILD_DISPATCH_ID_REQUIRED,
  FUTURE_WBT_SPLIT_LEG_WIRING,
  runAddSplitLeg,
} from './operational/addSplitLeg';
import { REVISION_COLLECTION } from './operational/jobPacketRevisionStore';
import { loadAuthorizedWellNames } from './operational/dispatchPinRuntime';

function throwFail(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.reason === CHILD_DISPATCH_ID_REQUIRED
    ? `${decided.reason}:${FUTURE_WBT_SPLIT_LEG_WIRING}`
    : decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  const code = decided.reason === 'not_found' || decided.reason === 'revision_not_found' ? 'not-found'
    : decided.reason === 'other_driver' || decided.reason === 'wrong_company' ? 'permission-denied'
      : decided.reason === 'unauthenticated_driver' ? 'unauthenticated'
        : decided.reason === 'unexpected_field' || decided.reason === 'disposal_required' ? 'invalid-argument'
          : 'failed-precondition';
  throw new httpsV2.HttpsError(code, msg);
}

export const addSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!(ADD_SPLIT_LEG_REQUEST_KEYS as readonly string[]).includes(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const wells = await loadAuthorizedWellNames();
    const fs = admin.firestore();
    const outcome = await fs.runTransaction(async (tx) => {
      const decided = await runAddSplitLeg({
        caller: { driverId: driver.driverId, companyId: driver.companyId as string },
        parentDispatchId: raw.parentDispatchId,
        dispatchId: raw.dispatchId,
        callerDriverHash: raw.callerDriverHash,
        legSpec: raw.legSpec,
        authorizedWells: wells,
        getDispatch: async (id) => {
          const snap = await tx.get(fs.collection('dispatches').doc(id));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        getRevision: async (id) => {
          const snap = await tx.get(fs.collection(REVISION_COLLECTION).doc(id));
          return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
        },
        listSiblings: async (splitGroupId) => {
          const snap = await tx.get(
            fs.collection('dispatches').where('splitGroupId', '==', splitGroupId),
          );
          return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
        },
        listInvoices: async (splitGroupId) => {
          const snap = await tx.get(
            fs.collection('invoices').where('dispatchSplitGroupId', '==', splitGroupId),
          );
          return snap.docs.map((d) => ({ id: d.id }));
        },
        applyCreate: (id, data) => {
          tx.create(fs.collection('dispatches').doc(id), {
            ...data,
            assignedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
          });
        },
        applySiblingTotal: (id, total) => {
          tx.update(fs.collection('dispatches').doc(id), {
            splitTotal: total,
            updatedAt: FieldValue.serverTimestamp(),
          });
        },
        applyInvoiceTotal: (id, total) => {
          tx.update(fs.collection('invoices').doc(id), {
            dispatchSplitTotal: total,
            updatedAt: FieldValue.serverTimestamp(),
          });
        },
      });
      if (!decided.ok) throwFail(decided);
      return {
        result: decided.result,
        newDispatchId: decided.dispatchId,
        splitGroupId: decided.splitGroupId,
        splitSequence: decided.splitSequence,
        splitTotal: decided.splitTotal,
      };
    });
    return { ok: true as const, ...outcome };
  },
);
