/**
 * Governed well configuration for WB-T Current Job Review.
 * Authenticated driver + canonical company/route/well scope only.
 * Never returns global well_config.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { evaluateGovernedWellConfig } from './governedWellConfig';

export const getGovernedWellConfig = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { wellName?: unknown; companyId?: unknown };
    if (data.companyId !== undefined) {
      throw new httpsV2.HttpsError('invalid-argument', 'unexpected_field');
    }
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
    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const wellName = typeof data.wellName === 'string' ? data.wellName.trim() : '';

    const decided = evaluateGovernedWellConfig({
      companyId: authority.companyId,
      assignedRoutes: profile.assignedRoutes,
      assignedWells: profile.assignedWells,
      wellConfig,
      wellName: wellName || undefined,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError('failed-precondition', decided.reason);
    }
    return {
      ok: true as const,
      companyId: authority.companyId,
      wells: decided.wells,
      wellCount: decided.wellCount,
    };
  },
);
