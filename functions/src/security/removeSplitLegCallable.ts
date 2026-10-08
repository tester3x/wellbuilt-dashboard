import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './requireDriverAuth';
import { planSplitLegRemoval } from './operational/removeSplitLegPlan';

const name = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Remove one pending split stop, preserving the route to the next stop. */
export const removeSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const input = (request.data || {}) as Record<string, unknown>;
    if (Object.keys(input).some(key => !['legDispatchId', 'callerDriverHash', 'reason'].includes(key))) {
      throw new httpsV2.HttpsError('invalid-argument', 'unexpected_field');
    }
    const legDispatchId = name(input.legDispatchId);
    if (!legDispatchId || legDispatchId.includes('/')) {
      throw new httpsV2.HttpsError('invalid-argument', 'leg_dispatch_id_required');
    }
    const driver = await requireSecureDriver(request, {
      legacyDriverHash: name(input.callerDriverHash),
    });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const db = admin.firestore();
    const dispatches = db.collection('dispatches');
    const invoices = db.collection('invoices');
    const now = admin.firestore.Timestamp.now();
    const result = await db.runTransaction(async tx => {
      const targetRef = dispatches.doc(legDispatchId);
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) throw new httpsV2.HttpsError('not-found', 'leg_not_found');
      const target = targetSnap.data() as Record<string, unknown>;
      const splitGroupId = name(target.splitGroupId);
      if (!splitGroupId) throw new httpsV2.HttpsError('failed-precondition', 'not_split_family');
      if (name(target.driverId) !== driver.driverId || name(target.companyId) !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'job_owner_mismatch');
      }
      const familySnap = await tx.get(dispatches.where('splitGroupId', '==', splitGroupId));
      const family = familySnap.docs.map(doc => ({ id: doc.id, ref: doc.ref, data: doc.data() as Record<string, unknown> }));
      if (family.some(leg => name(leg.data.driverId) !== driver.driverId || name(leg.data.companyId) !== driver.companyId)) {
        throw new httpsV2.HttpsError('permission-denied', 'family_owner_mismatch');
      }
      const plan = planSplitLegRemoval(family.map(leg => ({
        id: leg.id,
        splitSequence: Number(leg.data.splitSequence),
        status: name(leg.data.status),
        wellName: name(leg.data.wellName),
        ndicWellName: name(leg.data.ndicWellName),
      })), legDispatchId);
      if (!plan.ok) throw new httpsV2.HttpsError('failed-precondition', plan.reason);

      const invoiceSnap = await tx.get(invoices.where('dispatchSplitGroupId', '==', splitGroupId));
      const invoiceDocs = invoiceSnap.docs.map(doc => ({ ref: doc.ref, data: doc.data() as Record<string, unknown> }));
      // A may still have an invoice even when its dispatch is pending. Never
      // silently redirect an invoice that already recorded job progress.
      if (plan.rerouteAnchor) {
        const anchorInvoices = invoiceDocs.filter(doc => name(doc.data.dispatchId) === plan.rerouteAnchor?.id);
        if (anchorInvoices.some(doc => {
          const timeline = doc.data.timeline;
          return name(doc.data.status) === 'closed' ||
            (Array.isArray(timeline) && timeline.some(event =>
              event && typeof event === 'object' && ['depart_site', 'arrive_dropoff'].includes(name((event as Record<string, unknown>).type))));
        })) throw new httpsV2.HttpsError('failed-precondition', 'anchor_already_started');
      }

      const reason = name(input.reason).slice(0, 200);
      tx.update(targetRef, {
        status: 'cancelled', cancelledAt: now, declinedAt: now,
        cancelReason: reason || 'Split leg removed (planning cleanup)',
        splitLegRemoved: true, splitRemoveReason: reason || null,
        splitRemovedAt: now, splitRemovedBy: driver.driverId, updatedAt: now,
      });
      for (const entry of plan.order) {
        const update: Record<string, unknown> = {
          splitSequence: entry.splitSequence, splitTotal: plan.order.length, updatedAt: now,
        };
        if (entry.id === plan.rerouteAnchor?.id) {
          update.disposal = plan.rerouteAnchor.destination;
          update.disposalName = plan.rerouteAnchor.destination;
          update.disposalLat = null;
          update.disposalLng = null;
          update.destinationType = null;
        }
        tx.update(dispatches.doc(entry.id), update);
      }
      const sequenceById = new Map(plan.order.map(entry => [entry.id, entry.splitSequence]));
      for (const invoice of invoiceDocs) {
        const dispatchId = name(invoice.data.dispatchId);
        if (!sequenceById.has(dispatchId)) continue;
        const update: Record<string, unknown> = {
          dispatchSplitSequence: sequenceById.get(dispatchId),
          dispatchSplitTotal: plan.order.length, updatedAt: now,
        };
        if (dispatchId === plan.rerouteAnchor?.id) {
          update.hauledTo = plan.rerouteAnchor.destination;
          update.hauledToLat = null;
          update.hauledToLng = null;
        }
        tx.update(invoice.ref, update);
      }
      return { splitGroupId, removedId: legDispatchId, newTotal: plan.order.length, order: plan.order };
    });
    return result;
  },
);
