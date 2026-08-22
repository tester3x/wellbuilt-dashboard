/**
 * Authenticated canonical profile hydration for WB-T / WB-M.
 *
 * Loads drivers/profiles/{uuid} — never treats the UUID as
 * drivers/approved/{legacyHash}. Trusted history aliases are resolved
 * from the server-controlled binding. Client-supplied alias keys are
 * refused as alias_spoof.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './requireDriverAuth';
import { BINDING_BY_DRIVER, parseBinding } from './operational/identityBinding';
import { decideTrustedHistoryKeys } from './operational/trustedHistoryAlias';
import { projectDriverHydration } from './operational/canonicalProfileHydration';

export const getOwnDriverHydration = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const spoof = decideTrustedHistoryKeys({
      authenticatedDriverId: driver.driverId,
      binding: null,
      requestData: request.data,
    });
    if (spoof.action === 'refuse') {
      throw new httpsV2.HttpsError('invalid-argument', 'alias_spoof');
    }

    const rtdb = admin.database();
    const profSnap = await rtdb.ref(`drivers/profiles/${driver.driverId}`).once('value');
    if (!profSnap.exists()) {
      throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
    }
    const profile = (profSnap.val() || {}) as Record<string, unknown>;
    const binding = parseBinding(
      (await rtdb.ref(BINDING_BY_DRIVER(driver.driverId)).once('value')).val(),
    );
    const keys = decideTrustedHistoryKeys({
      authenticatedDriverId: driver.driverId,
      binding,
    });
    if (keys.action !== 'ok') {
      throw new httpsV2.HttpsError('invalid-argument', 'alias_spoof');
    }

    return projectDriverHydration({
      driverId: driver.driverId,
      profile,
      trustedHistoryDriverIds: keys.keys,
    });
  },
);
