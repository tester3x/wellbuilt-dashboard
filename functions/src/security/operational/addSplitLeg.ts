/**
 * addSplitLeg — field or dispatcher extension of an existing split chain.
 * Authority is fully resolved before any write construction.
 */
import { createHash } from 'crypto';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { requireAdminAuthority } from '../adminAuth';
import {
  decideAddSplitLegAuthority,
  splitAttemptKey,
  type SplitCaller,
} from './addSplitLegAuth';

const fs = () => admin.firestore();
const rtdb = () => admin.database();

function deny(reason: string): never {
  const http =
    reason === 'unauthenticated'
      ? 'unauthenticated'
      : reason === 'no_split_chain'
        ? 'failed-precondition'
        : 'permission-denied';
  throw new httpsV2.HttpsError(http, reason);
}

async function resolveCaller(request: httpsV2.CallableRequest): Promise<SplitCaller> {
  if (!request.auth?.uid) {
    throw new httpsV2.HttpsError('unauthenticated', 'unauthenticated');
  }
  const data = (request.data || {}) as { driverHash?: unknown };
  if (data.driverHash != null) {
    throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
  }
  const kind = (request.auth.token as { kind?: unknown } | undefined)?.kind;
  if (kind === 'driver') {
    const driver = await requireSecureDriver(request);
    return {
      class: 'driver',
      uid: driver.uid,
      driverId: driver.driverId,
      companyId: driver.companyId,
    };
  }
  const staff = await requireAdminAuthority(
    request.auth.uid,
    request.auth.token as Record<string, unknown> | undefined,
  );
  if (staff.class === 'platform') return { class: 'platform', uid: staff.uid };
  if (!staff.companyId) deny('not_authorized');
  return { class: 'staff', uid: staff.uid, companyId: staff.companyId, caps: staff.caps };
}

async function serverMappedOwnerId(driverHash: unknown): Promise<string | null> {
  if (typeof driverHash !== 'string' || !driverHash.trim()) return null;
  const snap = await rtdb().ref(`drivers/approved/${driverHash.trim()}`).once('value');
  if (!snap.exists()) return null;
  const val = snap.val() || {};
  if (typeof val.migratedToDriverId === 'string' && val.migratedToDriverId.trim()) {
    return val.migratedToDriverId.trim();
  }
  if (typeof val.driverId === 'string' && val.driverId.trim()) return val.driverId.trim();
  return null;
}

