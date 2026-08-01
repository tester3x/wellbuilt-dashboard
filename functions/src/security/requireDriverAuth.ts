/**
 * Resolve authenticated driver from Firebase Auth custom claims (secure plane).
 * Dual-run: also accepts legacy driverHash validated against drivers/approved
 * when claim is absent (transitional) — disabled when REQUIRE_DRIVER_CLAIMS=true.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { CallableRequest } from 'firebase-functions/v2/https';

export interface SecureDriver {
  uid: string;
  driverId: string;
  companyId?: string;
  roles: string[];
  displayName?: string;
  authSource: 'claims' | 'legacy_hash';
}

const REQUIRE_CLAIMS = process.env.REQUIRE_DRIVER_CLAIMS === 'true';

export async function requireSecureDriver(
  request: CallableRequest<unknown>,
  opts?: { allowLegacyHash?: boolean; legacyDriverHash?: string },
): Promise<SecureDriver> {
  const auth = request.auth;
  if (auth?.uid && auth.token?.kind === 'driver' && auth.token?.driverId) {
    const driverId = String(auth.token.driverId);
    const companyId =
      typeof auth.token.companyId === 'string' ? auth.token.companyId : undefined;
    const roles = Array.isArray(auth.token.roles)
      ? (auth.token.roles as string[])
      : ['driver'];

    // Verify profile still active
    const prof = await admin.database().ref(`drivers/profiles/${driverId}`).once('value');
    if (prof.exists() && prof.val()?.active === false) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver deactivated');
    }
    // Dual-run: also check legacy migrated profiles linked by claim only
    return {
      uid: auth.uid,
      driverId,
      companyId: companyId || prof.val()?.companyId || undefined,
      roles,
      displayName: prof.val()?.displayName,
      authSource: 'claims',
    };
  }

  // Transitional legacy: validate driverHash against approved (only if allowed)
  const allowLegacy = opts?.allowLegacyHash !== false && !REQUIRE_CLAIMS;
  const hash = (opts?.legacyDriverHash || '').trim().toLowerCase();
  if (allowLegacy && hash) {
    const snap = await admin.database().ref(`drivers/approved/${hash}`).once('value');
    if (!snap.exists()) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver not found');
    }
    const data = snap.val();
    if (data.active === false) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver deactivated');
    }
    // Prefer secure profile if migrated
    const migratedId = data.migratedToDriverId as string | undefined;
    return {
      uid: auth?.uid || `legacy_${hash.slice(0, 12)}`,
      driverId: migratedId || hash,
      companyId: data.companyId || undefined,
      roles: Array.isArray(data.roles) ? data.roles : ['driver'],
      displayName: data.displayName,
      authSource: 'legacy_hash',
    };
  }

  throw new httpsV2.HttpsError(
    'unauthenticated',
    'Driver authentication required (custom token claims or transitional hash)',
  );
}

export function assertSameCompany(
  driverCompanyId: string | undefined,
  resourceCompanyId: string | undefined,
): void {
  if (!resourceCompanyId) return; // unscoped resource
  if (!driverCompanyId || driverCompanyId !== resourceCompanyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Cross-company access denied');
  }
}

export function assertDriverOwns(
  driverId: string,
  resourceDriverId: string | undefined,
): void {
  if (!resourceDriverId || resourceDriverId !== driverId) {
    throw new httpsV2.HttpsError('permission-denied', 'Not resource owner');
  }
}
