import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from './requireDriverAuth';
import { driverMayJoinProject, evaluateDriverDispatchBirth } from './operational/createDriverDispatch';
import { parsePacketRef } from './operational/dispatchPacketPin';
import { checkWell, loadAuthorizedWellCatalog, loadVerifiedRevision } from './operational/dispatchPinRuntime';
import { authorizeSplitDeliveryStop } from './operational/splitStopAuthorization';
import { approvedSplitDisposal } from './operational/splitStopCatalog';

function throwFail(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  const code = decided.reason === 'conflict' ? 'already-exists'
    : decided.reason === 'unauthenticated_driver' ? 'unauthenticated'
      : decided.reason === 'revision_not_found' ? 'not-found'
        : 'invalid-argument';
  if (decided.reason === 'conflict') throw new httpsV2.HttpsError('failed-precondition', msg);
  throw new httpsV2.HttpsError(code === 'already-exists' ? 'failed-precondition' : code, msg);
}

export const createDriverDispatchIfAbsent = httpsV2.onCall(
  // Interactive driver job creation must not wait for a scale-from-zero startup.
  { minInstances: 1, timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!['dispatchId', 'record', 'packetRef'].includes(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const packet = parsePacketRef(raw.packetRef);
    if (!packet.ok) throwFail(packet);
    const record = (raw.record && typeof raw.record === 'object' && !Array.isArray(raw.record))
      ? (raw.record as Record<string, unknown>)
      : {};
    const wells = await loadAuthorizedWellCatalog(driver.companyId);
    if (!wells.ok) throwFail(wells);
    const revision = await loadVerifiedRevision(driver.companyId, packet.packetRef);
    if (!revision.ok) throwFail(revision);
    const fs = admin.firestore();
    const outcome = await fs.runTransaction(async (tx) => {
      const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
      const ref = fs.collection('dispatches').doc(dispatchId);
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const compSnap = await tx.get(fs.collection('companies').doc(driver.companyId as string));
      const compData = compSnap.exists ? (compSnap.data() as Record<string, unknown>) : null;
      const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
      if (record.projectId !== undefined && (!projectId || !/^[A-Za-z0-9_-]{1,120}$/.test(projectId))) {
        throw new httpsV2.HttpsError('invalid-argument', 'invalid_project_id');
      }
      if (projectId && !snap.exists) {
        const projectSnap = await tx.get(fs.collection('projects').doc(projectId));
        if (!driverMayJoinProject(projectSnap.exists ? projectSnap.data() as Record<string, unknown> : null,
          { companyId: driver.companyId as string, driverId: driver.driverId }, record)) {
          throw new httpsV2.HttpsError('permission-denied', 'project_driver_not_authorized');
        }
      }
      const customJobTypes = Array.isArray(compData?.customJobTypes) ? compData!.customJobTypes : undefined;
      const decided = evaluateDriverDispatchBirth({
        dispatchId,
        caller: { driverId: driver.driverId, companyId: driver.companyId as string },
        existing,
        record,
        envelope: revision.envelope,
        companyCustomJobTypes: customJobTypes,
      });
      if (!decided.ok) throwFail(decided);
      if (decided.result === 'already_exists') {
        return { result: 'already_exists' as const, dispatchId };
      }
      const well = checkWell(record, wells);
      if (!well.ok) {
        // Only a catalog-missing later delivery gets the separate stop check.
        // Alias ambiguity, broken catalogs and ordinary pickups still fail closed.
        if (well.reason !== 'well_unauthorized' || !Number.isSafeInteger(record.splitSequence)
            || Number(record.splitSequence) < 2 || typeof record.splitGroupId !== 'string') throwFail(well);
        const delivery = await authorizeSplitDeliveryStop({ dispatchId, record,
          caller: {companyId: driver.companyId as string, driverId: driver.driverId},
          binding: decided.identity!.binding, jobTypeId: decided.identity!.jobTypeId,
          envelope: revision.envelope,
          sourceAllowed: row => checkWell(row, wells).ok,
          getFamily: async group => (await tx.get(fs.collection('dispatches').where('splitGroupId', '==', group).limit(101)))
            .docs.map(d => ({id: d.id, data: d.data()})),
          getBirth: async id => {const b = await tx.get(fs.collection('driver_dispatch_births').doc(id)); return b.exists ? b.data()! : null;},
          destinationAllowed: row => approvedSplitDisposal(tx, fs, driver.companyId as string, row),
        });
        if (!delivery.ok) throwFail(delivery);
      }
      tx.create(ref, {
        ...decided.fields,
        assignedAt: FieldValue.serverTimestamp(),
        driverCreateAssignedAt: FieldValue.serverTimestamp(),
      });
      // Immutable birth evidence; never backfill from a mutable assignment on replay.
      tx.create(fs.collection('driver_dispatch_births').doc(dispatchId), {
        dispatchId, companyId: driver.companyId, driverId: driver.driverId,
        assignedAt: FieldValue.serverTimestamp(),
      });
      return { result: 'created' as const, dispatchId };
    });
    return { ok: true as const, ...outcome };
  },
);
