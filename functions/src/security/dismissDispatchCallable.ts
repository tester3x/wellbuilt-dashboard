import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers } from './adminAuth';
import {
  evaluateDismissDispatch,
  type DispatchDismissView,
} from './operational/dismissDispatch';

const ALLOWED_KEYS = new Set(['dispatchId']);

function viewFromSnap(id: string, data: Record<string, unknown> | undefined): DispatchDismissView {
  const d = data || {};
  return { id, status: d.status, companyId: d.companyId, splitGroupId: d.splitGroupId };
}

export const dismissDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
    if (!dispatchId) throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');

    const fs = admin.firestore();
    const outcome = await fs.runTransaction(async (tx) => {
      const jobRef = fs.collection('dispatches').doc(dispatchId);
      const snap = await tx.get(jobRef);
      const job = snap.exists ? viewFromSnap(dispatchId, snap.data() as Record<string, unknown>) : null;
      let siblings: DispatchDismissView[] = [];
      const splitGroupId = job && typeof job.splitGroupId === 'string' ? job.splitGroupId.trim() : '';
      if (splitGroupId) {
        const sibSnap = await tx.get(
          fs.collection('dispatches').where('splitGroupId', '==', splitGroupId),
        );
        siblings = sibSnap.docs.map((d) => viewFromSnap(d.id, d.data() as Record<string, unknown>));
      }
      const decided = evaluateDismissDispatch({
        job,
        siblings,
        callerCompanyId: caller.companyId,
        isPlatformAdmin: caller.isPlatformAdmin,
      });
      if (!decided.ok) {
        throw new httpsV2.HttpsError('failed-precondition', decided.reason);
      }
      if (!decided.idempotent) {
        for (const id of decided.dispatchIds) {
          tx.update(fs.collection('dispatches').doc(id), {
            status: 'dismissed',
            dismissedAt: FieldValue.serverTimestamp(),
            dismissedBy: caller.uid,
          });
        }
      }
      return { idempotent: decided.idempotent, dispatchIds: decided.dispatchIds };
    });

    return { ok: true as const, ...outcome };
  },
);
