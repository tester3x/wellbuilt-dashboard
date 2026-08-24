/**
 * Neutral canonical driver liveness + company authority.
 *
 * Single definition shared by:
 *   - SSO issuance/exchange (via SsoDeps.getDriver adapter)
 *   - verifyDriverSession cold-start revalidation
 *
 * Does NOT touch passcode, hash, display-name MEMBERSHIP (i.e. it never
 * resolves an identity from a name), shift state, tokens, or claims. Pure
 * read of credentials + profile records.
 *
 * It does surface the profile's own displayName, because that record is the
 * authoritative source of it and the SSO exchange has to return it to WB-T.
 * That is a read of an attribute belonging to an ALREADY-resolved driver,
 * never an input to resolving one — the direction that matters.
 */
import * as admin from 'firebase-admin';
import { normalizeSsoDisplayName } from '@tester3x/wellbuilt-contracts';

/** Authoritative secure-driver status as the server sees it. */
export type CanonicalDriverAuthority = {
  driverId: string;
  /** Nonempty company id from the profile when authority is present. */
  companyId: string;
  /**
   * The profile's own display name, or null when it is absent or unusable.
   *
   * Nullable rather than required: a missing name must not make a live driver
   * look dead. Liveness is decided by `active` alone, exactly as before.
   */
  displayName: string | null;
  credentialsActive: boolean;
  profileActive: boolean;
  /**
   * Overall liveness: credentials and profile both active.
   * Matches the dual-check authenticateDriver already performs at login.
   */
  active: boolean;
  credentialGeneration: number;
};

/** Injectable record readers so unit tests never touch Admin SDK. */
export type CanonicalDriverRecordReaders = {
  getCredentials(driverId: string): Promise<{ exists: boolean; active: boolean; credentialGeneration?: number }>;
  getProfile(driverId: string): Promise<{
    exists: boolean;
    active: boolean;
    companyId: string | null;
    displayName?: string | null;
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
    // Normalized through the canonical protocol helper so the server can
    // never hold a name in a shape it would refuse to send.
    displayName: normalizeSsoDisplayName(profile.displayName),
    credentialsActive,
    profileActive,
    active: credentialsActive && profileActive,
    credentialGeneration: Number.isFinite(cred.credentialGeneration) ? Math.max(0, Math.floor(cred.credentialGeneration!)) : 0,
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
      return { exists: true, active: snap.data()?.active !== false,
        credentialGeneration: Number(snap.data()?.credentialGeneration || 0) };
    },
    async getProfile(driverId) {
      const snap = await rtdb().ref(`drivers/profiles/${driverId}`).once('value');
      if (!snap.exists()) {
        return { exists: false, active: false, companyId: null };
      }
      const val = (snap.val() || {}) as {
        active?: boolean;
        companyId?: unknown;
        displayName?: unknown;
      };
      const companyId =
        typeof val.companyId === 'string' && val.companyId.trim().length > 0
          ? val.companyId.trim()
          : null;
      return {
        exists: true,
        active: val.active !== false,
        companyId,
        // Raw here; loadCanonicalDriverAuthority normalizes. Only the
        // profile's own displayName is read — no other profile field, and
        // never the legacy approved namespace.
        displayName: typeof val.displayName === 'string' ? val.displayName : null,
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
): Promise<{
  driverId: string;
  companyId: string | null;
  active: boolean;
  displayName: string | null;
} | null> {
  const auth = await loadCanonicalDriverAuthority(driverId, readers);
  if (!auth) return null;
  return {
    driverId: auth.driverId,
    companyId: auth.companyId,
    active: auth.active,
    displayName: auth.displayName,
  };
}
