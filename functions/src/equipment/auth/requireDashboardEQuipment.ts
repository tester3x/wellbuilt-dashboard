import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { ActorRef, DashboardProfile } from '../types/actor';

const db = admin.database();

export const EQUIPMENT_TAB_CAPABILITIES = [
  'viewEQuipment',
  'manageEquipment',
  'manageEquipmentAssignments',
  'viewDVIR',
  'manageDVIR',
  'viewEquipmentDocuments',
  'manageEquipmentDocuments',
] as const;

const DEFAULT_ROLE_CAPABILITIES: Record<string, string[]> = {
  it: [...EQUIPMENT_TAB_CAPABILITIES, 'viewAllCompanies'],
  admin: [...EQUIPMENT_TAB_CAPABILITIES],
  manager: [
    'viewEQuipment', 'manageEquipmentAssignments', 'viewDVIR', 'viewEquipmentDocuments',
  ],
  dispatch: ['viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments'],
  payroll: ['viewEQuipment', 'viewEquipmentDocuments'],
  viewer: ['viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments'],
  driver: [],
};

function resolveRoles(userData: Record<string, unknown>): string[] {
  if (Array.isArray(userData.roles) && userData.roles.length > 0) {
    return userData.roles.filter((r): r is string => typeof r === 'string');
  }
  return typeof userData.role === 'string' ? [userData.role] : [];
}

function hasAnyCapability(
  roles: string[],
  required: string[],
  overrides: Record<string, string[]>,
): boolean {
  return roles.some((role) => {
    const caps = overrides[role] ?? DEFAULT_ROLE_CAPABILITIES[role] ?? [];
    return required.some((cap) => caps.includes(cap));
  });
}

async function loadDashboardProfile(
  authUid: string,
  targetCompanyId: string,
  requiredCapabilities: string[],
): Promise<DashboardProfile> {
  if (!authUid) {
    throw new httpsV2.HttpsError('unauthenticated', 'Sign in required');
  }
  if (!targetCompanyId) {
    throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
  }

  const snap = await db.ref(`users/${authUid}`).once('value');
  if (!snap.exists()) {
    throw new httpsV2.HttpsError('permission-denied', 'User record not found');
  }

  const userData = snap.val() as Record<string, unknown>;
  const roles = resolveRoles(userData);
  if (roles.length === 0) {
    throw new httpsV2.HttpsError('permission-denied', 'No role assigned');
  }

  let overrides: Record<string, string[]> = {};
  const userCompanyId = typeof userData.companyId === 'string' ? userData.companyId : undefined;
  if (userCompanyId) {
    try {
      const compSnap = await admin.firestore().collection('companies').doc(userCompanyId).get();
      overrides = (compSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
    } catch {
      // best-effort
    }
  }

  if (!hasAnyCapability(roles, requiredCapabilities, overrides)) {
    throw new httpsV2.HttpsError(
      'permission-denied',
      `Required capability: ${requiredCapabilities.join(' or ')}`,
    );
  }

  const isPlatformAdmin = !userCompanyId && roles.some((r) => r === 'admin' || r === 'it');
  if (!isPlatformAdmin && userCompanyId !== targetCompanyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Cannot access another company');
  }

  return {
    uid: authUid,
    displayName: typeof userData.displayName === 'string'
      ? userData.displayName
      : (typeof userData.email === 'string' ? userData.email : 'Dashboard User'),
    companyId: userCompanyId,
    roles,
    isPlatformAdmin,
  };
}

export function dashboardActorRef(profile: DashboardProfile): ActorRef {
  return {
    type: 'dashboard',
    uid: profile.uid,
    displayName: profile.displayName,
  };
}

export async function requireDashboardEquipmentRead(
  authUid: string | undefined,
  targetCompanyId: string,
): Promise<DashboardProfile> {
  return loadDashboardProfile(authUid || '', targetCompanyId, ['viewEQuipment', 'manageEquipment']);
}

export async function requireDashboardEquipmentWrite(
  authUid: string | undefined,
  targetCompanyId: string,
): Promise<DashboardProfile> {
  return loadDashboardProfile(authUid || '', targetCompanyId, ['manageEquipment']);
}

export async function requireDashboardAssignmentRead(
  authUid: string | undefined,
  targetCompanyId: string,
): Promise<DashboardProfile> {
  return loadDashboardProfile(
    authUid || '',
    targetCompanyId,
    ['viewEQuipment', 'manageEquipmentAssignments'],
  );
}

export async function requireDashboardDvirRead(
  authUid: string | undefined,
  targetCompanyId: string,
): Promise<DashboardProfile> {
  return loadDashboardProfile(authUid || '', targetCompanyId, ['viewEQuipment', 'viewDVIR', 'manageDVIR']);
}

export async function requireDashboardDocumentRead(
  authUid: string | undefined,
  targetCompanyId: string,
): Promise<DashboardProfile> {
  return loadDashboardProfile(
    authUid || '',
    targetCompanyId,
    ['viewEQuipment', 'viewEquipmentDocuments', 'manageEquipmentDocuments'],
  );
}