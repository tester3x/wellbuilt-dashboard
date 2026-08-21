/**
 * Authenticated driver session bootstrap / profile.
 *
 * Used after SSO (and available after manual login) so WB-M can persist
 * authoritative roles, isAdmin, isViewer, company, tier, routes, and
 * customers. Identity comes only from request.auth.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { driverAuthUid } from './tokenMint';
import { assignmentFieldForClient } from './operational/canonicalAssignment';

export const BOOTSTRAP_DRIVER_SESSION_OPTIONS = {
  timeoutSeconds: 15,
  memory: '256MiB' as const,
  enforceAppCheck: false,
};

export type DriverSessionProfile = {
  driverId: string;
  companyId: string;
  displayName: string | null;
  legalName: string | null;
  companyName: string | null;
  isAdmin: boolean;
  isViewer: boolean;
  roles: string[];
  tier: string | null;
  assignedRoutes: unknown;
  assignedWells: unknown;
  assignedCustomers: unknown;
  dashboardUid: string | null;
  dashboardRole: string | null;
  defaultPackageId: string | null;
  active: true;
};

export async function evaluateBootstrapDriverSession(input: {
  uid: string | null | undefined;
  claims: Record<string, unknown> | null | undefined;
  data: unknown;
  loadProfile: (driverId: string) => Promise<Record<string, unknown> | null>;
  resolveAuthUid?: (driverId: string) => string;
}): Promise<{ ok: true; value: DriverSessionProfile } | { ok: false; code: 'unauthenticated' | 'permission-denied' | 'invalid-argument'; message: string }> {
  const resolveUid = input.resolveAuthUid ?? driverAuthUid;
  if (input.data != null) {
    if (typeof input.data !== 'object' || Array.isArray(input.data) || Object.keys(input.data as object).length > 0) {
      return { ok: false, code: 'invalid-argument', message: 'invalid_request' };
    }
  }
  if (!input.uid) return { ok: false, code: 'unauthenticated', message: 'unauthenticated' };
  const claims = input.claims || {};
  if (claims.kind !== 'driver') return { ok: false, code: 'permission-denied', message: 'not_authorized' };
  const driverId = typeof claims.driverId === 'string' ? claims.driverId.trim() : '';
  const companyId = typeof claims.companyId === 'string' ? claims.companyId.trim() : '';
  if (!driverId || !companyId) return { ok: false, code: 'permission-denied', message: 'not_authorized' };
  if (input.uid !== resolveUid(driverId)) return { ok: false, code: 'permission-denied', message: 'not_authorized' };

  const profile = await input.loadProfile(driverId);
  if (!profile || profile.active === false) {
    return { ok: false, code: 'permission-denied', message: 'not_authorized' };
  }
  const profileCompany = typeof profile.companyId === 'string' ? profile.companyId : '';
  if (profileCompany !== companyId) {
    return { ok: false, code: 'permission-denied', message: 'not_authorized' };
  }
  const claimRoles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  const profileRoles = Array.isArray(profile.roles) ? (profile.roles as string[]) : [];
  const roles = profileRoles.length ? profileRoles : claimRoles.length ? claimRoles : ['driver'];
  return {
    ok: true,
    value: {
      driverId,
      companyId,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : null,
      legalName: typeof profile.legalName === 'string' ? profile.legalName : null,
      companyName: typeof profile.companyName === 'string' ? profile.companyName : null,
      isAdmin: profile.isAdmin === true,
      isViewer: profile.isViewer === true,
      roles,
      tier: typeof profile.tier === 'string' ? profile.tier : null,
      assignedRoutes: assignmentFieldForClient(profile.assignedRoutes),
      assignedWells: assignmentFieldForClient(profile.assignedWells),
      assignedCustomers: profile.assignedCustomers ?? null,
      dashboardUid: typeof profile.dashboardUid === 'string' ? profile.dashboardUid : null,
      dashboardRole: typeof profile.dashboardRole === 'string' ? profile.dashboardRole : null,
      defaultPackageId: typeof profile.defaultPackageId === 'string' ? profile.defaultPackageId : null,
      active: true,
    },
  };
}

export const bootstrapDriverSession = httpsV2.onCall(
  BOOTSTRAP_DRIVER_SESSION_OPTIONS,
  async (request) => {
    const result = await evaluateBootstrapDriverSession({
      uid: request.auth?.uid,
      claims: (request.auth?.token || {}) as unknown as Record<string, unknown>,
      data: request.data,
      loadProfile: async (driverId) => {
        const snap = await admin.database().ref(`drivers/profiles/${driverId}`).once('value');
        return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
      },
    });
    if (!result.ok) throw new httpsV2.HttpsError(result.code, result.message);
    return result.value;
  },
);
