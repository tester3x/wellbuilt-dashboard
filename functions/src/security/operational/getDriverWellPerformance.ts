/**
 * Authenticated WB-M Performance reader.
 * Admin SDK reads only the authorized performance/{wellKey} node and returns
 * the existing { wellName, updated, rows:{d,a,p} } projection.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { buildWbmBootstrapSnapshot } from './wbmBootstrap';
import { assertDriverWellPerformanceAccess } from './driverWellPerformanceAccess';
import {
  parseWellPerformanceRequest,
  projectWellPerformance,
  wellKeyFromName,
  WellPerformanceRequestError,
} from './selectWellPerformance';

export const getDriverWellPerformance = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const authority = await loadCanonicalDriverAuthority(
      driver.driverId,
      productionCanonicalDriverReaders(),
    );

    let parsed;
    try {
      parsed = parseWellPerformanceRequest(request.data);
    } catch (err) {
      if (err instanceof WellPerformanceRequestError) {
        throw new httpsV2.HttpsError('invalid-argument', err.message);
      }
      throw err;
    }

    const profSnap = await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value');
    const profile = (profSnap.exists() ? profSnap.val() : {}) as Record<string, unknown>;
    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const snap = buildWbmBootstrapSnapshot({
      driverId: driver.driverId,
      companyId: authority?.companyId || '',
      profile,
      wellConfig,
    });

    assertDriverWellPerformanceAccess({
      authPresent: true,
      authSource: driver.authSource,
      authority: authority
        ? { active: authority.active, companyId: authority.companyId }
        : null,
      profileExists: profSnap.exists(),
      eligibilityStatus: snap.eligibilityStatus,
      eligibilityReason: snap.eligibilityReason,
      requestedWell: parsed.wellName,
      snapshotWells: snap.wells,
    });

    const wellKey = wellKeyFromName(parsed.wellName);
    const perfSnap = await admin.database().ref(`performance/${wellKey}`).once('value');
    const projection = projectWellPerformance({
      requestedWellName: parsed.wellName,
      node: perfSnap.exists() ? perfSnap.val() : null,
      fromDate: parsed.fromDate,
      toDate: parsed.toDate,
    });

    return {
      ok: true as const,
      wellName: projection.wellName,
      updated: projection.updated,
      rows: projection.rows,
    };
  },
);
