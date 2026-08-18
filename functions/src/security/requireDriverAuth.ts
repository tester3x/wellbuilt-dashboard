/**
 * Resolve authenticated driver from Firebase Auth custom claims.
 * Legacy driverHash is never authority. Callers must not pass hash options.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { driverAuthUid } from './tokenMint';

export interface SecureDriver {
  uid: string;
  driverId: string;
  companyId: string;
  roles: string[];
  displayName?: string;
  isAdmin?: boolean;
  isViewer?: boolean;
  assignedRoutes?: string[];
  assignedWells?: string[];
  authSource: 'claims';
}

export function evaluateDriverAuthority(input: {
  uid: string | null | undefined;
  claims: Record<string, unknown> | null | undefined;
  data: unknown;
  profile: Record<string, unknown> | null;
  resolveAuthUid?: (driverId: string) => string;
}):
  | { ok: true; value: Omit<SecureDriver, 'uid'> & { uid: string } }
  | { ok: false; code: 'unauthenticated' | 'permission-denied'; message: string } {
  const resolveUid = input.resolveAuthUid ?? driverAuthUid;
  if (input.data && typeof input.data === 'object' && !Array.isArray(input.data)) {
    const rec = input.data as Record<string, unknown>;
    if (rec.driverHash != null || rec.legacyDriverHash != null || rec.allowLegacyHash === true) {
      return { ok: false, code: 'permission-denied', message: 'legacy_hash_rejected' };
    }
  }
  if (!input.uid || !input.claims || input.claims.kind !== 'driver') {
    return { ok: false, code: 'unauthenticated', message: 'unauthenticated' };
  }
  const driverId = typeof input.claims.driverId === 'string' ? input.claims.driverId.trim() : '';
  if (!driverId) return { ok: false, code: 'permission-denied', message: 'not_authorized' };
  if (input.uid !== resolveUid(driverId)) {
    return { ok: false, code: 'permission-denied', message: 'uid_binding_mismatch' };
  }
  if (!input.profile) return { ok: false, code: 'permission-denied', message: 'profile_missing' };
  if (input.profile.active !== true) {
    return { ok: false, code: 'permission-denied', message: 'profile_inactive' };
  }
  const claimCompany =
    typeof input.claims.companyId === 'string' ? input.claims.companyId.trim() : '';
  const profileCompany =
    typeof input.profile.companyId === 'string' ? input.profile.companyId.trim() : '';
  if (!claimCompany || !profileCompany || claimCompany !== profileCompany) {
    return { ok: false, code: 'permission-denied', message: 'company_mismatch' };
  }
  const claimRoles = Array.isArray(input.claims.roles) ? (input.claims.roles as string[]) : [];
  const profileRoles = Array.isArray(input.profile.roles) ? (input.profile.roles as string[]) : [];
  const roles = profileRoles.length ? profileRoles : claimRoles.length ? claimRoles : ['driver'];
  return {
    ok: true,
    value: {
      uid: input.uid,
      driverId,
      companyId: profileCompany,
      roles,
      displayName: typeof input.profile.displayName === 'string' ? input.profile.displayName : undefined,
      isAdmin: input.profile.isAdmin === true,
      isViewer: input.profile.isViewer === true,
      assignedRoutes: Array.isArray(input.profile.assignedRoutes)
        ? (input.profile.assignedRoutes as string[])
        : undefined,
      assignedWells: Array.isArray(input.profile.assignedWells)
        ? (input.profile.assignedWells as string[])
        : undefined,
      authSource: 'claims',
    },
  };
}

export async function requireSecureDriver(
  request: CallableRequest<unknown>,
  opts?: { requireCompany?: boolean },
): Promise<SecureDriver> {
  void opts;
  const claimDriverId =
    typeof request.auth?.token?.driverId === 'string' ? String(request.auth.token.driverId) : '';
  const prof = claimDriverId
    ? await admin.database().ref(`drivers/profiles/${claimDriverId}`).once('value')
    : null;
  const decided = evaluateDriverAuthority({
    uid: request.auth?.uid,
    claims: (request.auth?.token || {}) as unknown as Record<string, unknown>,
    data: request.data,
    profile: prof && prof.exists() ? (prof.val() as Record<string, unknown>) : null,
  });
  if (!decided.ok) {
    throw new httpsV2.HttpsError(decided.code, decided.message);
  }
  return decided.value;
}

export function assertSameCompany(
  driverCompanyId: string | undefined,
  resourceCompanyId: string | undefined,
): void {
  if (!driverCompanyId || !resourceCompanyId || driverCompanyId !== resourceCompanyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Cross-company access denied');
  }
}

export function assertDriverOwns(driverId: string, resourceDriverId: string | undefined): void {
  if (!resourceDriverId || resourceDriverId !== driverId) {
    throw new httpsV2.HttpsError('permission-denied', 'Not resource owner');
  }
}

export function isManagerCapability(driver: { roles: string[]; isAdmin?: boolean }): boolean {
  if (driver.isAdmin === true) return true;
  return driver.roles.some((r) => r === 'manager' || r === 'admin' || r === 'it');
}