function attemptDocId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export const addSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      parentDispatchId?: string;
      callerDriverHash?: string;
      driverHash?: unknown;
      companyId?: unknown;
      driverId?: unknown;
      legSpec?: {
        disposal?: string;
        disposalLat?: number | null;
        disposalLng?: number | null;
        bbls?: number | null;
        jobType?: string | null;
        serviceType?: string | null;
        notes?: string | null;
      };
    };

    const parentDispatchId = typeof data.parentDispatchId === 'string' ? data.parentDispatchId.trim() : '';
    const legSpec = data.legSpec || {};
    if (!parentDispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'parentDispatchId is required');
    }
    if (!legSpec.disposal || typeof legSpec.disposal !== 'string') {
      throw new httpsV2.HttpsError('invalid-argument', 'legSpec.disposal is required');
    }

    const caller = await resolveCaller(request);

    const parentRef = fs().collection('dispatches').doc(parentDispatchId);
    const parentSnap = await parentRef.get();
    if (!parentSnap.exists) {
      throw new httpsV2.HttpsError('not-found', `Parent dispatch ${parentDispatchId} not found`);
    }
    const parent = parentSnap.data() as Record<string, unknown>;
    const mappedOwner = await serverMappedOwnerId(parent.driverHash);
    const decided = decideAddSplitLegAuthority({
      caller,
      parent,
      serverMappedOwnerId: mappedOwner,
    });
    if (!decided.ok) deny(decided.reason);

    const splitGroupId = String(parent.splitGroupId);
    const receiptId = attemptDocId(
      splitAttemptKey({
        uid: caller.uid,
        splitGroupId,
        parentDispatchId,
        disposal: legSpec.disposal,
      }),
    );
    const receiptRef = fs().collection('split_leg_attempts').doc(receiptId);
    const existingReceipt = await receiptRef.get();
    if (existingReceipt.exists) {
      const prev = existingReceipt.data() || {};
      return {
        newDispatchId: prev.newDispatchId,
        splitGroupId: prev.splitGroupId,
        splitSequence: prev.splitSequence,
        splitTotal: prev.splitTotal,
        reused: true,
      };
    }

    const siblingSnap = await fs().collection('dispatches').where('splitGroupId', '==', splitGroupId).get();
    if (siblingSnap.empty) {
      throw new httpsV2.HttpsError(
        'internal',
        `Could not enumerate siblings for splitGroupId=${splitGroupId}`,
      );
    }

    let maxSequence = 0;
    let leg1DispatchId: string | null = null;
    const siblingRefs: DocumentReference[] = [];
    siblingSnap.forEach((docSnap) => {
      const d = docSnap.data() as Record<string, unknown>;
      const seq = typeof d.splitSequence === 'number' ? d.splitSequence : 0;
      if (seq > maxSequence) maxSequence = seq;
      if (seq === 1) leg1DispatchId = docSnap.id;
      siblingRefs.push(docSnap.ref);
    });
    const nextSequence = maxSequence + 1;
    const newTotal = siblingSnap.size + 1;
    const rootParentId = leg1DispatchId || parentDispatchId;
    const callerDriverHash = typeof data.callerDriverHash === 'string' ? data.callerDriverHash : null;
    const now = Timestamp.now();
    const newDispatchRef = fs().collection('dispatches').doc();
    const newDispatch: Record<string, unknown> = {
      driverHash: parent.driverHash,
      driverName: parent.driverName,
      driverFirstName: parent.driverFirstName || null,
      wellName: parent.wellName,
      ndicWellName: parent.ndicWellName || parent.wellName,
      operator: parent.operator || null,
      packageId: parent.packageId || null,
      companyId: parent.companyId || null,
      driverId: parent.driverId || parent.assignedDriverId || mappedOwner || null,
      priority: parent.priority || 5,
      onsiteBy: parent.onsiteBy || null,
      disposal: legSpec.disposal,
      ...(legSpec.disposalLat != null ? { disposalLat: legSpec.disposalLat } : {}),
      ...(legSpec.disposalLng != null ? { disposalLng: legSpec.disposalLng } : {}),
      ...(legSpec.bbls != null ? { bbls: legSpec.bbls } : {}),
      jobType: legSpec.jobType || parent.jobType || null,
      serviceType: legSpec.serviceType || parent.serviceType || null,
      notes:
        legSpec.notes ||
        `Split ticket ${String.fromCharCode(65 + nextSequence - 1)} (field-added)`,
      splitGroupId,
      splitSequence: nextSequence,
      splitTotal: newTotal,
      parentDispatchId: rootParentId,
      splitOriginatedAt: caller.class === 'driver' || callerDriverHash ? 'field' : 'dashboard',
      splitOriginatedBy: caller.uid,
      status: 'pending',
      assignedAt: now,
      assignedBy: caller.class === 'driver' ? `driver:${caller.driverId}` : caller.uid,
      createdAt: now,
      loadCount: 1,
      loadsCompleted: 0,
    };

    const batch = fs().batch();
    batch.set(newDispatchRef, newDispatch);
    for (const ref of siblingRefs) {
      batch.update(ref, { splitTotal: newTotal, updatedAt: now });
    }
    const invSnap = await fs()
      .collection('invoices')
      .where('dispatchSplitGroupId', '==', splitGroupId)
      .get();
    invSnap.forEach((doc) => {
      batch.update(doc.ref, { dispatchSplitTotal: newTotal, updatedAt: now });
    });
    batch.set(receiptRef, {
      uid: caller.uid,
      splitGroupId,
      parentDispatchId,
      newDispatchId: newDispatchRef.id,
      splitSequence: nextSequence,
      splitTotal: newTotal,
      createdAt: now,
    });
    await batch.commit();

    return {
      newDispatchId: newDispatchRef.id,
      splitGroupId,
      splitSequence: nextSequence,
      splitTotal: newTotal,
    };
  },
);
