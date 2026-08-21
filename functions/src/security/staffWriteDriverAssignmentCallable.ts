/**
 * Governed canonical WB-M route/well writes. Exact driverId.
 * Dry-run unless mode is explicitly 'apply'. No legacy mirror.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  assertCanonicalDriverId,
  evaluateStaffWriteDriverAssignment,
} from './operational/staffWriteDriverAssignment';
import {
  assignmentDigest,
  evaluateAssignmentTransaction,
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
  'mode',
  'expectedAssignmentDigest',
  'expectedProposedDigest',
  'expectedPreviewContextDigest',
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

    const decided = evaluateStaffWriteDriverAssignment({
      driverId,
      profile,
      callerCompanyId: caller.companyId,
      isPlatformAdmin: caller.isPlatformAdmin,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError('failed-precondition', decided.reason);
    }

    const wellSnap = await rtdb.ref('well_config').once('value');
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

    const before = {
      assignedRoutes: profile?.assignedRoutes ?? null,
      assignedWells: profile?.assignedWells ?? null,
      assignmentRevision: profile?.assignmentRevision ?? null,
    };
    const after = {
      assignedRoutes: routesParsed.values,
      assignedWells: wellsParsed.values,
    };
    const currentDigest = assignmentDigest(before.assignedRoutes, before.assignedWells);
    const proposedDigest = assignmentDigest(after.assignedRoutes, after.assignedWells);
    const contextDigest = previewContextDigest({
      driverId,
      companyId: decided.companyId,
      assignmentRevision: revisionNumber(before.assignmentRevision),
      currentRoutes: before.assignedRoutes,
      currentWells: before.assignedWells,
      proposedRoutes: after.assignedRoutes,
      proposedWells: after.assignedWells,
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
      ],
    };
    if (mode !== 'apply') return preview;

    const expectedContext = typeof raw.expectedPreviewContextDigest === 'string'
      ? raw.expectedPreviewContextDigest
      : '';
    if (!expectedContext) {
      throw new httpsV2.HttpsError('failed-precondition', 'expected_preview_context_required');
    }

    const tx = await rtdb.ref(`drivers/profiles/${driverId}`).transaction((current) => {
      const rec = current && typeof current === 'object' ? current as Record<string, unknown> : null;
      const gate = evaluateAssignmentTransaction({
        driverId,
        profile: rec,
        expectedPreviewContextDigest: expectedContext,
        proposedRoutes: after.assignedRoutes,
        proposedWells: after.assignedWells,
        callerCompanyId: caller.companyId,
        isPlatformAdmin: caller.isPlatformAdmin,
      });
      if (!gate.ok || !rec) return;
      return {
        ...rec,
        assignedRoutes: after.assignedRoutes,
        assignedWells: after.assignedWells,
        assignmentRevision: gate.nextRevision,
        assignmentUpdatedAt: Date.now(),
        assignmentUpdatedBy: caller.uid,
      };
    });
    if (!tx.committed || !tx.snapshot.exists()) {
      throw new httpsV2.HttpsError('failed-precondition', 'stale_preview');
    }
    const written = tx.snapshot.val() as Record<string, unknown>;
    await writeSecurityAudit({
      action: 'staffWriteDriverAssignment',
      actorUid: caller.uid,
      driverId,
      detail: {
        companyId: decided.companyId,
        before,
        after,
        assignmentRevision: written.assignmentRevision ?? null,
      },
    });
    return {
      ...preview,
      assignmentRevision: written.assignmentRevision ?? null,
    };
  },
);
