/**
 * adminAssignDriverAssignment — write canonical assignedRoutes/assignedWells.
 *
 * Dual-writes drivers/approved/{legacyKey} in the same RTDB multi-path
 * update while the legacy Drivers UI remains. Partial writes are refused
 * before any I/O.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  evaluateAssignDriverAssignment,
  isCanonicalDriverId,
  isLegacyHashKey,
  type AssignmentLegacyView,
  type AssignmentProfileView,
} from './operational/assignDriverAssignment';
import type { MigrationIdentityRow } from './operational/assignmentMigration';
import { evaluateAssignmentMigration } from './operational/assignmentMigration';

const ALLOWED_KEYS = new Set([
  'driverId',
  'legacyKey',
  'assignedRoutes',
  'assignedWells',
]);

const PRECONDITION_REASONS = new Set([
  'driver_identity_required',
  'not_canonical_driver_id',
  'not_legacy_key',
  'assigned_routes_must_be_array',
  'assigned_wells_must_be_array',
  'unknown_driver',
  'profile_id_mismatch',
  'inactive_driver',
  'profile_company_required',
  'cross_company',
  'legacy_row_missing',
  'legacy_inactive',
  'legacy_canonical_identity_mismatch',
  'canonical_identity_unresolved',
  'canonical_duplicate',
  'partial_write_refused',
]);

const rtdb = () => admin.database();

function profileView(driverId: string, val: Record<string, unknown> | null): AssignmentProfileView {
  if (!val) return { exists: false };
  return {
    exists: true,
    driverId,
    active: val.active !== false,
    companyId: typeof val.companyId === 'string' ? val.companyId : null,
    displayName: typeof val.displayName === 'string' ? val.displayName : typeof val.name === 'string' ? val.name : null,
    assignedRoutes: val.assignedRoutes,
    assignedWells: val.assignedWells,
  };
}

function legacyView(key: string, val: Record<string, unknown> | null): AssignmentLegacyView {
  if (!val) return { exists: false };
  return {
    exists: true,
    key,
    active: val.active !== false,
    companyId: typeof val.companyId === 'string' ? val.companyId : null,
    displayName: typeof val.displayName === 'string' ? val.displayName : typeof val.name === 'string' ? val.name : null,
  };
}

async function loadProfile(driverId: string): Promise<AssignmentProfileView> {
  const snap = await rtdb().ref(`drivers/profiles/${driverId}`).once('value');
  return profileView(driverId, snap.exists() ? (snap.val() as Record<string, unknown>) : null);
}

async function loadLegacy(legacyKey: string): Promise<AssignmentLegacyView> {
  const snap = await rtdb().ref(`drivers/approved/${legacyKey}`).once('value');
  return legacyView(legacyKey, snap.exists() ? (snap.val() as Record<string, unknown>) : null);
}

async function resolveDriverIdFromLegacy(
  legacy: AssignmentLegacyView,
): Promise<{ ok: true; driverId: string } | { ok: false; reason: string }> {
  if (!legacy.exists || !legacy.displayName || !legacy.companyId) {
    return { ok: false, reason: 'canonical_identity_unresolved' };
  }
  const snap = await rtdb().ref('drivers/profiles').once('value');
  const tree = (snap.val() || {}) as Record<string, Record<string, unknown>>;
  const profiles: MigrationIdentityRow[] = Object.entries(tree).map(([id, val]) => ({
    id,
    displayName: typeof val.displayName === 'string' ? val.displayName : typeof val.name === 'string' ? val.name : null,
    companyId: typeof val.companyId === 'string' ? val.companyId : null,
    active: val.active !== false,
  }));
  const approved: MigrationIdentityRow[] = [
    {
      id: 'legacy-placeholder',
      displayName: legacy.displayName,
      companyId: legacy.companyId,
      active: legacy.active !== false,
      assignedRoutes: [],
    },
  ];
  const report = evaluateAssignmentMigration({
    requestedNames: [legacy.displayName],
    approved,
    profiles,
  });
  const row = report.results[0];
  if (!row || !row.ok) {
    return { ok: false, reason: row && !row.ok ? row.reason : 'canonical_identity_unresolved' };
  }
  return { ok: true, driverId: row.driverId };
}

export const adminAssignDriverAssignment = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }

    let driverId = typeof raw.driverId === 'string' ? raw.driverId.trim() : '';
    const legacyKey = typeof raw.legacyKey === 'string' ? raw.legacyKey.trim() : '';
    if (driverId && !isCanonicalDriverId(driverId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'not_canonical_driver_id');
    }
    if (legacyKey && !isLegacyHashKey(legacyKey)) {
      throw new httpsV2.HttpsError('invalid-argument', 'not_legacy_key');
    }

    const wellsSpecified = Object.prototype.hasOwnProperty.call(raw, 'assignedWells');
    const legacyRow = legacyKey ? await loadLegacy(legacyKey) : { exists: false };

    if (!driverId && legacyKey) {
      const resolved = await resolveDriverIdFromLegacy(legacyRow);
      if (!resolved.ok) {
        throw new httpsV2.HttpsError('failed-precondition', resolved.reason);
      }
      driverId = resolved.driverId;
    }

    const profile = driverId ? await loadProfile(driverId) : { exists: false };

    const decided = evaluateAssignDriverAssignment({
      callerUid: caller.uid,
      callerCompanyId: caller.companyId,
      isPlatformAdmin: caller.isPlatformAdmin,
      driverId: driverId || undefined,
      legacyKey: legacyKey || undefined,
      assignedRoutes: raw.assignedRoutes,
      assignedWells: raw.assignedWells,
      wellsSpecified,
      profile,
      legacyRow,
    });

    await writeSecurityAudit({
      action: 'adminAssignDriverAssignment',
      actorUid: caller.uid,
      driverId: driverId || null,
      detail: {
        outcome: decided.ok ? `ok:dual=${decided.dualWrite}` : `refused:${decided.reason}`,
        routeCount: decided.ok ? decided.routes.length : undefined,
        wellsUpdated: decided.ok ? decided.wellsUpdated : undefined,
      },
    });

    if (!decided.ok) {
      throw new httpsV2.HttpsError(
        PRECONDITION_REASONS.has(decided.reason) ? 'failed-precondition' : 'internal',
        decided.reason,
      );
    }

    await rtdb().ref().update(decided.patch);

    return {
      ok: true as const,
      driverId: decided.driverId,
      dualWrite: decided.dualWrite,
      assignedRoutes: decided.routes,
      assignedWells: decided.wellsUpdated ? decided.wells : undefined,
    };
  },
);
