/**
 * Authenticated WB-M well catalog. Claims + canonical authority only.
 * Returns allowlisted wells inside the driver's Dashboard Routes scope.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { evaluateWbmWellScope, projectWbmWells } from './wbmWellScope';

export const getDriverWellConfig = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const authority = await loadCanonicalDriverAuthority(
      driver.driverId,
      productionCanonicalDriverReaders(),
    );
    if (!authority || !authority.active) {
      throw new httpsV2.HttpsError('permission-denied', 'driver_inactive');
    }
    if (!authority.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'company_required');
    }

    const profSnap = await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value');
    if (!profSnap.exists()) {
      throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
    }
    const profile = (profSnap.val() || {}) as Record<string, unknown>;
    const scope = evaluateWbmWellScope(profile.assignedRoutes, profile.assignedWells);
    if (!scope.ok) {
      throw new httpsV2.HttpsError('failed-precondition', scope.reason, { reason: scope.reason });
    }

    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const wells = projectWbmWells(wellConfig, authority.companyId, scope);
    return {
      ok: true as const,
      companyId: authority.companyId,
      wells,
      reason: 'scope_ok' as const,
      wellCount: Object.keys(wells).length,
    };
  },
);
