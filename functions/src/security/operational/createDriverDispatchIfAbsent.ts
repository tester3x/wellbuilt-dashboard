/**
 * Dedicated driver self-create callable.
 *
 * Not the deployed merge-upsert `upsertDriverDispatch`. Transactional
 * create-if-absent with auth-derived driverId/companyId and an allowlist.
 * Driver claims only — no legacy hash. Do not deploy from this batch.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { evaluateDriverDispatchCreate } from './driverDispatchCreateCore';

export const createDriverDispatchIfAbsent = httpsV2.onCall(
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
      record?: unknown;
      companyId?: unknown;
    };
    // Caller-selected company is ignored. Tenancy is auth-only.
    void data.companyId;

    const dispatchId = typeof data.dispatchId === 'string' ? data.dispatchId.trim() : '';
    const record = data.record && typeof data.record === 'object' && !Array.isArray(data.record)
      ? (data.record as Record<string, unknown>)
      : {};

    const db = admin.firestore();
    const ref = db.collection('dispatches').doc(dispatchId || '_invalid');

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const decided = evaluateDriverDispatchCreate({
        dispatchId,
        caller,
        existing,
        record,
      });
      if (!decided.ok) {
        const code = decided.reason === 'conflict' ? 'already-exists' : 'failed-precondition';
        throw new httpsV2.HttpsError(code, decided.reason);
      }
      if (decided.result === 'already_exists') {
        return { result: 'already_exists' as const, dispatchId };
      }
      tx.create(ref, {
        ...decided.fields,
        assignedAt: FieldValue.serverTimestamp(),
      });
      return { result: 'created' as const, dispatchId };
    });

    return { ok: true, ...outcome };
  },
);
