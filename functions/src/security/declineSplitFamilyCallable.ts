import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './requireDriverAuth';
import { planSplitFamilyDecline } from './operational/declineSplitFamilyPlan';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Decline every pending leg of one unstarted split assignment atomically. */
export const declineSplitFamily = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const input = (request.data || {}) as Record<string, unknown>;
    if (Object.keys(input).some(key => !['splitGroupId', 'reason'].includes(key))) {
      throw new httpsV2.HttpsError('invalid-argument', 'unexpected_field');
    }
    const splitGroupId = text(input.splitGroupId);
    if (!splitGroupId || splitGroupId.length > 128) {
      throw new httpsV2.HttpsError('invalid-argument', 'split_group_id_required');
    }
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const reason = text(input.reason).slice(0, 200);
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    return db.runTransaction(async tx => {
      const familySnap = await tx.get(db.collection('dispatches').where('splitGroupId', '==', splitGroupId));
      if (familySnap.empty) throw new httpsV2.HttpsError('not-found', 'split_family_not_found');
      const family = familySnap.docs.map(doc => ({ ref: doc.ref, id: doc.id, data: doc.data() as Record<string, unknown> }));
      if (family.some(leg => text(leg.data.driverId) !== driver.driverId || text(leg.data.companyId) !== driver.companyId)) {
        throw new httpsV2.HttpsError('permission-denied', 'family_owner_mismatch');
      }
      const plan = planSplitFamilyDecline(family.map(leg => ({
        id: leg.id, status: text(leg.data.status), splitSequence: Number(leg.data.splitSequence),
      })));
      if (!plan.ok) throw new httpsV2.HttpsError('failed-precondition', plan.reason);
      // Pending dispatches should not have open invoices, but check the
      // persisted work before cancelling the entire family.
      const invoiceSnap = await tx.get(db.collection('invoices').where('dispatchSplitGroupId', '==', splitGroupId));
      if (invoiceSnap.docs.some(doc => !['closed', 'cancelled', 'void'].includes(text(doc.data().status)))) {
        throw new httpsV2.HttpsError('failed-precondition', 'family_has_open_invoice');
      }
      for (const leg of family.filter(item => plan.declineIds.includes(item.id))) {
        tx.update(leg.ref, {
          status: 'declined', declinedAt: now,
          declineReason: reason || 'Split family declined by driver',
          declinedBy: driver.displayName || driver.driverId,
          splitFamilyDeclined: true, updatedAt: now,
        });
      }
      return { ok: true, splitGroupId, declinedIds: plan.declineIds };
    });
  },
);
