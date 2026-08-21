/**
 * Governed canonical WB-M route writes. Exact driverId. Not deployed this pass.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  assertCanonicalDriverId,
  evaluateStaffWriteDriverAssignment,
} from './operational/staffWriteDriverAssignment';

const ALLOWED = new Set([
  'driverId',
  'assignedRoutes',
  'assignedWells',
  'mode',
  'expectedAssignedRoutes',
  'mirrorLegacy',
]);

export const staffWriteDriverAssignment = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED.has(key)) throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
    }

    let driverId: string;
    try {
      driverId = assertCanonicalDriverId(raw.driverId);
    } catch {
      throw new httpsV2.HttpsError('invalid-argument', 'driver_id_malformed');
    }
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';
    const mirrorLegacy = raw.mirrorLegacy === true;

    const routes = Array.isArray(raw.assignedRoutes)
      ? (raw.assignedRoutes as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const wells = Array.isArray(raw.assignedWells)
      ? (raw.assignedWells as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined;

    const rtdb = admin.database();
    const profSnap = await rtdb.ref(`drivers/profiles/${driverId}`).once('value');
    const profile = profSnap.exists() ? (profSnap.val() as Record<string, unknown>) : null;

    const approvedSnap = await rtdb.ref('drivers/approved').once('value');
    const approvedRows: Array<{ key: string; migratedToDriverId?: unknown; displayName?: unknown }> = [];
    const approvedTree = (approvedSnap.val() || {}) as Record<string, Record<string, unknown>>;
    for (const [key, row] of Object.entries(approvedTree)) {
      if (row && typeof row === 'object') {
        approvedRows.push({
          key,
          migratedToDriverId: row.migratedToDriverId,
          displayName: row.displayName,
        });
      }
    }

    const decided = evaluateStaffWriteDriverAssignment({
      driverId,
      profile,
      callerCompanyId: caller.companyId,
      isPlatformAdmin: caller.isPlatformAdmin,
      mirrorLegacy,
      approvedRows,
      expectedAssignedRoutes: raw.expectedAssignedRoutes,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError('failed-precondition', decided.reason);
    }

    const before = {
      assignedRoutes: profile?.assignedRoutes ?? null,
      assignedWells: profile?.assignedWells ?? null,
    };
    const after = {
      assignedRoutes: routes,
      assignedWells: wells === undefined ? (profile?.assignedWells ?? null) : wells,
    };
    const preview = {
      ok: true as const,
      mode,
      driverId,
      companyId: decided.companyId,
      before,
      after,
      mirrorLegacyKey: decided.mirrorLegacyKey,
    };
    if (mode !== 'apply') return preview;

    const updates: Record<string, unknown> = {
      [`drivers/profiles/${driverId}/assignedRoutes`]: after.assignedRoutes,
      [`drivers/profiles/${driverId}/assignedWells`]: after.assignedWells,
      [`drivers/profiles/${driverId}/assignmentUpdatedAt`]: Date.now(),
      [`drivers/profiles/${driverId}/assignmentUpdatedBy`]: caller.uid,
    };
    if (decided.mirrorLegacyKey) {
      updates[`drivers/approved/${decided.mirrorLegacyKey}/assignedRoutes`] = after.assignedRoutes;
    }
    await rtdb.ref().update(updates);
    await writeSecurityAudit({
      action: 'staffWriteDriverAssignment',
      actorUid: caller.uid,
      driverId,
      detail: {
        companyId: decided.companyId,
        before,
        after,
        mirrorLegacyKey: decided.mirrorLegacyKey,
      },
    });
    return preview;
  },
);
