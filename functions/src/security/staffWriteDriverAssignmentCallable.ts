/**
 * Governed canonical WB-M route/well writes. Exact driverId.
 * Dry-run unless mode is explicitly 'apply'. No legacy mirror.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';
import { writeSecurityAudit } from './audit';
import {
  assertCanonicalDriverId,
  evaluateStaffWriteDriverAssignment,
} from './operational/staffWriteDriverAssignment';
import { commitCanonicalAssignmentWrite } from './operational/assignmentApplyTransaction';
import {
  assignmentDigest,
  knownFreshWaterRouteNames,
  knownRouteNames,
  parseScopeList,
  previewContextDigest,
  revisionNumber,
  validateAssignedRoutesAgainstCatalog,
  validateAssignedWellsAgainstCatalog,
} from './operational/assignmentScope';

const ALLOWED = new Set([
  'driverId',
  'assignedRoutes',
  'assignedWells',
  'assignedFreshWaterRoutes',
  'mode',
  'expectedAssignmentDigest',
  'expectedProposedDigest',
  'expectedPreviewContextDigest',
]);

export const staffWriteDriverAssignment = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const trusted = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    if (!access.ok) {
      throw new httpsV2.HttpsError(
        access.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
        access.reason,
      );
    }
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

    if (raw.mode !== undefined && raw.mode !== 'dry-run' && raw.mode !== 'apply') {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_mode');
    }
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';

    const routesParsed = parseScopeList(raw.assignedRoutes, 'assignedRoutes');
    if (!routesParsed.ok) throw new httpsV2.HttpsError('invalid-argument', routesParsed.reason);
    const wellsParsed = parseScopeList(raw.assignedWells, 'assignedWells');
    if (!wellsParsed.ok) throw new httpsV2.HttpsError('invalid-argument', wellsParsed.reason);
    const rtdb = admin.database();
    const profSnap = await rtdb.ref(`drivers/profiles/${driverId}`).once('value');
    const profile = profSnap.exists() ? (profSnap.val() as Record<string, unknown>) : null;
    const freshRoutesParsed = parseScopeList(
      raw.assignedFreshWaterRoutes === undefined ? (profile?.assignedFreshWaterRoutes ?? []) : raw.assignedFreshWaterRoutes,
      'assignedFreshWaterRoutes',
    );
    if (!freshRoutesParsed.ok) throw new httpsV2.HttpsError('invalid-argument', freshRoutesParsed.reason);

    const decided = evaluateStaffWriteDriverAssignment({
      driverId,
      profile,
      callerCompanyId: access.companyId,
      isPlatformAdmin: access.isPlatformAdmin,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError('failed-precondition', decided.reason);
    }

    const [wellSnap, freshGroupsSnap] = await Promise.all([
      rtdb.ref('well_config').once('value'),
      rtdb.ref(`fresh_water_groups/${decided.companyId}`).once('value'),
    ]);
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const routesOk = validateAssignedRoutesAgainstCatalog(
      routesParsed.values,
      knownRouteNames(wellConfig),
    );
    if (!routesOk.ok) throw new httpsV2.HttpsError('failed-precondition', routesOk.reason);
    const wellsOk = validateAssignedWellsAgainstCatalog(
      wellsParsed.values,
      wellConfig,
      decided.companyId,
    );
    if (!wellsOk.ok) throw new httpsV2.HttpsError('failed-precondition', wellsOk.reason);
    const freshRoutesOk = validateAssignedRoutesAgainstCatalog(
      freshRoutesParsed.values,
      knownFreshWaterRouteNames(freshGroupsSnap.val() || {}),
    );
    if (!freshRoutesOk.ok) throw new httpsV2.HttpsError('failed-precondition', 'nonexistent_fresh_water_route');

    const before = {
      assignedRoutes: profile?.assignedRoutes ?? null,
      assignedWells: profile?.assignedWells ?? null,
      assignedFreshWaterRoutes: profile?.assignedFreshWaterRoutes ?? null,
      assignmentRevision: profile?.assignmentRevision ?? null,
    };
    const after = {
      assignedRoutes: routesParsed.values,
      assignedWells: wellsParsed.values,
      assignedFreshWaterRoutes: freshRoutesParsed.values,
    };
    const currentDigest = assignmentDigest(before.assignedRoutes, before.assignedWells, before.assignedFreshWaterRoutes);
    const proposedDigest = assignmentDigest(after.assignedRoutes, after.assignedWells, after.assignedFreshWaterRoutes);
    const contextDigest = previewContextDigest({
      driverId,
      companyId: decided.companyId,
      assignmentRevision: revisionNumber(before.assignmentRevision),
      currentRoutes: before.assignedRoutes,
      currentWells: before.assignedWells,
      currentFreshWaterRoutes: before.assignedFreshWaterRoutes,
      proposedRoutes: after.assignedRoutes,
      proposedWells: after.assignedWells,
      proposedFreshWaterRoutes: after.assignedFreshWaterRoutes,
    });
    const preview = {
      ok: true as const,
      mode,
      driverId,
      companyId: decided.companyId,
      before,
      after,
      currentDigest,
      proposedDigest,
      previewContextDigest: contextDigest,
      changedFields: [
        ...(JSON.stringify(before.assignedRoutes) === JSON.stringify(after.assignedRoutes) ? [] : ['assignedRoutes']),
        ...(JSON.stringify(before.assignedWells) === JSON.stringify(after.assignedWells) ? [] : ['assignedWells']),
        ...(JSON.stringify(before.assignedFreshWaterRoutes) === JSON.stringify(after.assignedFreshWaterRoutes)
          ? [] : ['assignedFreshWaterRoutes']),
      ],
    };
    if (mode !== 'apply') return preview;

    const expectedContext = typeof raw.expectedPreviewContextDigest === 'string'
      ? raw.expectedPreviewContextDigest
      : '';
    if (!expectedContext) {
      throw new httpsV2.HttpsError('failed-precondition', 'expected_preview_context_required');
    }

    const applied = await commitCanonicalAssignmentWrite({
      profileRef: rtdb.ref(`drivers/profiles/${driverId}`),
      driverId,
      expectedPreviewContextDigest: expectedContext,
      proposedRoutes: after.assignedRoutes,
      proposedWells: after.assignedWells,
      proposedFreshWaterRoutes: after.assignedFreshWaterRoutes,
      callerCompanyId: access.companyId,
      isPlatformAdmin: access.isPlatformAdmin,
      callerUid: access.uid,
      nowMs: Date.now(),
    });
    if (!applied.ok) {
      throw new httpsV2.HttpsError('failed-precondition', 'stale_preview');
    }
    await writeSecurityAudit({
      action: 'staffWriteDriverAssignment',
      actorUid: access.uid,
      driverId,
      detail: {
        companyId: decided.companyId,
        before,
        after,
        assignmentRevision: applied.assignmentRevision,
      },
    });
    return {
      ...preview,
      assignmentRevision: applied.assignmentRevision,
    };
  },
);
