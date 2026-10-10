import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './requireDriverAuth';

const name = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Cancel only the untouched destinations of a driver-owned family after a full delivery. */
export const resolveExhaustedSplitFamily = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const input = (request.data || {}) as Record<string, unknown>;
    if (Object.keys(input).some(key => !['currentDispatchId', 'callerDriverHash'].includes(key))) {
      throw new httpsV2.HttpsError('invalid-argument', 'unexpected_field');
    }
    const currentDispatchId = name(input.currentDispatchId);
    if (!currentDispatchId || currentDispatchId.includes('/')) {
      throw new httpsV2.HttpsError('invalid-argument', 'current_dispatch_id_required');
    }
    const driver = await requireSecureDriver(request, { legacyDriverHash: name(input.callerDriverHash) });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const db = admin.firestore();
    return db.runTransaction(async tx => {
      const currentSnap = await tx.get(db.collection('dispatches').doc(currentDispatchId));
      if (!currentSnap.exists) throw new httpsV2.HttpsError('not-found', 'current_split_not_found');
      const current = currentSnap.data() as Record<string, unknown>;
      const groupId = name(current.splitGroupId);
      if (!groupId || Number(current.splitSequence) < 2) {
        throw new httpsV2.HttpsError('failed-precondition', 'not_active_continuation');
      }
      if (name(current.driverId) !== driver.driverId || name(current.companyId) !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'job_owner_mismatch');
      }
      // Client presents this after local close; the durable close outbox may
      // still be catching up when the driver makes the next-stop decision.
      if (!['completed', 'accepted', 'in_progress', 'paused'].includes(name(current.status))) {
        throw new httpsV2.HttpsError('failed-precondition', 'current_split_not_started');
      }
      const familySnap = await tx.get(db.collection('dispatches').where('splitGroupId', '==', groupId));
      const family = familySnap.docs.map(doc => ({ ref: doc.ref, id: doc.id, data: doc.data() as Record<string, unknown> }));
      if (family.some(leg => name(leg.data.driverId) !== driver.driverId || name(leg.data.companyId) !== driver.companyId)) {
        throw new httpsV2.HttpsError('permission-denied', 'family_owner_mismatch');
      }
      // Any other started sibling means the driver is already handling that
      // stop; never erase it as part of this close flow.
      if (family.some(leg => leg.id !== currentDispatchId &&
          ['accepted', 'in_progress', 'paused'].includes(name(leg.data.status)))) {
        throw new httpsV2.HttpsError('failed-precondition', 'another_split_started');
      }
      // The driver can choose C before B. All untouched stops, including a
      // lower-numbered skipped one, belong in the new pickup decision.
      const pending = family.filter(leg => name(leg.data.status) === 'pending' &&
        leg.id !== currentDispatchId)
        .sort((a, b) => Number(a.data.splitSequence) - Number(b.data.splitSequence));
      const previouslyResolved = family.filter(leg => name(leg.data.status) === 'cancelled' &&
        name(leg.data.splitRemoveReason) === 'No water remaining' && leg.id !== currentDispatchId)
        .sort((a, b) => Number(a.data.splitSequence) - Number(b.data.splitSequence));
      if (!pending.length && !previouslyResolved.length) {
        throw new httpsV2.HttpsError('failed-precondition', 'no_pending_stops');
      }
      const now = admin.firestore.Timestamp.now();
      for (const leg of pending) {
        tx.update(leg.ref, {
          status: 'cancelled', cancelledAt: now, declinedAt: now,
          cancelReason: 'No water remaining after previous split',
          splitLegRemoved: true, splitRemoveReason: 'No water remaining',
          splitRemovedAt: now, splitRemovedBy: driver.driverId, updatedAt: now,
        });
      }
      return {
        splitGroupId: groupId,
        operator: name(current.operator),
        jobType: name(current.jobType),
        cancelledStops: [...previouslyResolved, ...pending]
          .sort((a, b) => Number(a.data.splitSequence) - Number(b.data.splitSequence))
          .map(leg => ({
          dispatchId: leg.id,
          destination: name(leg.data.disposalName) || name(leg.data.disposal) || name(leg.data.wellName),
          destinationType: name(leg.data.destinationType) || null,
          lat: typeof leg.data.disposalLat === 'number' ? leg.data.disposalLat : null,
          lng: typeof leg.data.disposalLng === 'number' ? leg.data.disposalLng : null,
          })),
      };
    });
  },
);
