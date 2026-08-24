/**
 * Admin-SDK query construction for unclaimed-shift recovery.
 *
 * minted_diagnostics runs on the default wellbuilt-sync Admin Firestore
 * (wb_diagnostics is a Suite public log).
 *
 * dedicated equipment Post-Trip queries MUST target a Firestore instance
 * whose projectId is wellbuilt-equipment-prod (or emulator of that id).
 * They must never run against wellbuilt-sync. The production callable
 * does not call applyDedicatedEquipmentPostTripQuery — production WB-E
 * has no authoritative server completion store.
 */
import type { Firestore, Query } from 'firebase-admin/firestore';
import {
  dedicatedEquipmentPostTripQuerySpec,
  WB_E_COMPLETION_AUTHORITY,
} from './unclaimedShiftRecovery.js';

export function assertDedicatedEquipmentProject(
  projectId: string | undefined | null,
): asserts projectId is string {
  const id = String(projectId || '').trim();
  if (!id) {
    throw new Error('dedicated DVIR query requires a projectId');
  }
  if (id === WB_E_COMPLETION_AUTHORITY.forbiddenHostProject
    || id.includes('wellbuilt-sync')) {
    throw new Error(
      `dedicated DVIR query refused on project "${id}" (wellbuilt-sync is not the WB-E store)`,
    );
  }
  if (id !== WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod
    && id !== WB_E_COMPLETION_AUTHORITY.dedicatedProject.dev) {
    throw new Error(
      `dedicated DVIR query refused on project "${id}" (expected wellbuilt-equipment-prod or wellbuilt-equipment-dev)`,
    );
  }
}

export function applyMintedDiagnosticsQuery(
  db: Firestore,
  periodId: string,
): Query {
  return db.collection('wb_diagnostics')
    .where('shiftId', '==', periodId)
    .where('event', '==', 'shiftId.minted');
}

/**
 * Real Admin SDK query for the FirebaseDvirTransport schema.
 * Tests (emulator) execute this. Production recovery does not: there is
 * no authoritative server store, and this query cannot join a
 * wellbuilt-sync transaction.
 */
export function applyDedicatedEquipmentPostTripQuery(
  db: Firestore,
  orgId: string,
  periodId: string,
  projectId: string,
): Query {
  assertDedicatedEquipmentProject(projectId);
  const spec = dedicatedEquipmentPostTripQuerySpec(orgId, periodId);
  if (projectId === spec.forbiddenProjectId || projectId.includes('wellbuilt-sync')) {
    throw new Error('dedicated DVIR query must not run on wellbuilt-sync');
  }
  let q: Query = db.collection(spec.collectionPath);
  for (const filter of spec.filters) {
    q = q.where(filter.field, filter.op, filter.value);
  }
  return q;
}

/** Top-level fields the previous callable used. They miss the writer schema. */
export function applyWrongTopLevelPostTripQuery(
  db: Firestore,
  orgId: string,
  periodId: string,
): Query {
  return db.collection(`organizations/${orgId}/dvirReports`)
    .where('inspectionType', '==', 'post_trip')
    .where('shiftId', '==', periodId);
}
