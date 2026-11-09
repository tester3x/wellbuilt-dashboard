import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { requireSecureDriver } from './requireDriverAuth';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from './canonicalDriverAuthority';
import {
  loadVerifiedRevisionFromData,
  parseDispatchId,
  parsePacketRef,
  requireCompleteBinding,
  verifyDispatchPinsAgainstEnvelope,
} from './operational/dispatchPacketPin';
import { REVISION_COLLECTION, revisionDocId } from './operational/jobPacketRevisionStore';
import {
  pickupJobType,
  pickupJobTypeFields,
  pickupTypeCorrectionState,
} from './operational/pickupJobTypeCorrection';

/** Reclassify a single open pickup before the phone runs the new Depart gates. */
export const correctPickupJobType = onCall({ timeoutSeconds: 30, memory: '256MiB' }, async request => {
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  if (request.auth?.token.app !== 'wbt' || !driver.companyId) {
    throw new HttpsError('permission-denied', 'A company-scoped Tickets session is required.');
  }
  const companyId = driver.companyId;
  const authority = await loadCanonicalDriverAuthority(driver.driverId, productionCanonicalDriverReaders());
  if (!authority?.active || authority.companyId !== companyId) {
    throw new HttpsError('permission-denied', 'The driver’s company assignment changed.');
  }
  const raw = (request.data || {}) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['dispatchId', 'invoiceDocId', 'from', 'to'].includes(key))) {
    throw new HttpsError('invalid-argument', 'Unexpected job correction fields.');
  }
  const dispatchId = parseDispatchId(raw.dispatchId);
  const invoiceId = parseDispatchId(raw.invoiceDocId);
  const from = pickupJobType(raw.from);
  const to = pickupJobType(raw.to);
  if (!dispatchId.ok || !invoiceId.ok || !from || !to || from === to) {
    throw new HttpsError('invalid-argument', 'Choose a different supported job type.');
  }
  const fs = admin.firestore();
  const dispatchRef = fs.collection('dispatches').doc(dispatchId.dispatchId);
  const invoiceRef = fs.collection('invoices').doc(invoiceId.dispatchId);
  const patch = pickupJobTypeFields(to);
  await fs.runTransaction(async tx => {
    const [dispatchSnap, invoiceSnap] = await tx.getAll(dispatchRef, invoiceRef);
    const dispatch = dispatchSnap.data();
    const invoice = invoiceSnap.data();
    if (!dispatch || !invoice) throw new HttpsError('not-found', 'Active job is still syncing.');
    const state = pickupTypeCorrectionState({
      companyId, driverId: driver.driverId, dispatchId: dispatchRef.id, dispatch, invoice, from, to,
    });
    if (state === 'owner_mismatch') throw new HttpsError('permission-denied', 'This job belongs to another driver or company.');
    if (state === 'pickup_locked') throw new HttpsError('failed-precondition', 'The job type can only change on a single pickup before a pull is sent.');
    if (state === 'type_changed') throw new HttpsError('failed-precondition', 'Job type changed. Reopen the job before departing.');
    const binding = requireCompleteBinding(dispatch);
    if (!binding.ok || binding.binding.packageId !== 'water-hauling') {
      throw new HttpsError('failed-precondition', 'The job has no verified water-hauling rules.');
    }
    const selector = parsePacketRef({ packageId: binding.binding.packageId, revision: binding.binding.packetRevision });
    if (!selector.ok) throw new HttpsError('failed-precondition', 'The job rules are invalid.');
    const revId = revisionDocId(companyId, selector.packetRef.packageId, selector.packetRef.revision);
    const revision = await tx.get(fs.collection(REVISION_COLLECTION).doc(revId));
    const verified = await loadVerifiedRevisionFromData(revision.exists, revision.data(), companyId, selector.packetRef);
    if (!verified.ok || !verifyDispatchPinsAgainstEnvelope(dispatch, verified.envelope, companyId).ok
      || !verifyDispatchPinsAgainstEnvelope({ ...dispatch, ...patch }, verified.envelope, companyId).ok) {
      throw new HttpsError('failed-precondition', 'The selected type is unavailable in this job’s rules.');
    }
    if (state === 'already_applied') return;
    const correction = { from, to, by: driver.uid, at: FieldValue.serverTimestamp() };
    tx.update(dispatchRef, {
      jobType: patch.jobType, jobTypeId: patch.jobTypeId, serviceType: patch.serviceType,
      subjob: patch.subjob, pickupJobTypeCorrection: correction, updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(invoiceRef, { ...patch, pickupJobTypeCorrection: correction, updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true as const, ...patch };
});
