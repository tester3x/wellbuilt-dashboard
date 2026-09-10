/**
 * Dedicated driver accept/start callable.
 *
 * Not upsertDriverDispatch. Transactional pending|paused → accepted|in_progress
 * with auth-derived driverId/companyId. Idempotent retry. No legacy hash.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { evaluateAcceptDriverDispatch } from './acceptDriverDispatchCore';

export const acceptDriverDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.driverId) {
      throw new httpsV2.HttpsError('unauthenticated', 'Driver authentication required');
    }
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'unauthenticated_driver');
    }
    const caller = { driverId: driver.driverId, companyId: driver.companyId };

    const data = (request.data || {}) as {
      dispatchId?: unknown;
      invoiceDocId?: unknown;
      invoiceNumber?: unknown;
      targetStatus?: unknown;
      companyId?: unknown;
    };
    void data.companyId;

    const dispatchId = typeof data.dispatchId === 'string' ? data.dispatchId.trim() : '';
    const ref = admin.firestore().collection('dispatches').doc(dispatchId || '_invalid');

    const outcome = await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const decided = evaluateAcceptDriverDispatch({
        dispatchId,
        caller,
        existing,
        invoiceDocId: data.invoiceDocId,
        invoiceNumber: data.invoiceNumber,
        targetStatus: data.targetStatus,
      });
      if (!decided.ok) {
        const denied = decided.reason === 'other_driver' || decided.reason === 'wrong_company';
        throw new httpsV2.HttpsError(
          denied ? 'permission-denied' : decided.reason === 'not_found' ? 'not-found' : 'failed-precondition',
          decided.reason,
        );
      }
      if (decided.result === 'already_accepted' && !decided.invoiceDocId && !decided.stampStartedAt) {
        return { result: 'already_accepted' as const, dispatchId, status: decided.status };
      }
      const patch: Record<string, unknown> = {
        status: decided.status,
        loadsCompleted: decided.loadsCompleted,
      };
      if (decided.stampAcceptedAt) patch.acceptedAt = FieldValue.serverTimestamp();
      if (decided.stampStartedAt) patch.startedAt = FieldValue.serverTimestamp();
      if (decided.stampDriverId) patch.driverId = caller.driverId;
      if (decided.invoiceDocId) patch.invoiceDocId = decided.invoiceDocId;
      if (decided.invoiceNumber) patch.invoiceNumber = decided.invoiceNumber;
      tx.update(ref, patch);
      return { result: decided.result, dispatchId, status: decided.status };
    });

    return { ok: true, ...outcome };
  },
);
