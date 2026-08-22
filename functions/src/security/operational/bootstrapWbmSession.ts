/**
 * Authenticated canonical WB-M bootstrap. Claims + canonical profile only.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { buildWbmBootstrapSnapshot } from './wbmBootstrap';
import { BINDING_BY_DRIVER, parseBinding } from './identityBinding';
import { decideTrustedHistoryKeys } from './trustedHistoryAlias';

export const bootstrapWbmSession = httpsV2.onCall(
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
    const binding = parseBinding(
      (await admin.database().ref(BINDING_BY_DRIVER(driver.driverId)).once('value')).val(),
    );
    const keys = decideTrustedHistoryKeys({
      authenticatedDriverId: driver.driverId,
      binding,
      requestData: request.data,
    });
    if (keys.action === 'refuse') {
      throw new httpsV2.HttpsError('invalid-argument', 'alias_spoof');
    }
    return { ...snap, trustedHistoryDriverIds: keys.keys };
  },
);
