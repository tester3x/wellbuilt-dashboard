import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const DEFAULT_ROLE_CAPABILITIES: Record<string, string[]> = {
  it: ['manageDrivers', 'viewAllCompanies', 'manageEquipment'],
  admin: ['manageDrivers', 'manageEquipment'],
  manager: ['manageDrivers'],
  dispatch: [],
  payroll: [],
  viewer: [],
  driver: [],
};

function resolveRoles(userData: Record<string, unknown>): string[] {
  if (Array.isArray(userData.roles) && userData.roles.length > 0) {
    return userData.roles.filter((r): r is string => typeof r === 'string');
  }
  return typeof userData.role === 'string' ? [userData.role] : [];
}

function resolveCaps(roles: string[], overrides: Record<string, string[]>): string[] {
  const caps = new Set<string>();
  for (const role of roles) {
    const list = overrides[role] ?? DEFAULT_ROLE_CAPABILITIES[role] ?? [];
    list.forEach((c) => caps.add(c));
  }
  return [...caps];
}

export interface DashboardCaller {
  uid: string;
  roles: string[];
  companyId?: string;
  caps: string[];
  isPlatformAdmin: boolean;
}

async function loadDashboardCaller(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<DashboardCaller> {
  if (!authUid) {
    throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Prefer RTDB profile (source of truth for Dashboard)
  const snap = await admin.database().ref(`users/${authUid}`).once('value');
  if (snap.exists()) {
    const userData = snap.val() as Record<string, unknown>;
    const roles = resolveRoles(userData);
    const companyId = typeof userData.companyId === 'string' ? userData.companyId : undefined;

    let overrides: Record<string, string[]> = {};
    if (companyId) {
      try {
        const cSnap = await admin.firestore().collection('companies').doc(companyId).get();
        overrides = (cSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
      } catch {
        /* best-effort */
      }
    }
    const caps = resolveCaps(roles, overrides);
    const isPlatformAdmin = !companyId && roles.some((r) => r === 'admin' || r === 'it');
    return { uid: authUid, roles, companyId, caps, isPlatformAdmin };
  }

  // Fallback: Auth custom claims (emulator + optional claim-based admin)
  if (authToken && typeof authToken === 'object') {
    const claimRoles: string[] = [];
    if (typeof authToken.role === 'string') claimRoles.push(authToken.role);
    if (Array.isArray(authToken.roles)) {
      for (const r of authToken.roles) {
        if (typeof r === 'string') claimRoles.push(r);
      }
    }
    const claimCaps = resolveCaps(claimRoles, {});
    const companyId =
      typeof authToken.companyId === 'string' ? authToken.companyId : undefined;
    const isPlatformAdmin = !companyId && claimRoles.some((r) => r === 'admin' || r === 'it');
    return {
      uid: authUid,
      roles: claimRoles.length ? claimRoles : ['viewer'],
      companyId,
      caps: claimCaps,
      isPlatformAdmin,
    };
  }

  throw new httpsV2.HttpsError('permission-denied', 'Caller is not a registered dashboard user');
}

/**
 * Any registered Dashboard user (RTDB users/{uid} or claims). Used for the
 * global well-pool read path — not employee PII.
 */
export async function requireRegisteredDashboardUser(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<DashboardCaller> {
  return loadDashboardCaller(authUid, authToken);
}

/**
 * Require signed-in dashboard user with manageDrivers.
 * Sources (in order):
 * 1. RTDB users/{uid} role + company roleCapabilities (production path)
 * 2. Auth custom claims { role/roles, manageDrivers: true } — used by
 *    emulator tests and optional future claim backfill; never sufficient
 *    alone without manageDrivers claim or admin/it role in claims.
 */
export async function requireManageDrivers(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<DashboardCaller> {
  const caller = await loadDashboardCaller(authUid, authToken);
  if (caller.caps.includes('manageDrivers')) return caller;
  if (authToken && (authToken.manageDrivers === true || authToken.manageDrivers === 'true')) {
    return { ...caller, caps: [...caller.caps, 'manageDrivers'] };
  }
  throw new httpsV2.HttpsError('permission-denied', 'Caller lacks manageDrivers capability');
}
