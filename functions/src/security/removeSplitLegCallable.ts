import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from './requireDriverAuth';
import { planSplitLegRemoval } from './operational/removeSplitLegPlan';
import { planFinalSplitStopRemoval } from './operational/finalSplitStopPlan';

const name = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Remove one pending split stop, preserving the route to the next stop. */
export const removeSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const input = (request.data || {}) as Record<string, unknown>;
    if (Object.keys(input).some(key => !['legDispatchId', 'callerDriverHash', 'reason', 'replacementDestination'].includes(key))) {
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
      const anchor = plan.lastStopAnchorId ? family.find(leg => leg.id === plan.lastStopAnchorId) : undefined;
      const anchorInvoices = anchor ? invoiceDocs.filter(doc => name(doc.data.dispatchId) === anchor.id) : [];
      let lastStopAction: 'none' | 'cancel_family' | 'convert_to_single' = 'none';
      let replacement: { name: string; latitude: number | null; longitude: number | null; destinationType: string | null } | null = null;
      if (anchor) {
        const departed = ['en_route_dropoff', 'on_site_dropoff'].includes(name(anchor.data.driverStage)) ||
          anchorInvoices.some(doc => Array.isArray(doc.data.timeline) &&
            (doc.data.timeline as Array<Record<string, unknown>>).some(event =>
              ['depart_site', 'arrive_dropoff'].includes(name(event?.type))));
        const action = planFinalSplitStopRemoval({
          anchorStatus: name(anchor.data.status),
          invoiceStatuses: anchorInvoices.map(doc => name(doc.data.status)),
          departedPickup: departed,
          hasReplacementDestination: !!input.replacementDestination,
        });
        if (!action.ok) throw new httpsV2.HttpsError('failed-precondition', action.reason);
        lastStopAction = action.action;
        if (action.action === 'convert_to_single') {
          const raw = input.replacementDestination;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new httpsV2.HttpsError('failed-precondition', 'replacement_destination_required');
          }
          const value = raw as Record<string, unknown>;
          if (Object.keys(value).some(key => !['name', 'latitude', 'longitude', 'destinationType'].includes(key))) {
            throw new httpsV2.HttpsError('invalid-argument', 'replacement_destination_invalid');
          }
          const locationName = name(value.name);
          if (!locationName || locationName.length > 200) {
            throw new httpsV2.HttpsError('invalid-argument', 'replacement_destination_name_required');
          }
          for (const key of ['latitude', 'longitude'] as const) {
            if (value[key] != null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
              throw new httpsV2.HttpsError('invalid-argument', 'replacement_destination_coordinates_invalid');
            }
          }
          replacement = {
            name: locationName,
            latitude: typeof value.latitude === 'number' ? value.latitude : null,
            longitude: typeof value.longitude === 'number' ? value.longitude : null,
            destinationType: name(value.destinationType) || null,
          };
        }
      }
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
      if (anchor && lastStopAction === 'cancel_family') {
        tx.update(anchor.ref, {
          status: 'cancelled', cancelledAt: now, declinedAt: now,
          cancelReason: 'Final split destination removed before pickup departure',
          splitFamilyCancelled: true, splitTotal: 0, updatedAt: now,
        });
        for (const invoice of anchorInvoices) {
          tx.update(invoice.ref, {
            status: 'cancelled', cancelledAt: now,
            cancelReason: 'Final split destination removed before pickup departure',
            updatedAt: now,
          });
        }
        return { splitGroupId, removedId: legDispatchId, newTotal: 0, order: [], lastStopAction };
      }
      if (anchor && lastStopAction === 'convert_to_single' && replacement) {
        tx.update(anchor.ref, {
          disposal: replacement.name, disposalName: replacement.name,
          disposalLat: replacement.latitude, disposalLng: replacement.longitude,
          destinationType: replacement.destinationType,
          splitGroupId: FieldValue.delete(), splitSequence: FieldValue.delete(),
          splitTotal: FieldValue.delete(), updatedAt: now,
        });
        tx.update(anchorInvoices[0].ref, {
          hauledTo: replacement.name, hauledToLat: replacement.latitude,
          hauledToLng: replacement.longitude,
          enRouteDestName: replacement.name, enRouteDestLat: replacement.latitude,
          enRouteDestLng: replacement.longitude,
          dispatchSplitGroupId: FieldValue.delete(),
          dispatchSplitSequence: FieldValue.delete(),
          dispatchSplitTotal: FieldValue.delete(), updatedAt: now,
        });
        return { splitGroupId, removedId: legDispatchId, newTotal: 1,
          order: [{ id: anchor.id, splitSequence: 1 }], lastStopAction };
      }
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
      return { splitGroupId, removedId: legDispatchId, newTotal: plan.order.length, order: plan.order, lastStopAction };
    });
    return result;
  },
);
