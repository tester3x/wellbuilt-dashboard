/**
 * Authorization sequencing for getDriverWellPerformance.
 * Mirrors getDriverOutgoingStatus: claims-only identity, canonical
 * authority, active company, eligible bootstrap snapshot, exact well.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { isAuthorizedSnapshotWell } from './selectWellPerformance';

export function assertDriverWellPerformanceAccess(input: {
  authPresent: boolean;
  authSource?: 'claims' | 'legacy_hash' | null;
  authority: { active: boolean; companyId?: string } | null;
  profileExists: boolean;
  eligibilityStatus: string;
  eligibilityReason: string;
  requestedWell: string;
  snapshotWells: Record<string, unknown>;
}): void {
  if (!input.authPresent) {
    throw new httpsV2.HttpsError('unauthenticated', 'authentication_required');
  }
  if (input.authSource === 'legacy_hash') {
    throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_denied');
  }
  if (!input.authority || !input.authority.active) {
    throw new httpsV2.HttpsError('permission-denied', 'driver_inactive');
  }
  if (!input.authority.companyId) {
    throw new httpsV2.HttpsError('failed-precondition', 'company_required');
  }
  if (!input.profileExists) {
    throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
  }
  if (input.eligibilityStatus !== 'eligible') {
    throw new httpsV2.HttpsError(
      'failed-precondition',
      input.eligibilityReason || 'ineligible',
      { reason: input.eligibilityReason },
    );
  }
  if (!isAuthorizedSnapshotWell(input.snapshotWells, input.requestedWell)) {
    throw new httpsV2.HttpsError('permission-denied', 'well_not_authorized');
  }
}
