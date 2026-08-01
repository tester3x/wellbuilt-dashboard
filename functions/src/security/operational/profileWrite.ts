/**
 * Driver self-profile update (secure). Clients cannot set isAdmin/roles/companyId.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';

const PROFILE_ALLOWED = new Set([
  'truckNumber',
  'trailerNumber',
  'signature',
  'phone',
  'email',
  'preferredLanguage',
  'unitPreferences',
]);

export const updateDriverProfile = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      profile?: Record<string, unknown>;
      driverHash?: string;
    };
    if (!data.profile || typeof data.profile !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'profile required');
    }
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data.profile)) {
      if (PROFILE_ALLOWED.has(k)) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) {
      throw new httpsV2.HttpsError('invalid-argument', 'no allowed profile fields');
    }
    cleaned.updatedAt = Date.now();

    // Secure profile path
    await admin.database().ref(`drivers/profiles/${driver.driverId}/profile`).update(cleaned);

    // Dual-run: mirror to legacy approved if still active and hash provided
    if (data.driverHash) {
      const hash = data.driverHash.trim().toLowerCase();
      await admin
        .database()
        .ref(`drivers/approved/${hash}/profile`)
        .update(cleaned)
        .catch(() => undefined);
    }

    await writeSecurityAudit({
      action: 'updateDriverProfile',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { fields: Object.keys(cleaned) },
    });
    return { ok: true };
  },
);

/** Logout signal — only self */
export const signalDriverLogout = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { driverHash?: string; logoutAt?: number };
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });
    const logoutAt = typeof data.logoutAt === 'number' ? data.logoutAt : Date.now();
    await admin.database().ref(`drivers/profiles/${driver.driverId}`).update({ logoutAt });
    if (data.driverHash) {
      await admin
        .database()
        .ref(`drivers/approved/${data.driverHash.trim().toLowerCase()}`)
        .update({ logoutAt })
        .catch(() => undefined);
    }
    return { ok: true, logoutAt };
  },
);
