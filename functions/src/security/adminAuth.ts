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

/** Require signed-in dashboard user with manageDrivers. */
export async function requireManageDrivers(
  authUid: string | undefined,
): Promise<DashboardCaller> {
  if (!authUid) {
    throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
  }
  const snap = await admin.database().ref(`users/${authUid}`).once('value');
  if (!snap.exists()) {
    throw new httpsV2.HttpsError('permission-denied', 'Caller is not a registered dashboard user');
  }
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
  if (!caps.includes('manageDrivers')) {
    throw new httpsV2.HttpsError('permission-denied', 'Caller lacks manageDrivers capability');
  }
  const isPlatformAdmin = !companyId && roles.some((r) => r === 'admin' || r === 'it');
  return { uid: authUid, roles, companyId, caps, isPlatformAdmin };
}
