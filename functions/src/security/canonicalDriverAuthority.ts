/**
 * Neutral canonical driver liveness + company authority.
 *
 * Single definition shared by:
 *   - SSO issuance/exchange (via SsoDeps.getDriver adapter)
 *   - verifyDriverSession cold-start revalidation
 *
 * Does NOT touch passcode, hash, display-name membership, shift state,
 * tokens, or claims. Pure read of credentials + profile records.
 */
import * as admin from 'firebase-admin';

/** Authoritative secure-driver status as the server sees it. */
export type CanonicalDriverAuthority = {
  driverId: string;
  /** Nonempty company id from the profile when authority is present. */
  companyId: string;
  credentialsActive: boolean;
  profileActive: boolean;
  /**
   * Overall liveness: credentials and profile both active.
   * Matches the dual-check authenticateDriver already performs at login.
   */
  active: boolean;
};

/** Injectable record readers so unit tests never touch Admin SDK. */
export type CanonicalDriverRecordReaders = {
  getCredentials(driverId: string): Promise<{ exists: boolean; active: boolean }>;
  getProfile(driverId: string): Promise<{
    exists: boolean;
    active: boolean;
    companyId: string | null;
  }>;
};

/**
 * Load canonical driver authority for a known driverId.
 *
 * Returns null when the driver cannot be treated as a current secure
 * principal: missing credentials, missing profile, or missing/empty
 * company on the profile. Callers map null → coarse permission-denied.
 */
export async function loadCanonicalDriverAuthority(
  driverId: string,
  readers: CanonicalDriverRecordReaders,
): Promise<CanonicalDriverAuthority | null> {
  if (!driverId || typeof driverId !== 'string') return null;

  const [cred, profile] = await Promise.all([
    readers.getCredentials(driverId),
    readers.getProfile(driverId),
  ]);

  if (!cred.exists) return null;
  if (!profile.exists) return null;
  if (!profile.companyId) return null;

  const credentialsActive = cred.active;
  const profileActive = profile.active;
  return {
    driverId,
    companyId: profile.companyId,
    credentialsActive,
    profileActive,
    active: credentialsActive && profileActive,
  };
}

/** Production readers over Firestore credentials + RTDB profiles. */
export function productionCanonicalDriverReaders(): CanonicalDriverRecordReaders {
  const db = () => admin.firestore();
  const rtdb = () => admin.database();
  return {
    async getCredentials(driverId) {
      const snap = await db().collection('driver_credentials').doc(driverId).get();
      if (!snap.exists) return { exists: false, active: false };
      return { exists: true, active: snap.data()?.active !== false };
    },
    async getProfile(driverId) {
      const snap = await rtdb().ref(`drivers/profiles/${driverId}`).once('value');
      if (!snap.exists()) {
        return { exists: false, active: false, companyId: null };
      }
      const val = (snap.val() || {}) as {
        active?: boolean;
        companyId?: unknown;
      };
      const companyId =
        typeof val.companyId === 'string' && val.companyId.trim().length > 0
          ? val.companyId.trim()
          : null;
      return {
        exists: true,
        active: val.active !== false,
        companyId,
      };
    },
  };
}

/**
 * SSO-facing adapter: same shape as historical SsoDeps.getDriver.
 *
 * active reflects BOTH credentials and profile liveness. companyId is
 * always a nonempty string when a record is returned (null authority → null).
 */
export async function getAuthoritativeDriverForSso(
  driverId: string,
  readers: CanonicalDriverRecordReaders = productionCanonicalDriverReaders(),
): Promise<{ driverId: string; companyId: string | null; active: boolean } | null> {
  const auth = await loadCanonicalDriverAuthority(driverId, readers);
  if (!auth) return null;
  return {
    driverId: auth.driverId,
    companyId: auth.companyId,
    active: auth.active,
  };
}
