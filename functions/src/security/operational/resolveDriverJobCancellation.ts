import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { splitCancellationPlan } from './ticketWaterCustody';

/** Cancellation is a transaction, separate from informational stage upserts.
 * Never deletes pull packets, tickets, well history, or assignment ownership. */
export const resolveDriverJobCancellation = https.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const { dispatchId, invoiceDocId, action, reason = '' } = request.data || {};
    if (typeof dispatchId !== 'string' || !dispatchId || dispatchId.includes('/')
      || !['cancel', 'cancel_split', 'cancel_or_cycle', 'return_pending', 'decline'].includes(action)
      || typeof reason !== 'string' || reason.length > 2000
      || (invoiceDocId !== undefined && (typeof invoiceDocId !== 'string' || invoiceDocId.includes('/')))) {
      throw new https.HttpsError('invalid-argument', 'Invalid cancellation request');
    }
    const db = admin.firestore();
    return db.runTransaction(async tx => {
      const ref = db.collection('dispatches').doc(dispatchId);
      const snap = await tx.get(ref);
      // Admin removal is terminal. Never recreate an absent job on late replay.
      if (!snap.exists) return { ok: true, result: 'removed' };
      const job = snap.data()!;
      if (!driver.companyId || job.companyId !== driver.companyId || job.driverId !== driver.driverId) {
        throw new https.HttpsError('permission-denied', 'Cancellation ownership mismatch');
      }
      if (['completed', 'cancelled', 'declined', 'dismissed'].includes(job.status)) {
        const receipt = job.splitCancellationCarry;
        if (receipt?.nextDispatchId) {
          const next = (await tx.get(db.collection('dispatches').doc(receipt.nextDispatchId))).data();
          // Retry may restore an unconsumed handoff, never rewind a stop that
          // has since started/completed or received a different bucket.
          if (next?.companyId === driver.companyId && next?.driverId === driver.driverId
            && next.status === 'pending' && next.splitCancellationSourceDispatchId === dispatchId
            && next.inheritedBbls === receipt.remainingBbls) {
            return {ok:true, result:job.status, splitCancellationCarry:receipt};
          }
        }
        return { ok: true, result: job.status };
      }
      if (invoiceDocId && job.invoiceDocId && invoiceDocId !== job.invoiceDocId) {
        throw new https.HttpsError('failed-precondition', 'Cancellation belongs to an earlier invoice');
      }
      if (action === 'cancel_split' && (!job.splitGroupId || !(Number(job.splitSequence) >= 2))) {
        throw new https.HttpsError('failed-precondition', 'Not a continuation split');
      }
      if (action === 'decline' && job.status !== 'pending') {
        throw new https.HttpsError('failed-precondition', 'Only pending jobs may be declined');
      }
      if (action === 'return_pending' && job.status === 'pending') return { ok: true, result: 'pending' };
      const linkedId = typeof job.invoiceDocId === 'string' ? job.invoiceDocId : '';
      const invRef = linkedId ? db.collection('invoices').doc(linkedId) : null;
      const invSnap = invRef ? await tx.get(invRef) : null;
      const inv = invSnap?.data();
      if (inv && (inv.companyId !== driver.companyId || inv.dispatchId !== dispatchId)) {
        throw new https.HttpsError('failed-precondition', 'Invoice linkage mismatch');
      }
      let splitPlan: ReturnType<typeof splitCancellationPlan> | undefined;
      if (job.splitGroupId && Number(job.splitSequence) >= 2) {
        const family = await tx.get(db.collection('dispatches')
          .where('companyId', '==', driver.companyId).where('driverId', '==', driver.driverId)
          .where('splitGroupId', '==', job.splitGroupId));
        splitPlan = splitCancellationPlan(job, family.docs.map(doc => ({...doc.data(),id:doc.id})), inv);
        if (splitPlan.kind === 'divert' || splitPlan.kind === 'unverified') {
          throw new https.HttpsError('failed-precondition', splitPlan.kind === 'divert'
            ? 'The last split still holds water. Choose where to deliver or transfer it.'
            : 'The split water balance could not be verified. The job has been retained.');
        }
        if (action === 'return_pending' || action === 'cancel_or_cycle') {
          throw new https.HttpsError('failed-precondition', 'Use split cancellation to release its allocation.');
        }
      }
      // Loaded water must finish through completion/transfer/correction, not cancel.
      if (job.status !== 'pending' && ((!inv && job.lastPullPacketId) || (Number(inv?.totalBBL) > 0 && splitPlan?.kind !== 'release')
        || (Array.isArray(inv?.tickets) && inv.tickets.length > 0) || inv?.transferSourceDocId)) {
        throw new https.HttpsError('failed-precondition', 'Loaded job cannot be cancelled');
      }
      if (action === 'return_pending' && job.status === 'pending' && !linkedId) {
        return { ok: true, result: 'pending' };
      }
      const cycle = action === 'cancel_or_cycle' && Number(job.loadCount || 1) > Number(job.loadsCompleted || 0);
      const pending = action === 'return_pending' || cycle;
      const status = pending ? 'pending' : action === 'decline' ? 'declined' : 'cancelled';
      const patch: Record<string, unknown> = {
        status, updatedAt: FieldValue.serverTimestamp(),
        cancelReason: reason, declineReason: reason,
        declinedBy: driver.displayName || job.driverFirstName || job.driverName || 'Driver', declinedAt: Date.now(),
        driverStage: FieldValue.delete(), driverDest: FieldValue.delete(),
        stageUpdatedAt: FieldValue.delete(), driverLat: FieldValue.delete(),
        driverLng: FieldValue.delete(), driverGpsAt: FieldValue.delete(),
      };
      if (splitPlan?.kind === 'release') {
        // The carry is the entire bucket BEFORE this unsent allocation. Do not
        // add the released allocation again or manufacture a second pickup.
        const {kind: _kind, ...receipt} = splitPlan;
        patch.splitCancellationCarry = receipt;
        tx.update(db.collection('dispatches').doc(receipt.nextDispatchId), {
          inheritedBbls:receipt.remainingBbls,
          splitCancellationSourceDispatchId:dispatchId,
        });
      }
      if (pending) {
        patch.invoiceDocId = FieldValue.delete();
        patch.invoiceNumber = FieldValue.delete();
        patch.acceptedAt = FieldValue.delete();
        patch.startedAt = FieldValue.delete();
        patch.loadsCompleted = Math.max(0, Number(job.loadsCompleted || 0) - (cycle ? 0 : 1));
      } else patch.cancelledAt = Date.now();
      if (invRef && invSnap?.exists && inv?.status === 'open') tx.update(invRef, {
        status: 'cancelled', driverState: 'idle', cancelReason: reason,
        cancelledAt: FieldValue.serverTimestamp(),
      });
      tx.update(ref, patch);
      return { ok: true, result: status, ...(patch.splitCancellationCarry ? {splitCancellationCarry:patch.splitCancellationCarry} : {}) };
    });
  });
