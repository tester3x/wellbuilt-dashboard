/**
 * Authenticated WB-M current-status reader.
 * Admin SDK reads packets/outgoing (including legacy rows without companyId)
 * and returns only wells authorized for the signed-in driver.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { buildWbmBootstrapSnapshot } from './wbmBootstrap';
import {
  collectLatestOutgoingByWell,
  partitionAuthorizedOutgoing,
} from './selectOutgoingStatus';

export const getDriverOutgoingStatus = httpsV2.onCall(
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
    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const snap = buildWbmBootstrapSnapshot({
      driverId: driver.driverId,
      companyId: authority.companyId,
      profile,
      wellConfig,
    });
    if (snap.eligibilityStatus !== 'eligible') {
      throw new httpsV2.HttpsError('failed-precondition', snap.eligibilityReason, {
        reason: snap.eligibilityReason,
      });
    }

    const authorizedWells = Object.keys(snap.wells);
    const outgoingSnap = await admin.database().ref('packets/outgoing').once('value');
    const latest = collectLatestOutgoingByWell(outgoingSnap.exists() ? outgoingSnap.val() : {});
    const { responses, unavailableWells } = partitionAuthorizedOutgoing({
      latestByWell: latest,
      authorizedWells,
    });

    return {
      ok: true as const,
      driverId: driver.driverId,
      companyId: authority.companyId,
      authorizedWells,
      wellCount: authorizedWells.length,
      responses,
      unavailableWells,
    };
  },
);
