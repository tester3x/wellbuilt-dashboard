import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './requireDriverAuth';
import { REVISION_COLLECTION } from './operational/jobPacketRevisionStore';
import {
  parseResolveExecutionBindingRequest,
  runResolveExecutionBinding,
} from './operational/resolveExecutionBinding';

function throwFail(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  if (decided.reason === 'unauthenticated_driver' || decided.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    decided.reason === 'other_driver'
    || decided.reason === 'wrong_company'
    || decided.reason === 'caller_authority_field'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (decided.reason === 'not_found' || decided.reason === 'revision_not_found') {
    throw new httpsV2.HttpsError('not-found', msg);
  }
  if (
    decided.reason === 'unknown_field'
    || decided.reason === 'record_must_be_object'
    || decided.reason === 'dispatch_id_required'
    || decided.reason === 'invalid_format'
    || decided.reason === 'malformed_dispatch_id'
  ) {
    throw new httpsV2.HttpsError('invalid-argument', msg);
  }
  throw new httpsV2.HttpsError('failed-precondition', msg);
}

export const resolveExecutionBinding = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const parsed = parseResolveExecutionBindingRequest(request.data);
    if (!parsed.ok) throwFail(parsed);
    const fs = admin.firestore();
    const outcome = await runResolveExecutionBinding({
      jobId: parsed.jobId,
      caller: { driverId: driver.driverId, companyId: driver.companyId },
      getDispatch: async (id) => {
        const snap = await fs.collection('dispatches').doc(id).get();
        return snap.exists ? (snap.data() as Record<string, unknown>) : null;
      },
      getRevision: async (id) => {
        const snap = await fs.collection(REVISION_COLLECTION).doc(id).get();
        return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
      },
    });
    if (!outcome.ok) throwFail(outcome);
    return {
      ok: true as const,
      jobId: outcome.jobId,
      companyId: outcome.companyId,
      driverId: outcome.driverId,
      binding: outcome.binding,
      execution: outcome.execution,
      definition: outcome.definition,
      implementedEffects: outcome.implementedEffects,
    };
  },
);
