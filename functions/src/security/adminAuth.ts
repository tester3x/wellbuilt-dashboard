import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  staffHasCapability,
  type AdminAuthority,
} from './canonicalAdminAuthority';

export interface DashboardCaller {
  uid: string;
  roles: string[];
  companyId?: string;
  caps: string[];
  isPlatformAdmin: boolean;
}

/**
 * Canonical-only manageDrivers gate.
 *
 * Platform admin: wellbuiltAdmin claim AND enabled platform_admins/{uid}.
 * Company staff: enabled staff/{uid} with exact companyId.
 * RTDB users/{uid} is NOT staff authority.
 */
export async function requireManageDrivers(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<DashboardCaller> {
  const authority = await requireAdminAuthority(authUid, authToken);
  if (!staffHasCapability(authority, 'manageDrivers')) {
    throw new httpsV2.HttpsError('permission-denied', 'missing_manageDrivers');
  }
  return {
    uid: authority.uid,
    roles: authority.role ? [authority.role] : [],
    companyId: authority.companyId || undefined,
    caps: authority.caps,
    isPlatformAdmin: authority.class === 'platform',
  };
}

export async function resolveCanonicalAuthority(
  authUid: string,
  authToken?: Record<string, unknown> | null,
): Promise<AdminAuthority> {
  const [platSnap, staffSnap] = await Promise.all([
    admin.firestore().collection('platform_admins').doc(authUid).get(),
    admin.firestore().collection('staff').doc(authUid).get(),
  ]);
  const staff = staffSnap.exists
    ? (staffSnap.data() as { enabled?: unknown; companyId?: unknown; role?: unknown; capabilities?: unknown })
    : null;
  const companyId = typeof staff?.companyId === 'string' ? staff.companyId.trim() : '';
  let companyExists: boolean | undefined;
  let roleCapabilities: unknown;
  let policyReadError: string | null = null;
  if (companyId) {
    try {
      const companySnap = await admin.firestore().collection('companies').doc(companyId).get();
      companyExists = companySnap.exists;
      if (companySnap.exists) {
        roleCapabilities = companySnap.get('roleCapabilities');
      }
    } catch (err) {
      policyReadError = `policy_read_failed:${(err as Error)?.name || 'error'}`;
    }
  }
  const { decideCanonicalAuthorityFromReads } = await import('./canonicalAdminAuthority');
  return decideCanonicalAuthorityFromReads({
    authUid,
    authToken,
    platformAdmin: platSnap.exists
      ? (platSnap.data() as { enabled?: unknown; policyVersion?: unknown })
      : null,
    staff,
    companyExists,
    roleCapabilities,
    policyReadError,
  });
}

export async function requireAdminAuthority(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<Extract<AdminAuthority, { ok: true }>> {
  if (!authUid) {
    throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
  }
  const authority = await resolveCanonicalAuthority(authUid, authToken);
  if (!authority.ok) {
    const code = authority.reason.startsWith('policy_') ? 'failed-precondition' : 'permission-denied';
    throw new httpsV2.HttpsError(code, authority.reason);
  }
  return authority;
}

export async function requirePlatformAdmin(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<Extract<AdminAuthority, { ok: true }>> {
  const authority = await requireAdminAuthority(authUid, authToken);
  if (authority.class !== 'platform') {
    throw new httpsV2.HttpsError('permission-denied', 'platform_admin_required');
  }
  return authority;
}
