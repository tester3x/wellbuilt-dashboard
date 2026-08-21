/**
 * dismissDispatch — staff/platform terminal dismiss of declined/cancelled jobs.
 * Client Firestore writes to dispatches/ are denied. This is the write path.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAdminAuthority } from './adminAuth';
import { staffHasCapability } from './canonicalAdminAuthority';
import { writeSecurityAudit } from './audit';
import {
  evaluateDismissDispatch,
  type DispatchDismissView,
} from './operational/dismissDispatch';

const ALLOWED_KEYS = new Set(['dispatchId']);
const CAPABILITY = 'createDispatch';

const PRECONDITION = new Set([
  'unknown_dispatch',
  'unscoped_dispatch',
  'cross_company',
  'job_in_progress',
  'not_dismissable',
  'family_in_progress',
  'missing_capability',
]);

function viewFromSnap(
  id: string,
  data: Record<string, unknown> | undefined,
): DispatchDismissView {
  const d = data || {};
  return {
    id,
    status: d.status,
    companyId: d.companyId,
    splitGroupId: d.splitGroupId,
    declinedAt: d.declinedAt,
    declinedBy: d.declinedBy,
    declineReason: d.declineReason,
    dismissedAt: d.dismissedAt,
    dismissedBy: d.dismissedBy,
  };
}

export const dismissDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const authority = await requireAdminAuthority(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const isPlatform = authority.class === 'platform';
    if (!isPlatform && !staffHasCapability(authority, CAPABILITY)) {
      throw new httpsV2.HttpsError('permission-denied', 'missing_capability');
    }

    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
    if (!dispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');
    }

    const fs = admin.firestore();
    const snap = await fs.collection('dispatches').doc(dispatchId).get();
    const job = snap.exists ? viewFromSnap(dispatchId, snap.data() as Record<string, unknown>) : null;

    let siblings: DispatchDismissView[] = [];
    const splitGroupId = job && typeof job.splitGroupId === 'string' ? job.splitGroupId.trim() : '';
    if (splitGroupId) {
      const sibSnap = await fs.collection('dispatches').where('splitGroupId', '==', splitGroupId).get();
      siblings = sibSnap.docs.map((d) => viewFromSnap(d.id, d.data() as Record<string, unknown>));
    }

    const decided = evaluateDismissDispatch({
      job,
      siblings,
      callerCompanyId: authority.companyId || undefined,
      isPlatformAdmin: isPlatform,
    });

    await writeSecurityAudit({
      action: 'dismissDispatch',
      actorUid: authority.uid,
      detail: {
        dispatchId,
        outcome: decided.ok ? `ok:n=${decided.dispatchIds.length}:idempotent=${decided.idempotent}` : `refused:${decided.reason}`,
      },
    });

    if (!decided.ok) {
      throw new httpsV2.HttpsError(
        PRECONDITION.has(decided.reason) ? 'failed-precondition' : 'internal',
        decided.reason,
      );
    }

    if (!decided.idempotent) {
      const batch = fs.batch();
      for (const id of decided.dispatchIds) {
        batch.update(fs.collection('dispatches').doc(id), {
          status: 'dismissed',
          dismissedAt: FieldValue.serverTimestamp(),
          dismissedBy: authority.uid,
        });
      }
      await batch.commit();
    }

    return {
      ok: true as const,
      idempotent: decided.idempotent,
      dispatchIds: decided.dispatchIds,
    };
  },
);
